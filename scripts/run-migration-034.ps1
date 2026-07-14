# run-migration-034.ps1 — apply ONLY 034_billing_foundation.sql.
# Scoped single-migration operator procedure, modeled on run-migration-022.ps1.
#
# !! DO NOT use scripts/run-migrations.ps1 (or .sh) against production for this
# !! migration. Those scripts replay the FULL 001-034 chain and must never be
# !! run against a database that already has some/all of that chain applied.
# !! This script applies 034_billing_foundation.sql and nothing else.
#
# Migration 034 is forward-only (per its own header + ADR-005). This script
# refuses to apply it a second time: it inspects the live database for
# public.billing_plans before touching anything, and aborts if it already
# exists.
#
# Usage:
#
#   1. Deploy the bastion:   `npx cdk deploy JaleBastionStack` (from infra/)
#   2. Inspect first:        `pwsh scripts/run-migration-034.ps1 -VerifyOnly`
#   3. Apply the migration:  `pwsh scripts/run-migration-034.ps1`
#   4. Destroy the bastion:  `npx cdk destroy JaleBastionStack`
#
# What -VerifyOnly does (safe to run anytime, never mutates the database):
#   - Connects to RDS via the bastion as jale_admin (read-only)
#   - Reports whether migration 034 is present (public.billing_plans exists)
#   - If present, runs the full post-verification suite (tables, plan
#     catalog, entitlements, RLS enable+force, jale_billing grants) and
#     reports PASS/FAIL per check
#   - If absent, reports that and stops — no apply, no password sync
#
# What the default (apply) run does:
#   - Resolves the bastion instance ID from CloudFormation
#   - Resolves the jale_admin DB secret ARN from CloudFormation
#   - Resolves the jale/billing/db (BillingDbSecret) secret ARN from
#     CloudFormation — this secret is CDK-managed (DatabaseStack); this
#     script only reads it and ALTERs the role password to match it. It
#     never creates or overwrites the secret itself.
#   - Base64-encodes 034_billing_foundation.sql
#   - `aws ssm send-command` runs a script ON THE BASTION that:
#       * PRE-CHECKS that public.billing_plans does not already exist;
#         ABORTS (non-zero exit, no changes) if it does
#       * Applies 034_billing_foundation.sql as jale_admin, one transaction
#       * Reads the jale/billing/db secret and ALTERs jale_billing's
#         password to match it (password read/used only on the bastion,
#         unset immediately after; never printed)
#       * Connects as jale_billing (host/port/dbname/password from the
#         secret) and runs `SELECT 1` to prove the role can connect
#       * Runs the same read-only post-verification suite as -VerifyOnly
#         and fails loudly (non-zero exit) on any mismatch
#   - Polls command status, streams bastion stdout to operator
#
# Operator-side requirements: aws CLI v2 (no jq, no bash, no psql needed
# locally). Bastion-side requirements: installed automatically via
# BastionStack UserData (postgresql15 + jq).
#
# No `psql`, DB passwords, or Stripe/Twilio credentials ever cross the
# operator's terminal. The jale_billing password is read and used only on
# the bastion and is unset from the shell environment before the command
# returns.

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

# Migration files in execution order. This script applies 034 ONLY — never
# the full 001-034 chain. Do not add other migration files to this array.
$MigrationFiles = @(
    '034_billing_foundation.sql'
)

$MigrationDir = (Resolve-Path (Join-Path $PSScriptRoot '..\infra\db\migrations')).Path

