# run-migrations.ps1 — PowerShell port of run-migrations.sh.
#
# Apply DB migrations against the Jale RDS via the ephemeral BastionStack.
# Usage:
#
#   1. Deploy the bastion: `npx cdk deploy JaleBastionStack` (from infra/)
#   2. Run this script:    `pwsh scripts/run-migrations.ps1`  (or .\scripts\run-migrations.ps1 from repo root)
#   3. Destroy the bastion: `npx cdk destroy JaleBastionStack`
#
# What this does:
#   - Resolves the bastion instance ID from CloudFormation output
#   - Resolves the jale_admin DB secret ARN from CloudFormation
#   - Resolves the jale_matching DB secret ARN from CloudFormation
#   - Base64-encodes migrations 001→026
#   - `aws ssm send-command` runs a script ON THE BASTION that:
#       * Fetches jale_admin creds via IAM role
#       * Applies each migration as jale_admin (one transaction per file)
#       * Sets the jale_matching role password from the CDK-generated secret
#       * Generates a random password for jale_whatsapp
#       * ALTERs the role password
#       * Creates/updates jale/whatsapp/db secret
#   - Polls command status, streams bastion stdout to operator
#
# Operator-side requirements: aws CLI v2 (no jq, no bash, no psql needed locally).
# Bastion-side requirements: installed automatically via BastionStack UserData
#   (postgresql15 + jq).
#
# No `psql` or Twilio credentials ever cross the operator's terminal.

[CmdletBinding()]
param(
    [string]$Region = $(
        if ($env:AWS_REGION) { $env:AWS_REGION }
        elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION }
        else { 'us-east-2' }
    )
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'
$WaDbSecretName = 'jale/whatsapp/db'

# Migration files in execution order. Full chain against a fresh RDS.
$MigrationFiles = @(
    # '001_initial_schema.sql',
    # '002_rls_policies.sql',
    # '003_jobs_and_applications.sql',
    # '004_whatsapp.sql',
    # '005_document_vault.sql',
    # '006_trust_signal_layer.sql',
    # '007_worker_marketplace.sql',
    # '008_worker_skills.sql',
    # '009_location_foundation.sql',
    # '010_matching_write_semantics.sql',
    # '011_ai_profile_media.sql',
    # '012_ai_trust_assessment.sql',
    # '013_whatsapp_template_outbox.sql',
    # '014_employer_candidate_rankings.sql',
    # '015_application_status_alignment.sql',
    # '016_employer_profiles.sql',
    # '017_document_upload_token_hardening.sql',
    # '018_document_vault_rls_hardening.sql',
    # '019_application_status_constraint_repair.sql',
    # '020_worker_pii_rls_hardening.sql',
    # '021_whatsapp_required_docs_apply_support.sql',
    # '022_job_application_required_docs_guard.sql',
    # '023_job_fields_and_statuses_mvp.sql',
    # '024_sprint11_hiring_flow_hardening.sql',
    # '025_job_messaging.sql',
    # '026_admin_panel.sql',
    # '027_admin_security_hardening.sql',
    '028_job_messaging_hardening.sql',
    '029_hired_count_trigger_security_definer.sql',
    '030_whatsapp_worker_skills_seed.sql'
)

$MigrationDir = (Resolve-Path (Join-Path $PSScriptRoot '..\infra\db\migrations')).Path

Write-Host ">> Using region: $Region"

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
# Resolve jale_admin DB secret ARN.
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
# Resolve jale_matching DB secret ARN.
# ---------------------------------------------------------------------------
Write-Host ">> Resolving jale_matching DB secret ARN..."
$matchingSecretArn = (aws cloudformation describe-stack-resources `
        --stack-name $DatabaseStack `
        --region $Region `
        --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'MatchingDbSecret')].PhysicalResourceId | [0]" `
        --output text).Trim()

if ([string]::IsNullOrEmpty($matchingSecretArn) -or $matchingSecretArn -eq 'None') {
    Write-Host "!! Could not find jale_matching DB secret in $DatabaseStack." -ForegroundColor Red
    exit 1
}
Write-Host "   matching-secret: $matchingSecretArn"

