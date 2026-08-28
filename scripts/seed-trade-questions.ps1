# seed-trade-questions.ps1
#
# Idempotently seeds the trade_questions rows for all 5 known blue-collar trades.
# These rows are required for the AI trust scorer to work with standard trades
# (electrician, plumber, carpenter, concrete, painting). Without them the
# handleBuildingTrustSignal code path silently skips scoring.
#
# SOURCE OF TRUTH: infra/db/migrations/086_trust_extractions_and_web_onboarding.sql
# Part 4. The five question sets below are a copy of 086's, and this script
# UPSERTs them -- so if they ever drift, an operator rerun silently reverts the
# migration. infra/test/unit/scripts/seed-trade-questions.test.ts parses both
# files and fails on any difference. Edit 086 first, then regenerate here.
#
# The rewrite in 086 replaced the original multiple-choice descriptors (which
# included "What is your seniority level?") with three OPEN questions per
# trade: specialisation + what they did on the last job, how they start an
# unfamiliar site, and a time something went wrong.
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
    {"q_en":"What kind of electrical work do you specialize in, and what did you install or repair on your last job: panels, circuits, fixtures?",
     "q_es":"En que tipo de trabajo electrico te especializas y que instalaste o reparaste en tu ultimo trabajo: tableros, circuitos, luminarias?"},
    {"q_en":"You arrive at a site you have never seen before and the client points at a panel. What is the first thing you do?",
     "q_es":"Llegas a una obra que nunca has visto y el cliente te senala un tablero. Que es lo primero que haces?"},
    {"q_en":"Tell us about a time something went wrong on an electrical job: a short, a failed inspection, a wrong circuit. What happened and what did you do?",
     "q_es":"Cuentanos de una vez que algo salio mal en un trabajo electrico: un corto, una inspeccion reprobada, un circuito equivocado. Que paso y que hiciste?"}
  ]'::jsonb, true),
  ('plumber', 'plumber', '[
    {"q_en":"What kind of plumbing do you specialize in, and what did you rough-in or install on your last job: supply lines, drains, fixtures?",
     "q_es":"En que tipo de plomeria te especializas y que instalaste en tu ultimo trabajo: lineas de agua, drenajes, muebles sanitarios?"},
    {"q_en":"You arrive at a job you have never seen and the owner says there is a leak somewhere. What is the first thing you do?",
     "q_es":"Llegas a un trabajo que nunca has visto y el dueno te dice que hay una fuga en algun lado. Que es lo primero que haces?"},
    {"q_en":"Tell us about a time a plumbing job went wrong: a leak after you finished, a fitting that failed, a line you had to open again. What happened and what did you do?",
     "q_es":"Cuentanos de una vez que un trabajo de plomeria salio mal: una fuga despues de terminar, una conexion que fallo, una linea que tuviste que abrir otra vez. Que paso y que hiciste?"}
  ]'::jsonb, true),
  ('carpenter', 'carpenter', '[
    {"q_en":"What kind of carpentry do you specialize in, and what did you build on your last job: framing, doors, cabinets, finish trim?",
     "q_es":"En que tipo de carpinteria te especializas y que construiste en tu ultimo trabajo: estructura, puertas, gabinetes, acabados?"},
    {"q_en":"You arrive at a site you have never seen with the plans in hand. What is the first thing you do before you cut anything?",
     "q_es":"Llegas a una obra que nunca has visto con los planos en la mano. Que es lo primero que haces antes de cortar algo?"},
    {"q_en":"Tell us about a time a carpentry job went wrong: a bad measurement, warped material, something that did not fit. What happened and what did you do?",
     "q_es":"Cuentanos de una vez que un trabajo de carpinteria salio mal: una medida equivocada, material torcido, algo que no encajo. Que paso y que hiciste?"}
  ]'::jsonb, true),
  ('concrete', 'concrete', '[
    {"q_en":"What kind of concrete work do you specialize in, and what did you form, pour, or finish on your last job?",
     "q_es":"En que tipo de trabajo de concreto te especializas y que cimbraste, colaste o acabaste en tu ultimo trabajo?"},
    {"q_en":"You arrive at a pour you have never seen before. What is the first thing you check before the truck backs in?",
     "q_es":"Llegas a un colado que nunca has visto. Que es lo primero que revisas antes de que se acerque el camion?"},
    {"q_en":"Tell us about a time a pour went wrong: the weather turned, a form moved, a slab cracked. What happened and what did you do?",
     "q_es":"Cuentanos de una vez que un colado salio mal: cambio el clima, se movio una cimbra, se agrieto una losa. Que paso y que hiciste?"}
  ]'::jsonb, true),
  ('painting', 'painting', '[
    {"q_en":"What kind of painting do you specialize in, and what did you prep and coat on your last job: interior walls, exteriors, spray work?",
     "q_es":"En que tipo de pintura te especializas y que preparaste y pintaste en tu ultimo trabajo: paredes interiores, exteriores, trabajo con pistola?"},
    {"q_en":"You arrive at a room you have never seen and the walls are in bad shape. What is the first thing you do?",
     "q_es":"Llegas a un cuarto que nunca has visto y las paredes estan en mal estado. Que es lo primero que haces?"},
    {"q_en":"Tell us about a time a paint job went wrong: peeling, bleed-through, a color the client rejected. What happened and what did you do?",
     "q_es":"Cuentanos de una vez que un trabajo de pintura salio mal: se descarapelo, se transparento, o el cliente rechazo el color. Que paso y que hiciste?"}
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
