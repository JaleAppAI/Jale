# seed-trade-questions.ps1
#
# Idempotently seeds the trade_questions rows for all 5 known blue-collar trades.
# These rows are required for the AI trust scorer to work with standard trades
# (electrician, plumber, carpenter, concrete, painting). Without them the
# handleBuildingTrustSignal code path silently skips scoring.
#
# Requires: JaleBastionStack deployed, JaleDatabaseStack outputs accessible.
# Usage:
#   cd infra; npx cdk deploy JaleBastionStack
#   cd ..
#   .\scripts\seed-trade-questions.ps1

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

Write-Host ">> Using region: $Region"

# ---------------------------------------------------------------------------
# Resolve bastion
# ---------------------------------------------------------------------------
Write-Host ">> Resolving bastion instance ID..."
$bastionId = (aws cloudformation describe-stacks `
    --stack-name $BastionStack `
    --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" `
    --output text).Trim()

if ([string]::IsNullOrEmpty($bastionId) -or $bastionId -eq 'None') {
    Write-Host "!! Could not find BastionInstanceId on $BastionStack." -ForegroundColor Red
    Write-Host "   Deploy first: cd infra; npx cdk deploy $BastionStack"
    exit 1
}
Write-Host "   bastion: $bastionId"

# ---------------------------------------------------------------------------
# Resolve DB secret
# ---------------------------------------------------------------------------
Write-Host ">> Resolving DB secret ARN..."
$dbSecretArn = (aws cloudformation describe-stack-resources `
    --stack-name $DatabaseStack `
    --region $Region `
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && contains(LogicalResourceId, 'DatabaseSecret')].PhysicalResourceId | [0]" `
    --output text).Trim()

if ([string]::IsNullOrEmpty($dbSecretArn) -or $dbSecretArn -eq 'None') {
    Write-Host "!! Could not find DB secret in $DatabaseStack." -ForegroundColor Red
    exit 1
}
Write-Host "   db-secret: $dbSecretArn"

# ---------------------------------------------------------------------------
# SQL: idempotent seed (ON CONFLICT ... DO UPDATE)
# ---------------------------------------------------------------------------
$sql = @'
\pset pager off
SET row_security = off;

DO $$
BEGIN
  IF to_regclass('public.trade_questions') IS NULL THEN
    RAISE EXCEPTION 'trade_questions table does not exist. Apply migration 012_ai_trust_assessment.sql first.';
  END IF;
END;
$$;

INSERT INTO trade_questions (profession_key, profession_raw, questions, is_seeded)
VALUES
  ('electrician', 'electrician', '[
    {"q_en":"What type of electrical work do you specialize in?","q_es":"En que tipo de trabajo electrico te especializas?"},
    {"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"},
    {"q_en":"What tasks do you do most as an electrician?","q_es":"Que tareas realizas con mas frecuencia como electricista?"}
  ]'::jsonb, true),
  ('plumber', 'plumber', '[
    {"q_en":"What type of plumbing work do you specialize in?","q_es":"En que tipo de trabajo de plomeria te especializas?"},
    {"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"},
    {"q_en":"What tasks do you do most as a plumber?","q_es":"Que tareas realizas con mas frecuencia como plomero?"}
  ]'::jsonb, true),
  ('carpenter', 'carpenter', '[
    {"q_en":"What type of carpentry work do you specialize in?","q_es":"En que tipo de trabajo de carpinteria te especializas?"},
    {"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"},
    {"q_en":"What tasks do you do most as a carpenter?","q_es":"Que tareas realizas con mas frecuencia como carpintero?"}
  ]'::jsonb, true),
  ('concrete', 'concrete', '[
    {"q_en":"What type of concrete work do you specialize in?","q_es":"En que tipo de trabajo de concreto te especializas?"},
    {"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"},
    {"q_en":"What tasks do you do most in concrete work?","q_es":"Que tareas realizas con mas frecuencia en trabajo de concreto?"}
  ]'::jsonb, true),
  ('painting', 'painting', '[
    {"q_en":"What type of painting work do you specialize in?","q_es":"En que tipo de trabajo de pintura te especializas?"},
    {"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"},
    {"q_en":"What tasks do you do most as a painter?","q_es":"Que tareas realizas con mas frecuencia como pintor?"}
  ]'::jsonb, true)
ON CONFLICT (profession_key) DO UPDATE
  SET questions  = EXCLUDED.questions,
      is_seeded  = true;

\echo ''
\echo 'Seeded trade_questions rows:'
SELECT profession_key, is_seeded, created_at FROM trade_questions ORDER BY profession_key;
'@

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
TMP="/tmp/jale-seed-trade-questions.sql"
echo "$sqlB64" | base64 -d > "`$TMP"
psql -h "`$DB_HOST" -p "`$DB_PORT" -U "`$DB_USER" -d "`$DB_NAME" -v ON_ERROR_STOP=1 -f "`$TMP"
rm -f "`$TMP"
unset PGPASSWORD DB_PASS DB_SECRET_JSON
echo ">> Seed complete."
"@
$remoteScript = $remoteScript -replace "`r`n", "`n"

$paramsJson = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 10 -Compress
$paramsFile = [System.IO.Path]::GetTempFileName()

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($paramsFile, $paramsJson, $utf8NoBom)

    Write-Host ">> Sending seed command to bastion via SSM..."
    $cmdId = (aws ssm send-command `
        --region $Region `
        --document-name 'AWS-RunShellScript' `
        --instance-ids $bastionId `
        --comment 'Jale trade_questions seed' `
        --parameters "file://$paramsFile" `
        --query 'Command.CommandId' `
        --output text).Trim()
}
finally {
    Remove-Item $paramsFile -Force -ErrorAction SilentlyContinue
}

if ([string]::IsNullOrEmpty($cmdId)) {
    Write-Host "!! Failed to send SSM command." -ForegroundColor Red
    exit 1
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
        aws ssm get-command-invocation `
            --region $Region `
            --command-id $cmdId `
            --instance-id $bastionId `
            --query '{Status:Status,Out:StandardOutput,Err:StandardError}' `
            --output json
        exit 1
    }
}

Write-Host ">> Bastion output:"
aws ssm list-command-invocations `
    --region $Region `
    --command-id $cmdId `
    --details `
    --query 'CommandInvocations[0].CommandPlugins[0].Output' `
    --output text
