# run-migration-055.ps1 — apply ONLY 055_job_conversations_application_index.sql.
# Scoped single-migration operator procedure, modeled on run-migration-034.ps1.
#
# !! DO NOT use scripts/run-migrations.ps1 against production. That script has
# !! NO migration ledger: it replays its whole hard-coded 028-onward list every
# !! run, and migrations 034 and 037 contain bare CREATE TABLE statements
# !! (organizations, billing_plans, email_outbox) with no IF NOT EXISTS, so a
# !! replay against a database that already has them ABORTS at 034 under
# !! ON_ERROR_STOP=1. It also unconditionally ALTERs four role passwords and
# !! mints a brand-new random jale_whatsapp password, which breaks warm Lambda
# !! containers (lambda/lib/db.ts caches the Pool with the password baked in,
# !! and clearSecretCache has no production callers).
# !!
# !! scripts/run-migrations.sh is DIFFERENT and safe: it keeps a real
# !! public.schema_migrations ledger, never replays an applied migration,
# !! refuses to run one that was edited after it was applied, and gates role
# !! rotation behind --rotate-secrets. Prefer it for full-chain work. The .ps1
# !! has NOT been brought up to that standard and is dangerously divergent.
# !!
# !! This script exists for the narrow case of applying 055 alone, ahead of the
# !! chain, so the employer inbox query is indexed from its first request. It
# !! applies 055 and nothing else, and touches no passwords.
#
# Migration 055 is genuinely idempotent -- it is a single
# CREATE INDEX IF NOT EXISTS -- so unlike 034 this script does NOT abort when
# the index is already present. It reports the fact and re-runs harmlessly.
# It also does NOT write to public.schema_migrations: run-migrations.sh remains
# the sole owner of that ledger, and will apply 055 as a clean no-op later.
#
# Usage:
#
#   1. Deploy the bastion:   `.\scripts\deploy-bastion.ps1`
#   2. Inspect first:        `.\scripts\run-migration-055.ps1 -VerifyOnly`
#   3. Apply the migration:  `.\scripts\run-migration-055.ps1`
#   4. Destroy the bastion:  `.\scripts\deploy-bastion.ps1 -Destroy`
#
# What -VerifyOnly does (safe to run anytime, never mutates the database):
#   - Connects to RDS via the bastion as jale_admin (read-only)
#   - Reports whether idx_job_conversations_application already exists
#   - Reports job_conversations row count and heap size, so the operator can
#     judge the ACCESS EXCLUSIVE lock window before committing to an apply
#   - Reports any in-flight transaction older than 60s on job_conversations,
#     since the index build must queue behind those AND everything that
#     arrives after it queues behind the build
#   - If the index is present, runs the full post-verification suite
#
# What the default (apply) run does:
#   - Resolves the bastion instance ID from CloudFormation
#   - Resolves the jale_admin DB secret ARN from CloudFormation
#   - Base64-encodes 055_job_conversations_application_index.sql
#   - `aws ssm send-command` runs a script ON THE BASTION that:
#       * Reports whether the index is already present (informational)
#       * Applies the migration as jale_admin in one transaction, under
#         PGOPTIONS='-c lock_timeout=15s' so that WAITING for the
#         ACCESS EXCLUSIVE lock cannot block employer sends, inbound WhatsApp
#         replies and the outbox sweeper indefinitely. On timeout the
#         transaction rolls back cleanly with no index and no partial state --
#         just retry in a quieter window.
#         NOTE: lock_timeout bounds the WAIT, not the HOLD. Once acquired, the
#         build holds the lock for one scan of job_conversations; that is why
#         -VerifyOnly reports the row count first.
#       * Runs the read-only post-verification suite and fails loudly
#         (non-zero exit) on any mismatch
#   - Polls command status, streams bastion stdout to operator
#   - Syncs NO passwords and creates/overwrites NO secrets. Migration 055
#     adds no roles and no grants, so there is nothing to sync.
#
# Operator-side requirements: aws CLI v2 (no jq, no bash, no psql needed
# locally). Bastion-side requirements: installed automatically via
# BastionStack UserData (postgresql15 + jq).
#
# No `psql` or DB passwords ever cross the operator's terminal.