Write-Host ">> Using region: $Region"
if ($VerifyOnly) {
    Write-Host ">> Mode: -VerifyOnly (read-only inspection; no apply, no password sync)"
} else {
    Write-Host ">> Mode: apply migration 034 + sync jale_billing password"
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
# Resolve jale/billing/db (BillingDbSecret) secret ARN — apply mode only.
# CDK-managed (DatabaseStack); this script only reads it, never creates or
# overwrites it. Same resolution pattern as MatchingDbSecret in
# run-migration-022.ps1.
# ---------------------------------------------------------------------------
$billingSecretArn = ''
if (-not $VerifyOnly) {
    Write-Host ">> Resolving jale_billing DB secret ARN..."
    $billingSecretArn = (aws cloudformation describe-stack-resources `
            --stack-name $DatabaseStack `
            --region $Region `
            --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'BillingDbSecret')].PhysicalResourceId | [0]" `
            --output text).Trim()

    if ([string]::IsNullOrEmpty($billingSecretArn) -or $billingSecretArn -eq 'None') {
        Write-Host "!! Could not find jale/billing/db (BillingDbSecret) secret in $DatabaseStack." -ForegroundColor Red
        exit 1
    }
    Write-Host "   billing-secret: $billingSecretArn"
}

# ---------------------------------------------------------------------------
# Verify migration file + base64-encode — apply mode only.
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
  echo ">> Running migration-034 read-only verification..."
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

  check_eq() {
    local desc="$1"
    local sql="$2"
    local expected="$3"
    local result
    result=$("${PG_CMD[@]}" -tAc "$sql" 2>&1 | tr -d '[:space:]')
    if [ "$result" = "$expected" ]; then
      echo "   [PASS] $desc"
    else
      echo "   [FAIL] $desc (expected '$expected', got '$result')"
      FAIL_COUNT=$((FAIL_COUNT+1))
    fi
  }

  echo "   -- tables --"
  for t in organizations billing_plans billing_customers subscriptions billing_operations billing_webhook_events; do
    check_true "table public.$t exists" "SELECT to_regclass('public.$t') IS NOT NULL;"
  done

  echo "   -- plan catalog --"
  for p in employer_free employer_pro worker_free; do
    check_true "billing_plans row '$p' exists" "SELECT EXISTS (SELECT 1 FROM billing_plans WHERE code = '$p');"
  done
  check_eq "employer_free active_job_limit" \
    "SELECT entitlements->>'active_job_limit' FROM billing_plans WHERE code='employer_free';" "1"
  check_eq "employer_pro active_job_limit" \
    "SELECT entitlements->>'active_job_limit' FROM billing_plans WHERE code='employer_pro';" "10"
  check_eq "employer_pro display_price_minor" \
    "SELECT display_price_minor::text FROM billing_plans WHERE code='employer_pro';" "2000"
  check_eq "employer_pro currency" \
    "SELECT currency FROM billing_plans WHERE code='employer_pro';" "usd"
  check_eq "employer_pro billing_interval" \
    "SELECT billing_interval FROM billing_plans WHERE code='employer_pro';" "month"

  echo "   -- RLS enabled + forced --"
  for t in organizations billing_plans billing_customers subscriptions billing_operations billing_webhook_events; do
    check_true "RLS enabled+forced on $t" \
      "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.$t'::regclass;"
  done

  echo "   -- jale_billing must NOT touch users or billing_operations --"
  check_true "jale_billing has no privileges on users" \
    "SELECT NOT (has_table_privilege('jale_billing','public.users','SELECT') OR has_table_privilege('jale_billing','public.users','INSERT') OR has_table_privilege('jale_billing','public.users','UPDATE') OR has_table_privilege('jale_billing','public.users','DELETE'));"
  check_true "jale_billing has no privileges on billing_operations" \
    "SELECT NOT (has_table_privilege('jale_billing','public.billing_operations','SELECT') OR has_table_privilege('jale_billing','public.billing_operations','INSERT') OR has_table_privilege('jale_billing','public.billing_operations','UPDATE') OR has_table_privilege('jale_billing','public.billing_operations','DELETE'));"

  echo "   -- jale_billing expected grants on processor tables (per 034) --"
  check_true "jale_billing SELECT on billing_plans" "SELECT has_table_privilege('jale_billing','public.billing_plans','SELECT');"
  check_true "jale_billing no INSERT on billing_plans" "SELECT NOT has_table_privilege('jale_billing','public.billing_plans','INSERT');"
  check_true "jale_billing no UPDATE on billing_plans" "SELECT NOT has_table_privilege('jale_billing','public.billing_plans','UPDATE');"
  check_true "jale_billing no DELETE on billing_plans" "SELECT NOT has_table_privilege('jale_billing','public.billing_plans','DELETE');"

  check_true "jale_billing SELECT on billing_customers" "SELECT has_table_privilege('jale_billing','public.billing_customers','SELECT');"
  check_true "jale_billing no INSERT on billing_customers" "SELECT NOT has_table_privilege('jale_billing','public.billing_customers','INSERT');"
  check_true "jale_billing no UPDATE on billing_customers" "SELECT NOT has_table_privilege('jale_billing','public.billing_customers','UPDATE');"
  check_true "jale_billing no DELETE on billing_customers" "SELECT NOT has_table_privilege('jale_billing','public.billing_customers','DELETE');"

  check_true "jale_billing SELECT on subscriptions" "SELECT has_table_privilege('jale_billing','public.subscriptions','SELECT');"
  check_true "jale_billing INSERT on subscriptions" "SELECT has_table_privilege('jale_billing','public.subscriptions','INSERT');"
  check_true "jale_billing UPDATE on subscriptions" "SELECT has_table_privilege('jale_billing','public.subscriptions','UPDATE');"
  check_true "jale_billing no DELETE on subscriptions" "SELECT NOT has_table_privilege('jale_billing','public.subscriptions','DELETE');"

  check_true "jale_billing SELECT on billing_webhook_events" "SELECT has_table_privilege('jale_billing','public.billing_webhook_events','SELECT');"
  check_true "jale_billing INSERT on billing_webhook_events" "SELECT has_table_privilege('jale_billing','public.billing_webhook_events','INSERT');"
  check_true "jale_billing UPDATE on billing_webhook_events" "SELECT has_table_privilege('jale_billing','public.billing_webhook_events','UPDATE');"
  check_true "jale_billing no DELETE on billing_webhook_events" "SELECT NOT has_table_privilege('jale_billing','public.billing_webhook_events','DELETE');"

  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "!! Verification FAILED: $FAIL_COUNT check(s) did not pass."
    return 1
  fi
  echo ">> Verification PASSED: all checks green."
  return 0
}
'@

