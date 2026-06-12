# Applies only the admin-panel migration and synchronizes the dedicated
# jale_admin_console password. It deliberately does not rotate any unrelated
# database role or secret.

[CmdletBinding()]
param(
    [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-2' })
)

$ErrorActionPreference = 'Stop'
$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'
$MigrationPath = Join-Path $PSScriptRoot '..\infra\db\migrations\026_admin_panel.sql'

function Get-StackResourceId {
    param(
        [string]$StackName,
        [string]$Query
    )

    $value = aws cloudformation describe-stack-resources `
        --region $Region `
        --stack-name $StackName `
        --query $Query `
        --output text

    if (-not $value -or $value.Trim() -eq 'None') {
        throw "Unable to resolve required resource from $StackName."
    }

    return $value.Trim()
}

if (-not (Test-Path -LiteralPath $MigrationPath)) {
    throw "Migration not found: $MigrationPath"
}

$bastionId = aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $BastionStack `
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue | [0]" `
    --output text
$bastionId = $bastionId.Trim()
if (-not $bastionId -or $bastionId -eq 'None') {
    throw "BastionInstanceId is missing from $BastionStack."
}

$dbSecretArn = Get-StackResourceId `
    -StackName $DatabaseStack `
    -Query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]"
$adminSecretArn = Get-StackResourceId `
    -StackName $DatabaseStack `
    -Query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'AdminConsoleDbSecret')].PhysicalResourceId | [0]"

$migrationB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $MigrationPath)))
$remoteScript = @'
#!/bin/bash
set -euo pipefail

REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"
ADMIN_SECRET_ARN="__ADMIN_SECRET_ARN__"
MIGRATION_B64="__MIGRATION_B64__"

DB_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
DB_HOST=$(echo "$DB_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_JSON" | jq -r .username)
export PGPASSWORD=$(echo "$DB_JSON" | jq -r .password)
PG=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

echo "$MIGRATION_B64" | base64 -d > /tmp/026_admin_panel.sql
"${PG[@]}" -f /tmp/026_admin_panel.sql
rm -f /tmp/026_admin_panel.sql

ADMIN_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$ADMIN_SECRET_ARN" --query SecretString --output text)
ADMIN_PASSWORD=$(echo "$ADMIN_JSON" | jq -r .password)
"${PG[@]}" -c "ALTER ROLE jale_admin_console WITH PASSWORD '$ADMIN_PASSWORD';"

echo "Verifying admin schema and role..."
"${PG[@]}" -Atc "
SELECT to_regclass('public.admin_users');
SELECT to_regclass('public.admin_cases');
SELECT to_regclass('public.admin_case_events');
SELECT to_regclass('public.admin_audit_log');
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jale_admin_console') THEN 'role-present' ELSE 'role-missing' END;
"

export PGPASSWORD="$ADMIN_PASSWORD"
ADMIN_PG=(psql -h "$DB_HOST" -p "$DB_PORT" -U jale_admin_console -d "$DB_NAME" -v ON_ERROR_STOP=1)
"${ADMIN_PG[@]}" -Atc "SELECT count(*) FROM admin_cases; SELECT count(*) FROM admin_audit_log;"

set +e
"${ADMIN_PG[@]}" -Atc "SELECT cognito_sub FROM users LIMIT 1;" >/tmp/admin-denied-column.out 2>&1
COLUMN_STATUS=$?
"${ADMIN_PG[@]}" -Atc "UPDATE admin_audit_log SET action='forbidden';" >/tmp/admin-denied-audit.out 2>&1
AUDIT_STATUS=$?
set -e

if [[ $COLUMN_STATUS -eq 0 || $AUDIT_STATUS -eq 0 ]]; then
  echo "Admin database boundary verification failed."
  cat /tmp/admin-denied-column.out /tmp/admin-denied-audit.out
  exit 1
fi

rm -f /tmp/admin-denied-column.out /tmp/admin-denied-audit.out
unset PGPASSWORD DB_JSON ADMIN_JSON ADMIN_PASSWORD
echo "Admin migration and database boundary verification completed."
'@

$remoteScript = $remoteScript `
    -replace '__REGION__', $Region `
    -replace '__DB_SECRET_ARN__', $dbSecretArn `
    -replace '__ADMIN_SECRET_ARN__', $adminSecretArn `
    -replace '__MIGRATION_B64__', $migrationB64
$remoteScript = $remoteScript -replace "`r`n", "`n"

$parametersPath = [IO.Path]::GetTempFileName()
try {
    $json = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($parametersPath, $json, (New-Object Text.UTF8Encoding($false)))

    $commandId = aws ssm send-command `
        --region $Region `
        --document-name AWS-RunShellScript `
        --instance-ids $bastionId `
        --comment 'Apply Jale admin migration 026 only' `
        --parameters "file://$parametersPath" `
        --query Command.CommandId `
        --output text
}
finally {
    Remove-Item -LiteralPath $parametersPath -Force -ErrorAction SilentlyContinue
}

if (-not $commandId) {
    throw 'SSM did not return a command ID.'
}

Write-Host "Admin migration SSM command: $commandId"
while ($true) {
    Start-Sleep -Seconds 3
    $invocation = aws ssm get-command-invocation `
        --region $Region `
        --command-id $commandId `
        --instance-id $bastionId | ConvertFrom-Json

    if ($invocation.Status -eq 'Success') {
        Write-Host $invocation.StandardOutputContent
        break
    }

    if ($invocation.Status -in @('Failed', 'Cancelled', 'TimedOut')) {
        Write-Host $invocation.StandardOutputContent
        throw $invocation.StandardErrorContent
    }
}