[CmdletBinding()]
param(
    [string]$Region = $(
        if ($env:AWS_REGION) { $env:AWS_REGION }
        elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION }
        else { 'us-east-2' }
    ),
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'

# This script applies 055 ONLY -- never a chain. Do not add other files here.
$MigrationFiles = @(
    '055_job_conversations_application_index.sql'
)

$MigrationDir = (Resolve-Path (Join-Path $PSScriptRoot '..\infra\db\migrations')).Path

Write-Host ">> Using region: $Region"
if ($VerifyOnly) {
    Write-Host ">> Mode: -VerifyOnly (read-only inspection; no apply, no locks taken)"
} else {
    Write-Host ">> Mode: apply migration 055 (no password sync)"
}

# ---------------------------------------------------------------------------
# Resolve bastion instance ID from CloudFormation.
# ---------------------------------------------------------------------------
Write-Host ">> Resolving bastion instance ID..."
$bastionId = (aws cloudformation describe-stacks `
        --stack-name $BastionStack `
        --region $Region `
        --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" `
        --output text)
if ($bastionId) { $bastionId = $bastionId.Trim() }

if ([string]::IsNullOrEmpty($bastionId) -or $bastionId -eq 'None') {
    Write-Host "!! Could not find BastionInstanceId output on $BastionStack." -ForegroundColor Red
    Write-Host "   Deploy the stack first: cd infra; npx cdk deploy $BastionStack"
    exit 1
}
Write-Host "   bastion: $bastionId"

# ---------------------------------------------------------------------------
# Resolve jale_admin DB secret ARN (needed in both modes: apply + verify).
# ---------------------------------------------------------------------------
Write-Host ">> Resolving jale_admin DB secret ARN..."
$rawSecret = (aws cloudformation describe-stack-resources `
        --stack-name $DatabaseStack `
        --region $Region `
        --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]" `
        --output text)

$dbSecretArn = $rawSecret.Trim()

if ([string]::IsNullOrEmpty($dbSecretArn) -or $dbSecretArn -eq 'None') {
    Write-Host "!! Could not find jale_admin DB secret in $DatabaseStack." -ForegroundColor Red
    exit 1
}
Write-Host "   db-secret: $dbSecretArn"

# ---------------------------------------------------------------------------
# Verify migration file + base64-encode -- apply mode only.
# ---------------------------------------------------------------------------
$migrationB64 = ''
if (-not $VerifyOnly) {
    $migrationFile = $MigrationFiles[0]
    $migrationPath = Join-Path $MigrationDir $migrationFile
    if (-not (Test-Path $migrationPath)) {
        Write-Host "!! Migration file missing: $migrationPath" -ForegroundColor Red
        exit 1
    }
    $bytes = [System.IO.File]::ReadAllBytes($migrationPath)
    $migrationB64 = [Convert]::ToBase64String($bytes)
}

