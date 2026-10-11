# cleanup-integration-test-rds-users.ps1
#
# Deletes RDS rows created by the integration-test users from
# infra/test/integration/setup/global-setup.ts. Runs SQL on the ephemeral
# JaleBastionStack via SSM, using the JaleDatabaseStack admin secret.
#
# Usage:
#   cd infra
#   npx cdk deploy JaleBastionStack
#   cd ..
#   .\scripts\cleanup-integration-test-rds-users.ps1
#   cd infra
#   npx cdk destroy JaleBastionStack

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

$Identifiers = @(
    '+19999000001',
    '+19999000002',
    '+19999000003',
    'test-integration-employer@jale.test',
    'test-integration-profile-employer@jale.test'
)

function ConvertTo-SqlStringArrayLiteral {
    param([string[]]$Values)
    $quoted = $Values | ForEach-Object { "'" + ($_.Replace("'", "''")) + "'" }
    return 'ARRAY[' + ($quoted -join ', ') + ']::text[]'
}

Write-Host ">> Using region: $Region"

Write-Host ">> Resolving bastion instance ID..."
$bastionId = (aws cloudformation describe-stacks `
    --stack-name $BastionStack `
    --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" `
    --output text).Trim()

if ([string]::IsNullOrEmpty($bastionId) -or $bastionId -eq 'None') {
    Write-Host "!! Could not find BastionInstanceId output on $BastionStack." -ForegroundColor Red
    Write-Host "   Deploy it first: cd infra; npx cdk deploy $BastionStack"
    exit 1
}
Write-Host "   bastion: $bastionId"

Write-Host ">> Resolving DB secret ARN..."
$rawSecret = (aws cloudformation describe-stack-resources `
    --stack-name $DatabaseStack `
    --region $Region `
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId" `
    --output text)
$dbSecretArn = ($rawSecret -split "\s+" | Where-Object { $_ } | Select-Object -First 1)

if ([string]::IsNullOrEmpty($dbSecretArn)) {
    Write-Host "!! Could not find DB secret in $DatabaseStack." -ForegroundColor Red
    exit 1
}
Write-Host "   db-secret: $dbSecretArn"

$identifierArray = ConvertTo-SqlStringArrayLiteral $Identifiers

$sql = @"
SET row_security = off;

BEGIN;

CREATE TEMP TABLE cleanup_user_ids(id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO cleanup_user_ids(id)
SELECT id
FROM users
WHERE cognito_sub = ANY($identifierArray)
   OR email = ANY($identifierArray)
   OR phone = ANY($identifierArray);

DO `$`$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'whatsapp_number'
  ) THEN
    INSERT INTO cleanup_user_ids(id)
    SELECT id FROM users WHERE whatsapp_number = ANY($identifierArray)
    ON CONFLICT DO NOTHING;
  END IF;
END
`$`$;

CREATE TEMP TABLE cleanup_job_ids(id uuid PRIMARY KEY) ON COMMIT DROP;
DO `$`$
BEGIN
  IF to_regclass('jobs') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'jobs'
         AND column_name = 'employer_id'
     ) THEN
    INSERT INTO cleanup_job_ids(id)
    SELECT id FROM jobs WHERE employer_id IN (SELECT id FROM cleanup_user_ids)
    ON CONFLICT DO NOTHING;
  END IF;
END
`$`$;

