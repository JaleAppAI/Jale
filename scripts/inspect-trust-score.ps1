# inspect-trust-score.ps1
#
# Read-only inspector for data created by the WhatsApp trust signal and AI
# trust scorer flows. Runs SQL on JaleBastionStack via SSM, using the
# JaleDatabaseStack admin secret. No local psql or DB credentials required.
#
# Usage:
#   cd infra
#   npx cdk deploy JaleBastionStack
#   cd ..
#   .\scripts\inspect-trust-score.ps1 -Phone 19152272188
#   .\scripts\inspect-trust-score.ps1 -Phone 19152272188 -LogPath .\tmp\trust-score.log
#
# Phone may be passed as 19152272188, +19152272188, or whatsapp:+19152272188.

[CmdletBinding()]
param(
  [string]$Phone,
  [string]$LogPath,
  [string]$Region = $(
    if ($env:AWS_REGION) { $env:AWS_REGION }
    elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION }
    else { 'us-east-2' }
  )
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'

function Normalize-Phone {
  param([Parameter(Mandatory = $true)][string]$Value)

  $clean = $Value.Trim()
  $clean = $clean -replace '^whatsapp:', ''
  $clean = $clean -replace '[\s().-]', ''

  if ($clean -notmatch '^\+?\d{8,15}$') {
    throw 'Phone must contain 8-15 digits, for example 19152272188 or +19152272188.'
  }

  if (-not $clean.StartsWith('+')) {
    $clean = "+$clean"
  }

  return $clean
}

function Invoke-ExternalCommand {
  param([Parameter(Mandatory = $true)][scriptblock]$Command)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
  }
}

function Get-SsmCommandOutput {
  param(
    [Parameter(Mandatory = $true)][string]$CommandId,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$Region
  )

  $stdout = aws ssm get-command-invocation `
    --region $Region `
    --command-id $CommandId `
    --instance-id $InstanceId `
    --query 'StandardOutputContent' `
    --output text

  $stderr = aws ssm get-command-invocation `
    --region $Region `
    --command-id $CommandId `
    --instance-id $InstanceId `
    --query 'StandardErrorContent' `
    --output text

  if ([string]::IsNullOrWhiteSpace($stderr) -or $stderr -eq 'None') {
    return ($stdout | Out-String)
  }

  return (($stdout | Out-String) + [Environment]::NewLine + "=== STDERR ===" + [Environment]::NewLine + ($stderr | Out-String))
}

function Write-InspectionLog {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $resolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  $parent = Split-Path -Parent $resolvedPath
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($resolvedPath, $Content, $utf8NoBom)
  Write-Host ">> Full inspection log written to: $resolvedPath"
}

if ([string]::IsNullOrWhiteSpace($Phone)) {
  $Phone = Read-Host 'Enter worker phone number to inspect, for example +19152272188'
}

$PhoneE164 = Normalize-Phone $Phone
$PhoneBare = $PhoneE164.TrimStart('+')
$PhoneWhatsapp = "whatsapp:$PhoneE164"

Write-Host ">> Using region: $Region"
Write-Host ">> Inspecting trust score data for: $PhoneE164"

Write-Host ">> Resolving bastion instance ID..."
$bastionResult = Invoke-ExternalCommand {
  aws cloudformation describe-stacks `
    --stack-name $BastionStack `
    --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" `
    --output text
}

if ($bastionResult.ExitCode -ne 0) {
  Write-Host "!! Could not describe $BastionStack." -ForegroundColor Red
  Write-Host "   Deploy it first: cd infra; npx cdk deploy $BastionStack"
  Write-Host "   AWS CLI output:" -ForegroundColor Yellow
  Write-Host ($bastionResult.Output | Out-String)
  exit 1
}

$bastionId = ($bastionResult.Output | Out-String).Trim()

if ([string]::IsNullOrEmpty($bastionId) -or $bastionId -eq 'None') {
  Write-Host "!! Could not find BastionInstanceId output on $BastionStack." -ForegroundColor Red
  Write-Host "   Deploy it first: cd infra; npx cdk deploy $BastionStack"
  exit 1
}
Write-Host "   bastion: $bastionId"