# ---------------------------------------------------------------------------
# Build the remote bash script.
#
# @'...'@ is a verbatim here-string — bash sigils like $VAR, $(...), ${VAR[@]}
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

echo ">> VERIFY-ONLY: checking whether migration 034 is present (read-only, no changes)..."
PRESENT=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.billing_plans') IS NOT NULL;" | tr -d '[:space:]')

if [ "$PRESENT" != "t" ]; then
  echo ">> Migration 034 is NOT present on this database (public.billing_plans not found)."
  echo ">> Nothing further to verify. Safe to run the apply pass."
  unset PGPASSWORD DB_SECRET_JSON
  exit 0
fi

echo ">> Migration 034 IS present (public.billing_plans exists). Running full verification..."
VERIFY_STATUS=0
run_verification || VERIFY_STATUS=$?

unset PGPASSWORD DB_SECRET_JSON

if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "!! Verification reported failures. See [FAIL] lines above." >&2
  exit 1
fi

echo ">> Migration 034 is present and every check is green."
'@
} else {
    $remoteTemplate = @'
#!/bin/bash
set -euo pipefail

REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"
BILLING_SECRET_ARN="__BILLING_SECRET_ARN__"

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

echo ">> PRE-CHECK: confirming migration 034 has not already been applied..."
PRECHECK=$("${PG_CMD[@]}" -tAc "SELECT to_regclass('public.billing_plans') IS NOT NULL;" | tr -d '[:space:]')
if [ "$PRECHECK" = "t" ]; then
  echo "!! ABORT: public.billing_plans already exists." >&2
  echo "!! Migration 034 is forward-only and must never be reapplied. No changes made." >&2
  unset PGPASSWORD DB_SECRET_JSON
  exit 1
fi
echo "   pre-check OK: billing_plans absent, safe to apply."

echo ">> Applying 034_billing_foundation.sql (single transaction)..."
TMP="/tmp/mig-034_billing_foundation.sql"
echo "__MIGRATION_B64__" | base64 -d > "$TMP"
"${PG_CMD[@]}" -f "$TMP"
rm -f "$TMP"
echo ">> Migration 034 applied cleanly."

echo ">> Syncing jale_billing role password from jale/billing/db secret (CDK-managed; not created/overwritten here)..."
BILLING_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$BILLING_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
BILLING_HOST=$(echo "$BILLING_SECRET_JSON" | jq -r .host)
BILLING_PORT=$(echo "$BILLING_SECRET_JSON" | jq -r .port)
BILLING_DBNAME=$(echo "$BILLING_SECRET_JSON" | jq -r '.dbname // "jale"')
BILLING_PW=$(echo "$BILLING_SECRET_JSON" | jq -r .password)
BILLING_PW_ESCAPED="${BILLING_PW//\'/\'\'}"
"${PG_CMD[@]}" -c "ALTER ROLE jale_billing WITH PASSWORD '$BILLING_PW_ESCAPED';"
echo "   jale_billing password synced (value never printed)."

echo ">> Proving jale_billing can connect with the synced password..."
BILLING_CHECK=$(PGPASSWORD="$BILLING_PW" psql -h "$BILLING_HOST" -p "$BILLING_PORT" -U jale_billing -d "$BILLING_DBNAME" -v ON_ERROR_STOP=1 -tAc "SELECT 1;" | tr -d '[:space:]')
if [ "$BILLING_CHECK" != "1" ]; then
  echo "!! jale_billing connectivity check failed: SELECT 1 did not return 1." >&2
  unset PGPASSWORD BILLING_PW BILLING_PW_ESCAPED BILLING_SECRET_JSON DB_SECRET_JSON
  exit 1
fi
echo "   jale_billing connection verified (SELECT 1 succeeded)."

VERIFY_STATUS=0
run_verification || VERIFY_STATUS=$?

unset PGPASSWORD BILLING_PW BILLING_PW_ESCAPED BILLING_SECRET_JSON DB_SECRET_JSON

if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "!! Post-verification reported failures. Investigate before declaring migration 034 complete." >&2
  exit 1
fi

echo ">> Done: migration 034 applied, jale_billing password synced, connectivity + schema verified."
'@
}