# ---------------------------------------------------------------------------
# Shared bash verification functions: read-only checks against the live
# schema, run as jale_admin over $PG_CMD. Used by both -VerifyOnly and the
# post-apply verification step. Never mutates anything.
# ---------------------------------------------------------------------------
$verificationFunctions = @'
run_verification() {
  echo ">> Running migration-055 read-only verification..."
  FAIL_COUNT=0

  check_true() {
    local desc="$1"
    local sql="$2"
    local result
    result=$("${PG_CMD[@]}" -tAc "$sql" 2>&1 | tr -d '[:space:]')
    if [ "$result" = "t" ]; then
      echo "   [PASS] $desc"
    else
      echo "   [FAIL] $desc (got: '$result')"
      FAIL_COUNT=$((FAIL_COUNT+1))
    fi
  }

  echo "   -- index identity --"
  check_true "index idx_job_conversations_application exists" \
    "SELECT to_regclass('public.idx_job_conversations_application') IS NOT NULL;"
  check_true "index is attached to public.job_conversations" \
    "SELECT indrelid = 'public.job_conversations'::regclass FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "index is a btree" \
    "SELECT am.amname = 'btree' FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = 'public.idx_job_conversations_application'::regclass;"

  echo "   -- index shape (single column, application_id, not unique/partial) --"
  check_true "indexes exactly one column" \
    "SELECT indnatts = 1 FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "that column is application_id" \
    "SELECT a.attname = 'application_id' FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "index is NOT unique (a unique index here would reject closed-thread history)" \
    "SELECT NOT indisunique FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "index is NOT partial" \
    "SELECT indpred IS NULL FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"

  echo "   -- index usability --"
  check_true "index is valid (usable by the planner)" \
    "SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "index is ready (not mid-build)" \
    "SELECT indisready FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"
  check_true "index is live (not awaiting cleanup)" \
    "SELECT indislive FROM pg_index WHERE indexrelid = 'public.idx_job_conversations_application'::regclass;"

  echo "   -- definition --"
  echo -n "   indexdef: "
  "${PG_CMD[@]}" -tAc "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_job_conversations_application';"
  echo -n "   index size: "
  "${PG_CMD[@]}" -tAc "SELECT pg_size_pretty(pg_relation_size('public.idx_job_conversations_application'));"

  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "!! Verification FAILED: $FAIL_COUNT check(s) did not pass."
    return 1
  fi
  echo ">> Verification PASSED: all checks green."
  return 0
}

report_lock_window() {
  echo ">> Sizing the ACCESS EXCLUSIVE lock window..."
  echo -n "   job_conversations live rows (estimate): "
  "${PG_CMD[@]}" -tAc "SELECT COALESCE(n_live_tup, -1) FROM pg_stat_user_tables WHERE relid = 'public.job_conversations'::regclass;"
  echo -n "   job_conversations heap size: "
  "${PG_CMD[@]}" -tAc "SELECT pg_size_pretty(pg_relation_size('public.job_conversations'));"
  echo -n "   job_conversations total size (incl. indexes): "
  "${PG_CMD[@]}" -tAc "SELECT pg_size_pretty(pg_total_relation_size('public.job_conversations'));"

  echo "   transactions older than 60s that could delay the lock:"
  "${PG_CMD[@]}" -tAc "SELECT COALESCE(string_agg(format('     pid=%s state=%s age=%s query=%s', pid, state, age(clock_timestamp(), xact_start), left(regexp_replace(query, '\s+', ' ', 'g'), 80)), E'\n'), '     (none)') FROM pg_stat_activity WHERE xact_start IS NOT NULL AND clock_timestamp() - xact_start > interval '60 seconds' AND pid <> pg_backend_pid();"
}
'@