DO `$`$
BEGIN
  IF to_regclass('whatsapp_outbox') IS NOT NULL THEN
    DELETE FROM whatsapp_outbox
    WHERE whatsapp_number = ANY($identifierArray)
       OR inbound_message_sid IN (
         SELECT message_sid
         FROM whatsapp_processed_messages
         WHERE whatsapp_number = ANY($identifierArray)
       );
  END IF;

  IF to_regclass('whatsapp_processed_messages') IS NOT NULL THEN
    DELETE FROM whatsapp_processed_messages
    WHERE whatsapp_number = ANY($identifierArray);
  END IF;

  IF to_regclass('whatsapp_conversations') IS NOT NULL THEN
    DELETE FROM whatsapp_conversations
    WHERE whatsapp_number = ANY($identifierArray)
       OR user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('document_upload_tokens') IS NOT NULL THEN
    DELETE FROM document_upload_tokens
    WHERE worker_id IN (SELECT id FROM cleanup_user_ids)
       OR job_id IN (SELECT id FROM cleanup_job_ids);
  END IF;

  IF to_regclass('worker_documents') IS NOT NULL THEN
    DELETE FROM worker_documents
    WHERE worker_id IN (SELECT id FROM cleanup_user_ids)
       OR job_id IN (SELECT id FROM cleanup_job_ids);
  END IF;

  IF to_regclass('job_applications') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'job_applications' AND column_name = 'user_id'
    ) THEN
      DELETE FROM job_applications
      WHERE user_id IN (SELECT id FROM cleanup_user_ids)
         OR job_id IN (SELECT id FROM cleanup_job_ids);
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'job_applications' AND column_name = 'worker_id'
    ) THEN
      DELETE FROM job_applications
      WHERE worker_id IN (SELECT id FROM cleanup_user_ids)
         OR job_id IN (SELECT id FROM cleanup_job_ids);
    END IF;
  END IF;

  IF to_regclass('legal_consent_log') IS NOT NULL THEN
    DELETE FROM legal_consent_log
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('jobs') IS NOT NULL THEN
    DELETE FROM jobs
    WHERE id IN (SELECT id FROM cleanup_job_ids);
  END IF;

  IF to_regclass('worker_profiles') IS NOT NULL THEN
    DELETE FROM worker_profiles
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;
END
`$`$;

DELETE FROM users
WHERE id IN (SELECT id FROM cleanup_user_ids)
   OR cognito_sub = ANY($identifierArray)
   OR email = ANY($identifierArray)
   OR phone = ANY($identifierArray);

COMMIT;
"@

$sqlB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sql))

$remoteScript = @"
#!/bin/bash
set -euo pipefail

REGION="$Region"
DB_SECRET_ARN="$dbSecretArn"

DB_SECRET_JSON=`$(aws secretsmanager get-secret-value --secret-id "`$DB_SECRET_ARN" --region "`$REGION" --query SecretString --output text)
DB_HOST=`$(echo "`$DB_SECRET_JSON" | jq -r .host)
DB_PORT=`$(echo "`$DB_SECRET_JSON" | jq -r .port)
DB_NAME=`$(echo "`$DB_SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=`$(echo "`$DB_SECRET_JSON" | jq -r .username)
DB_PASS=`$(echo "`$DB_SECRET_JSON" | jq -r .password)

export PGPASSWORD="`$DB_PASS"
TMP="/tmp/jale-cleanup-integration.sql"
echo "$sqlB64" | base64 -d > "`$TMP"
psql -h "`$DB_HOST" -p "`$DB_PORT" -U "`$DB_USER" -d "`$DB_NAME" -v ON_ERROR_STOP=1 -f "`$TMP"
rm -f "`$TMP"
unset PGPASSWORD DB_PASS DB_SECRET_JSON
echo ">> Integration test RDS cleanup completed."
"@
$remoteScript = $remoteScript -replace "`r`n", "`n"

$paramsJson = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 10 -Compress
$paramsFile = [System.IO.Path]::GetTempFileName()

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($paramsFile, $paramsJson, $utf8NoBom)

    Write-Host ">> Sending cleanup command to bastion via SSM..."
    $cmdId = (aws ssm send-command `
        --region $Region `
        --document-name 'AWS-RunShellScript' `
        --instance-ids $bastionId `
        --comment 'Jale integration test RDS cleanup' `
        --parameters "file://$paramsFile" `
        --query 'Command.CommandId' `
        --output text).Trim()
}
finally {
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
}

Write-Host "   CommandId: $cmdId"
Write-Host ">> Waiting for command to complete..."
$terminalStates = @('Failed', 'Cancelled', 'TimedOut')
while ($true) {
    Start-Sleep -Seconds 5
    $status = (aws ssm list-command-invocations `
        --region $Region `
        --command-id $cmdId `
        --details `
        --query 'CommandInvocations[0].Status' `
        --output text 2>$null).Trim()

    if ($status -eq 'Success') { break }
    if ($terminalStates -contains $status) {
        Write-Host "!! Command ended with status: $status" -ForegroundColor Red
        aws ssm list-command-invocations `
            --region $Region `
            --command-id $cmdId `
            --details `
            --query 'CommandInvocations[0].CommandPlugins[0].{Status:Status,Out:Output}' `
            --output json
        exit 1
    }
}

Write-Host ">> Final bastion stdout:"
aws ssm list-command-invocations `
    --region $Region `
    --command-id $cmdId `
    --details `
    --query 'CommandInvocations[0].CommandPlugins[0].Output' `
    --output text