$regionSafe = $Region -replace '\$', '$$$$'
$dbSecretArnSafe = $dbSecretArn -replace '\$', '$$$$'
$billingSecretArnSafe = $billingSecretArn -replace '\$', '$$$$'
$migrationB64Safe = $migrationB64 -replace '\$', '$$$$'
$verificationFunctionsSafe = $verificationFunctions -replace '\$', '$$$$'

$remoteScript = $remoteTemplate `
    -replace '__REGION__', $regionSafe `
    -replace '__DB_SECRET_ARN__', $dbSecretArnSafe `
    -replace '__BILLING_SECRET_ARN__', $billingSecretArnSafe `
    -replace '__MIGRATION_B64__', $migrationB64Safe `
    -replace '__VERIFICATION_FUNCTIONS__', $verificationFunctionsSafe
$remoteScript = $remoteScript -replace "`r`n", "`n"

# ---------------------------------------------------------------------------
# Write the SSM parameters JSON to a temp file with UTF-8 NO-BOM.
# PS 5.1's default Set-Content emits UTF-16 LE with BOM — AWS CLI rejects
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
    $comment = if ($VerifyOnly) { 'Jale migration 034 verify-only inspection' } else { 'Jale migration 034 apply + jale_billing password sync' }
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
    # else: Pending / InProgress / Delayed — keep polling
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
    Write-Host "   If migration 034 is absent and you intend to apply it, re-run without -VerifyOnly:"
    Write-Host "     pwsh scripts/run-migration-034.ps1"
} else {
    Write-Host ">> All done. Next:"
    Write-Host "   cd infra; npx cdk destroy JaleBastionStack    # cost hygiene"
    Write-Host "   Deploy whatever billing-consuming stack(s) read jale/billing/db once ready."
}
Write-Host ""
Write-Host "!! Reminder: never use scripts/run-migrations.ps1 / .sh against production for this migration."