# ---------------------------------------------------------------------------
# Build the remote bash script.
#
# @'...'@ is a verbatim here-string -- bash sigils like $VAR, $(...), ${VAR[@]}
# stay literal. Placeholders get substituted after via -replace (literal
# text, no regex metacharacters, except we defensively double any '$' in the
# replacement values since PowerShell -replace treats '$1'/'$&' as backrefs
# in the replacement string).
# ---------------------------------------------------------------------------
if ($VerifyOnly) {
    $remoteTemplate = @'
#!/bin/bash
set -euo pipefail

REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"

echo ">> Fetching jale_admin creds from $DB_SECRET_ARN"
DB_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
DB_HOST=$(echo "$DB_SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_SECRET_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_SECRET_JSON" | jq -r .username)
export PGPASSWORD=$(echo "$DB_SECRET_JSON" | jq -r .password)
PG_CMD=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

__VERIFICATION_FUNCTIONS__

echo ">> Sanity: confirming public.job_conversations exists..."
TABLE_PRESENT=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.job_conversations') IS NOT NULL;" | tr -d '[:space:]')
if [ "$TABLE_PRESENT" != "t" ]; then
  echo "!! public.job_conversations does not exist on this database." >&2
  echo "!! Migration 025 (job_messaging) has not been applied here. 055 cannot apply." >&2
  unset PGPASSWORD DB_SECRET_JSON
  exit 1
fi
echo "   job_conversations present."

report_lock_window

echo ">> VERIFY-ONLY: checking whether migration 055 is present (read-only, no changes)..."
PRESENT=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.idx_job_conversations_application') IS NOT NULL;" | tr -d '[:space:]')

if [ "$PRESENT" != "t" ]; then
  echo ">> Migration 055 is NOT present (idx_job_conversations_application not found)."
  echo ">> Safe to run the apply pass. Pick a low-traffic window: the build takes"
  echo ">> ACCESS EXCLUSIVE on job_conversations for one scan of the sizes above."
  unset PGPASSWORD DB_SECRET_JSON
  exit 0
fi

echo ">> Migration 055 IS present. Running full verification..."
VERIFY_STATUS=0
run_verification || VERIFY_STATUS=$?

unset PGPASSWORD DB_SECRET_JSON

if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "!! Verification reported failures. See [FAIL] lines above." >&2
  exit 1
fi

echo ">> Migration 055 is present and every check is green. Nothing to do."
'@
} else {
    $remoteTemplate = @'
#!/bin/bash
set -euo pipefail

REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"

echo ">> Fetching jale_admin creds from $DB_SECRET_ARN"
DB_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
DB_HOST=$(echo "$DB_SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_SECRET_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_SECRET_JSON" | jq -r .username)
export PGPASSWORD=$(echo "$DB_SECRET_JSON" | jq -r .password)
PG_CMD=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

__VERIFICATION_FUNCTIONS__

echo ">> Sanity: confirming public.job_conversations exists..."
TABLE_PRESENT=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.job_conversations') IS NOT NULL;" | tr -d '[:space:]')
if [ "$TABLE_PRESENT" != "t" ]; then
  echo "!! public.job_conversations does not exist on this database." >&2
  echo "!! Migration 025 (job_messaging) has not been applied here. Refusing to apply 055." >&2
  unset PGPASSWORD DB_SECRET_JSON
  exit 1
fi
echo "   job_conversations present."

echo ">> PRE-CHECK: is the index already there?"
PRECHECK=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.idx_job_conversations_application') IS NOT NULL;" | tr -d '[:space:]')
if [ "$PRECHECK" = "t" ]; then
  echo "   idx_job_conversations_application already exists."
  echo "   055 is CREATE INDEX IF NOT EXISTS, so re-applying is a no-op. Continuing to verification."
else
  echo "   index absent -- proceeding with apply."
  report_lock_window

  echo ">> Applying 055_job_conversations_application_index.sql (single transaction, lock_timeout=15s)..."
  echo ">> If this times out waiting for ACCESS EXCLUSIVE, it rolls back with NO changes."
  echo ">> That is the safe outcome -- just retry in a quieter window."
  TMP="/tmp/mig-055_job_conversations_application_index.sql"
  echo "__MIGRATION_B64__" | base64 -d > "$TMP"
  APPLY_STATUS=0
  PGOPTIONS='-c lock_timeout=15s' "${PG_CMD[@]}" -f "$TMP" || APPLY_STATUS=$?
  rm -f "$TMP"
  if [ "$APPLY_STATUS" -ne 0 ]; then
    echo "!! Apply failed (exit $APPLY_STATUS)." >&2
    echo "!! If the error above is 'canceling statement due to lock timeout', the" >&2
    echo "!! transaction rolled back and the database is unchanged. Retry later." >&2
    unset PGPASSWORD DB_SECRET_JSON
    exit 1
  fi
  echo ">> Migration 055 applied cleanly."
fi

VERIFY_STATUS=0
run_verification || VERIFY_STATUS=$?

unset PGPASSWORD DB_SECRET_JSON

if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "!! Post-verification reported failures. Investigate before declaring migration 055 complete." >&2
  exit 1
fi

echo ">> Done: migration 055 applied and verified. No passwords touched, no secrets written."
'@
}

$regionSafe = $Region -replace '\$', '$$$$'
$dbSecretArnSafe = $dbSecretArn -replace '\$', '$$$$'
$migrationB64Safe = $migrationB64 -replace '\$', '$$$$'
$verificationFunctionsSafe = $verificationFunctions -replace '\$', '$$$$'