Write-Host ">> Resolving DB secret ARN..."
$rawSecretResult = Invoke-ExternalCommand {
  aws cloudformation describe-stack-resources `
    --stack-name $DatabaseStack `
    --region $Region `
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && contains(LogicalResourceId, 'DatabaseSecret')].PhysicalResourceId | [0]" `
    --output text
}

if ($rawSecretResult.ExitCode -ne 0) {
  Write-Host "!! Could not describe $DatabaseStack resources." -ForegroundColor Red
  Write-Host "   AWS CLI output:" -ForegroundColor Yellow
  Write-Host ($rawSecretResult.Output | Out-String)
  exit 1
}

$dbSecretArn = ($rawSecretResult.Output | Out-String).Trim()

if ([string]::IsNullOrEmpty($dbSecretArn) -or $dbSecretArn -eq 'None') {
  Write-Host "!! Could not find DB secret in $DatabaseStack." -ForegroundColor Red
  exit 1
}
Write-Host "   db-secret: $dbSecretArn"

$sql = @"
\pset pager off
\pset null [null]
\pset format unaligned
\pset fieldsep ' | '
SET row_security = off;

-- Collect matching user IDs (phone values embedded as literals)
CREATE TEMP TABLE _uid(id uuid PRIMARY KEY);
INSERT INTO _uid(id)
SELECT id FROM users
WHERE phone IN ('$($PhoneE164.Replace("'","''"))','$($PhoneBare.Replace("'","''"))','$($PhoneWhatsapp.Replace("'","''"))')
   OR whatsapp_number IN ('$($PhoneE164.Replace("'","''"))','$($PhoneBare.Replace("'","''"))','$($PhoneWhatsapp.Replace("'","''"))')
ON CONFLICT DO NOTHING;

INSERT INTO _uid(id)
SELECT DISTINCT user_id FROM whatsapp_conversations
WHERE user_id IS NOT NULL
  AND whatsapp_number IN ('$($PhoneE164.Replace("'","''"))','$($PhoneBare.Replace("'","''"))','$($PhoneWhatsapp.Replace("'","''"))')
ON CONFLICT DO NOTHING;

\echo '=== User + score snapshot ==='
SELECT
  'user' AS row_type,
  u.id,
  u.phone,
  u.whatsapp_number,
  u.full_name,
  u.city,
  u.main_trade,
  u.main_trade_other,
  u.years_experience,
  u.has_transportation,
  u.availability,
  u.trade_competency_score,
  -- users.trust_signals / trust_signals_completed_at (migration 006's v1
  -- trust layer) were DROPPED by migration 092. The v2 equivalents this
  -- script already prints are worker_trust_assessments.answers and the
  -- worker_trust_extractions rows below.
  u.created_at,
  u.updated_at
FROM users u
WHERE u.id IN (SELECT id FROM _uid);

\echo '=== Worker profile row ==='
SELECT
  'worker_profile' AS row_type,
  wp.*
FROM worker_profiles wp
WHERE wp.user_id IN (SELECT id FROM _uid)
ORDER BY wp.updated_at DESC NULLS LAST;

\echo '=== WhatsApp conversation ==='
SELECT
  'conversation' AS row_type,
  wc.id,
  wc.user_id,
  wc.whatsapp_number,
  wc.language,
  wc.conversation_state,
  wc.last_processed_message_sid,
  wc.state_context,
  wc.created_at,
  wc.updated_at
FROM whatsapp_conversations wc
WHERE wc.user_id IN (SELECT id FROM _uid)
   OR wc.whatsapp_number IN ('$($PhoneE164.Replace("'","''"))','$($PhoneBare.Replace("'","''"))','$($PhoneWhatsapp.Replace("'","''"))')
ORDER BY wc.updated_at DESC NULLS LAST;

\echo '=== Trust assessment ==='
SELECT
  'assessment' AS row_type,
  id,
  user_id,
  profession_key,
  status,
  competency_score,
  rubric_version,
  scoring_model_id,
  created_at,
  scored_at
FROM worker_trust_assessments
WHERE user_id IN (SELECT id FROM _uid)
ORDER BY created_at;

\echo '=== Score components ==='
SELECT 'score_components' AS row_type, id, score_components
FROM worker_trust_assessments
WHERE user_id IN (SELECT id FROM _uid)
  AND score_components IS NOT NULL
ORDER BY created_at;

\echo '=== Score rationale ==='
SELECT 'score_rationale' AS row_type, id, score_rationale
FROM worker_trust_assessments
WHERE user_id IN (SELECT id FROM _uid)
  AND score_rationale IS NOT NULL
ORDER BY created_at;

\echo '=== Answers ==='
SELECT 'answers' AS row_type, id, answers
FROM worker_trust_assessments
WHERE user_id IN (SELECT id FROM _uid)
ORDER BY created_at;

\echo '=== Trade question cache ==='
SELECT
  'trade_questions' AS row_type,
  tq.profession_key,
  tq.is_seeded,
  tq.created_at,
  tq.questions
FROM trade_questions tq
WHERE tq.profession_key IN (
  SELECT DISTINCT profession_key
  FROM worker_trust_assessments
  WHERE user_id IN (SELECT id FROM _uid)
)
ORDER BY tq.profession_key;

\echo '=== Profile command trust view ==='
SELECT
  'profile_view' AS row_type,
  u.id AS user_id,
  u.main_trade,
  u.main_trade_other,
  u.trade_competency_score,
  wta.profession_key AS trust_assessment_profession_key,
  wta.status AS trust_assessment_status,
  wta.competency_score AS trust_assessment_score,
  wta.answers AS trust_assessment_answers,
  tq.questions AS trust_assessment_questions
FROM users u
LEFT JOIN LATERAL (
  SELECT profession_key, status, competency_score, answers, created_at
  FROM worker_trust_assessments
  WHERE user_id = u.id
  ORDER BY
    CASE status
      WHEN 'scored' THEN 0
      WHEN 'scoring' THEN 1
      WHEN 'pending' THEN 2
      ELSE 3
    END,
    created_at DESC
  LIMIT 1
) wta ON TRUE
LEFT JOIN trade_questions tq ON tq.profession_key = wta.profession_key
WHERE u.id IN (SELECT id FROM _uid);
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
TMP="/tmp/jale-inspect-trust-score.sql"
echo "$sqlB64" | base64 -d > "`$TMP"
psql -h "`$DB_HOST" -p "`$DB_PORT" -U "`$DB_USER" -d "`$DB_NAME" -v ON_ERROR_STOP=1 -f "`$TMP"
rm -f "`$TMP"
unset PGPASSWORD DB_PASS DB_SECRET_JSON
echo ">> Trust score inspection completed for $PhoneE164."
"@
$remoteScript = $remoteScript -replace "`r`n", "`n"

$paramsJson = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 10 -Compress
$paramsFile = [System.IO.Path]::GetTempFileName()

try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($paramsFile, $paramsJson, $utf8NoBom)

  Write-Host ">> Sending inspection command to bastion via SSM..."
  $cmdId = (aws ssm send-command `
      --region $Region `
      --document-name 'AWS-RunShellScript' `
      --instance-ids $bastionId `
      --comment "Jale trust score inspection for $PhoneE164" `
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
    $failedOutput = Get-SsmCommandOutput -CommandId $cmdId -InstanceId $bastionId -Region $Region
    Write-Host ($failedOutput | Out-String)
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
      $metadata = @(
        "Jale trust score inspection",
        "Generated: $([DateTimeOffset]::Now.ToString('o'))",
        "Region: $Region",
        "Phone: $PhoneE164",
        "Bastion: $bastionId",
        "CommandId: $cmdId",
        "Status: $status",
        ""
      ) -join [Environment]::NewLine
      Write-InspectionLog -Path $LogPath -Content ($metadata + ($failedOutput | Out-String))
    }
    exit 1
  }
}

$inspectionOutput = Get-SsmCommandOutput -CommandId $cmdId -InstanceId $bastionId -Region $Region

Write-Host ">> Final bastion stdout:"
Write-Host ($inspectionOutput | Out-String)

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
  $metadata = @(
    "Jale trust score inspection",
    "Generated: $([DateTimeOffset]::Now.ToString('o'))",
    "Region: $Region",
    "Phone: $PhoneE164",
    "Bastion: $bastionId",
    "CommandId: $cmdId",
    ""
  ) -join [Environment]::NewLine
  Write-InspectionLog -Path $LogPath -Content ($metadata + ($inspectionOutput | Out-String))
}
