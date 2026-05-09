# cleanup-whatsapp-rds-user.ps1
#
# Deletes one worker from RDS so you can retest the WhatsApp onboarding flow
# for that phone number. This does not delete the Cognito user.
#
# Usage:
#   cd infra
#   npx cdk deploy JaleBastionStack
#   cd ..
#   .\scripts\cleanup-whatsapp-rds-user.ps1
#   # Prompts for the phone number to delete.
#   # Or run non-interactively:
#   .\scripts\cleanup-whatsapp-rds-user.ps1 -Phone '+15551234567'
#   cd infra
#   npx cdk destroy JaleBastionStack

[CmdletBinding()]
param(
  [string]$Phone,
  [string]$Region = $(
    if ($env:AWS_REGION) { $env:AWS_REGION }
    elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION }
    else { 'us-east-2' }
  )
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'

if ([string]::IsNullOrWhiteSpace($Phone)) {
  $Phone = Read-Host 'Enter worker phone number to delete from RDS (E.164, example +19152272188)'
}

$Phone = $Phone.Trim()

if ($Phone -notmatch '^\+\d{8,15}$') {
  throw "Phone must be E.164 format, for example +19152272188."
}

$PhoneSql = $Phone.Replace("'", "''")

Write-Host ">> Using region: $Region"
Write-Host ">> Cleaning RDS WhatsApp worker data for: $Phone"

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

$sql = @"
SET row_security = off;

BEGIN;

CREATE TEMP TABLE cleanup_user_ids AS
SELECT id
FROM users
WHERE user_type = 'worker'
  AND (
    phone = '$PhoneSql'
    OR whatsapp_number = '$PhoneSql'
    OR cognito_sub = '$PhoneSql'
  );

DO `$`$
BEGIN
  IF to_regclass('whatsapp_outbox') IS NOT NULL THEN
    DELETE FROM whatsapp_outbox
    WHERE whatsapp_number = '$PhoneSql'
       OR inbound_message_sid IN (
         SELECT message_sid
         FROM whatsapp_processed_messages
         WHERE whatsapp_number = '$PhoneSql'
       );
  END IF;

  IF to_regclass('whatsapp_processed_messages') IS NOT NULL THEN
    DELETE FROM whatsapp_processed_messages
    WHERE whatsapp_number = '$PhoneSql';
  END IF;

  IF to_regclass('whatsapp_conversations') IS NOT NULL THEN
    DELETE FROM whatsapp_conversations
    WHERE whatsapp_number = '$PhoneSql'
       OR user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('document_upload_tokens') IS NOT NULL THEN
    DELETE FROM document_upload_tokens
    WHERE worker_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('worker_documents') IS NOT NULL THEN
    DELETE FROM worker_documents
    WHERE worker_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('job_applications') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'job_applications' AND column_name = 'user_id'
    ) THEN
      DELETE FROM job_applications
      WHERE user_id IN (SELECT id FROM cleanup_user_ids);
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'job_applications' AND column_name = 'worker_id'
    ) THEN
      DELETE FROM job_applications
      WHERE worker_id IN (SELECT id FROM cleanup_user_ids);
    END IF;
  END IF;

  IF to_regclass('legal_consent_log') IS NOT NULL THEN
    DELETE FROM legal_consent_log
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('worker_profile_ai_extractions') IS NOT NULL THEN
    DELETE FROM worker_profile_ai_extractions
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('worker_profile_media') IS NOT NULL THEN
    DELETE FROM worker_profile_media
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;

  IF to_regclass('worker_profiles') IS NOT NULL THEN
    DELETE FROM worker_profiles
    WHERE user_id IN (SELECT id FROM cleanup_user_ids);
  END IF;
END
`$`$;

DELETE FROM users
WHERE id IN (SELECT id FROM cleanup_user_ids)
   OR (user_type = 'worker' AND cognito_sub = '$PhoneSql');

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
TMP="/tmp/jale-cleanup-whatsapp-user.sql"
echo "$sqlB64" | base64 -d > "`$TMP"
psql -h "`$DB_HOST" -p "`$DB_PORT" -U "`$DB_USER" -d "`$DB_NAME" -v ON_ERROR_STOP=1 -f "`$TMP"
rm -f "`$TMP"
unset PGPASSWORD DB_PASS DB_SECRET_JSON
echo ">> WhatsApp RDS user cleanup completed for $Phone."
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
      --comment "Jale WhatsApp RDS cleanup for $Phone" `
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