$remoteScript = $remoteTemplate `
    -replace '__REGION__', $regionSafe `
    -replace '__DB_SECRET_ARN__', $dbSecretArnSafe `
    -replace '__MIGRATION_B64__', $migrationB64Safe `
    -replace '__VERIFICATION_FUNCTIONS__', $verificationFunctionsSafe
$remoteScript = $remoteScript -replace "`r`n", "`n"

# ---------------------------------------------------------------------------
# Write the SSM parameters JSON to a temp file with UTF-8 NO-BOM.
# PS 5.1's default Set-Content emits UTF-16 LE with BOM -- AWS CLI rejects
# that for --parameters file://. Use .NET File.WriteAllText with explicit
# encoding to get a clean file regardless of PS version.
# ---------------------------------------------------------------------------
$paramsJson = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 10 -Compress
$paramsFile = [System.IO.Path]::GetTempFileName()
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($paramsFile, $paramsJson, $utf8NoBom)

    # -----------------------------------------------------------------------
    # Send the command.
    # -----------------------------------------------------------------------
    $comment = if ($VerifyOnly) { 'Jale migration 055 verify-only inspection' } else { 'Jale migration 055 apply (job_conversations application_id index)' }
    Write-Host ">> Sending command to bastion via SSM..."
    $cmdId = (aws ssm send-command `
            --region $Region `
            --document-name 'AWS-RunShellScript' `
            --instance-ids $bastionId `
            --comment $comment `
            --parameters "file://$paramsFile" `
            --query 'Command.CommandId' `
            --output text)
    if ($cmdId) { $cmdId = $cmdId.Trim() }

    if ([string]::IsNullOrEmpty($cmdId)) {
        Write-Host "!! Failed to send SSM command." -ForegroundColor Red
        exit 1
    }
    Write-Host "   CommandId: $cmdId"
}
finally {
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Poll until the command finishes.
# ---------------------------------------------------------------------------
Write-Host ">> Waiting for command to complete..."
$terminalStates = @('Failed', 'Cancelled', 'TimedOut')
$done = $false

while (-not $done) {
    Start-Sleep -Seconds 5

    $status = aws ssm list-command-invocations `
        --region $Region `
        --command-id $cmdId `
        --details `
        --query 'CommandInvocations[0].Status' `
        --output text 2>$null
    if ($status) { $status = $status.Trim() }

    if ($status -eq 'Success') {
        Write-Host ">> Command succeeded."
        $done = $true
    }
    elseif ($terminalStates -contains $status) {
        Write-Host "!! Command ended with status: $status" -ForegroundColor Red
        aws ssm list-command-invocations `
            --region $Region `
            --command-id $cmdId `
            --details `
            --query 'CommandInvocations[0].CommandPlugins[0].{Status:Status,Out:Output}' `
            --output json
        exit 1
    }
    # else: Pending / InProgress / Delayed -- keep polling
}

# ---------------------------------------------------------------------------
# Stream the bastion stdout at the end.
# ---------------------------------------------------------------------------
Write-Host ">> Final bastion stdout:"
aws ssm list-command-invocations `
    --region $Region `
    --command-id $cmdId `
    --details `
    --query 'CommandInvocations[0].CommandPlugins[0].Output' `
    --output text

Write-Host ""
if ($VerifyOnly) {
    Write-Host ">> Verify-only run complete. No changes were made."
    Write-Host "   If migration 055 is absent and you intend to apply it, re-run without -VerifyOnly:"
    Write-Host "     .\scripts\run-migration-055.ps1"
} else {
    Write-Host ">> All done. Next:"
    Write-Host "   cd infra; npx cdk destroy JaleBastionStack    # cost hygiene"
    Write-Host "   cd infra; npx cdk deploy JaleApiStack         # carries the GET /employer/inbox Lambda + route"
}
Write-Host ""
Write-Host "!! Reminder: never use scripts/run-migrations.ps1 / .sh against production for this migration."