# ---------------------------------------------------------------------------
# Resolve jale_admin_console DB secret ARN.
# ---------------------------------------------------------------------------
Write-Host ">> Resolving jale_admin_console DB secret ARN..."
$adminConsoleSecretArn = (aws cloudformation describe-stack-resources `
        --stack-name $DatabaseStack `
        --region $Region `
        --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'AdminConsoleDbSecret')].PhysicalResourceId | [0]" `
        --output text).Trim()

if ([string]::IsNullOrEmpty($adminConsoleSecretArn) -or $adminConsoleSecretArn -eq 'None') {
    Write-Host "!! Could not find jale_admin_console DB secret in $DatabaseStack." -ForegroundColor Red
    exit 1
}
Write-Host "   admin-console-secret: $adminConsoleSecretArn"

# ---------------------------------------------------------------------------
# Verify migration files + base64-encode.
# ---------------------------------------------------------------------------
$migrationsB64 = [ordered]@{}
foreach ($f in $MigrationFiles) {
    $p = Join-Path $MigrationDir $f
    if (-not (Test-Path $p)) {
        Write-Host "!! Migration file missing: $p" -ForegroundColor Red
        exit 1
    }
    $bytes = [System.IO.File]::ReadAllBytes($p)
    $migrationsB64[$f] = [Convert]::ToBase64String($bytes)
}

# ---------------------------------------------------------------------------
# Build the remote bash script.
#
# @'...'@ is a verbatim here-string — bash sigils like $VAR, $(...), ${VAR[@]}
# stay literal. Placeholders get substituted after via -replace (literal text,
# no regex metacharacters).
# ---------------------------------------------------------------------------
$remoteTemplate = @'
#!/bin/bash
set -euo pipefail

REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"
MATCHING_SECRET_ARN="__MATCHING_SECRET_ARN__"
ADMIN_CONSOLE_SECRET_ARN="__ADMIN_CONSOLE_SECRET_ARN__"
WA_DB_SECRET_NAME="__WA_DB_SECRET_NAME__"

echo ">> Fetching jale_admin creds from $DB_SECRET_ARN"
DB_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
DB_HOST=$(echo "$DB_SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_SECRET_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_SECRET_JSON" | jq -r .username)
DB_PASS=$(echo "$DB_SECRET_JSON" | jq -r .password)

export PGPASSWORD="$DB_PASS"
PG_CMD=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

echo ">> Applying migrations..."
MIGRATION_FILES=(__MIGRATION_FILES_ARRAY__)
declare -A MIGRATION_B64_REMOTE
__MIGRATION_B64_ASSIGNMENTS__

for f in "${MIGRATION_FILES[@]}"; do
  echo "   -> $f"
  TMP="/tmp/mig-${f}"
  echo "${MIGRATION_B64_REMOTE[$f]}" | base64 -d > "$TMP"
  "${PG_CMD[@]}" -f "$TMP"
  rm -f "$TMP"
done

echo ">> Migrations applied cleanly."

echo ">> Setting jale_matching password from generated secret..."
MATCHING_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$MATCHING_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
MATCHING_PW=$(echo "$MATCHING_SECRET_JSON" | jq -r .password)
"${PG_CMD[@]}" -c "ALTER ROLE jale_matching WITH PASSWORD '$MATCHING_PW';"

echo ">> Setting jale_admin_console password from generated secret..."
ADMIN_CONSOLE_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$ADMIN_CONSOLE_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString --output text)
ADMIN_CONSOLE_PW=$(echo "$ADMIN_CONSOLE_SECRET_JSON" | jq -r .password)
"${PG_CMD[@]}" -c "ALTER ROLE jale_admin_console WITH PASSWORD '$ADMIN_CONSOLE_PW';"

echo ">> Generating jale_whatsapp password + setting ALTER ROLE..."
WA_PW=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-24)
"${PG_CMD[@]}" -c "ALTER ROLE jale_whatsapp WITH PASSWORD '$WA_PW';"

echo ">> Seeding jale/whatsapp/db secret..."
SECRET_STRING=$(jq -n \
  --arg host "$DB_HOST" \
  --arg port "$DB_PORT" \
  --arg dbname "$DB_NAME" \
  --arg username "jale_whatsapp" \
  --arg password "$WA_PW" \
  '{host: $host, port: ($port | tonumber), dbname: $dbname, username: $username, password: $password}')

if aws secretsmanager describe-secret \
     --secret-id "$WA_DB_SECRET_NAME" \
     --region "$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$WA_DB_SECRET_NAME" \
    --region "$REGION" \
    --secret-string "$SECRET_STRING" >/dev/null
  echo "   updated existing secret"
else
  aws secretsmanager create-secret \
    --name "$WA_DB_SECRET_NAME" \
    --region "$REGION" \
    --description "jale_whatsapp role credentials for WhatsApp Lambdas" \
    --secret-string "$SECRET_STRING" >/dev/null
  echo "   created new secret"
fi

unset PGPASSWORD WA_PW SECRET_STRING DB_PASS MATCHING_PW MATCHING_SECRET_JSON ADMIN_CONSOLE_PW ADMIN_CONSOLE_SECRET_JSON
echo ">> Done."
'@

# Build the bash MIGRATION_FILES array literal:  "001_initial_schema.sql" "002_rls_policies.sql" ...
$fileArrayLiteral = ($MigrationFiles | ForEach-Object { "`"$_`"" }) -join ' '

# Build the bash associative-array assignments, one per file:
#   MIGRATION_B64_REMOTE["001_initial_schema.sql"]='aGVsbG8=...'
$assignLines = foreach ($f in $MigrationFiles) {
    "MIGRATION_B64_REMOTE[`"$f`"]='$($migrationsB64[$f])'"
}
$b64Assignments = $assignLines -join "`n"

# -replace uses regex on BOTH pattern and replacement. The patterns are
# underscore-wrapped ASCII (literal). Replacement strings must escape '$'
# because PS -replace treats '$1', '$&', etc. as backrefs. Base64 has no '$',
# file names have no '$', region/ARN have no '$' — safe. But we defensively
# double any '$' in dbSecretArn just in case ARN format evolves.
$dbSecretArnSafe = $dbSecretArn -replace '\$', '$$$$'
$matchingSecretArnSafe = $matchingSecretArn -replace '\$', '$$$$'
$adminConsoleSecretArnSafe = $adminConsoleSecretArn -replace '\$', '$$$$'
$regionSafe = $Region -replace '\$', '$$$$'
$waDbSecretNameSafe = $WaDbSecretName -replace '\$', '$$$$'
$fileArrayLiteralSafe = $fileArrayLiteral -replace '\$', '$$$$'
$b64AssignmentsSafe = $b64Assignments -replace '\$', '$$$$'

$remoteScript = $remoteTemplate `
    -replace '__REGION__', $regionSafe `
    -replace '__DB_SECRET_ARN__', $dbSecretArnSafe `
    -replace '__MATCHING_SECRET_ARN__', $matchingSecretArnSafe `
    -replace '__ADMIN_CONSOLE_SECRET_ARN__', $adminConsoleSecretArnSafe `
    -replace '__WA_DB_SECRET_NAME__', $waDbSecretNameSafe `
    -replace '__MIGRATION_FILES_ARRAY__', $fileArrayLiteralSafe `
    -replace '__MIGRATION_B64_ASSIGNMENTS__', $b64AssignmentsSafe
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
    Write-Host ">> Sending command to bastion via SSM..."
    $cmdId = (aws ssm send-command `
            --region $Region `
            --document-name 'AWS-RunShellScript' `
            --instance-ids $bastionId `
            --comment 'Jale DB migrations + jale_whatsapp password seed' `
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
Write-Host ">> All done. Next:"
Write-Host "   cd infra; npx cdk destroy JaleBastionStack    # cost hygiene"
Write-Host "   cd infra; npx cdk deploy JaleAuthStack JaleApiStack JaleLegalStack JaleWhatsAppStack JaleDocumentsStack"
