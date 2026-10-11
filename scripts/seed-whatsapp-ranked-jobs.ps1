# seed-whatsapp-ranked-jobs.ps1
#
# Seeds a fake employer plus active jobs derived from the selected worker's
# current profile. Runs through JaleBastionStack via SSM, using the
# JaleDatabaseStack admin secret. No local psql or DB credentials required.
#
# Usage:
#   cd infra; npx cdk deploy JaleBastionStack
#   cd ..
#   .\scripts\seed-whatsapp-ranked-jobs.ps1 -Phone 9152272188
#   .\scripts\seed-whatsapp-ranked-jobs.ps1 -WorkerId <worker-users-id>
#   .\scripts\seed-whatsapp-ranked-jobs.ps1 -Phone 9152272188 -AlsoSeedJobCandidates

[CmdletBinding()]
param(
  [string]$Phone,
  [string]$WorkerId,
  [switch]$AlsoSeedJobCandidates,
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
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }

  $clean = $Value.Trim()
  $clean = $clean -replace '^whatsapp:', ''
  $clean = $clean -replace '[\s().-]', ''

  if ($clean -notmatch '^\+?\d{8,15}$') {
    throw 'Phone must contain 8-15 digits, for example 9152272188 or +19152272188.'
  }

  if ($clean.StartsWith('+')) {
    return $clean
  }

  if ($clean.Length -eq 10) {
    return "+1$clean"
  }

  return "+$clean"
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

function Escape-SqlLiteral {
  param([string]$Value)
  return ($Value -replace "'", "''")
}

$PhoneE164 = Normalize-Phone $Phone
$PhoneBare = if ($PhoneE164) { $PhoneE164.TrimStart('+') } else { '' }
$PhoneLocal = if ($PhoneBare.StartsWith('1') -and $PhoneBare.Length -eq 11) { $PhoneBare.Substring(1) } else { $PhoneBare }
$PhoneWhatsapp = if ($PhoneE164) { "whatsapp:$PhoneE164" } else { '' }
$WorkerIdSql = Escape-SqlLiteral $WorkerId
$PhoneE164Sql = Escape-SqlLiteral $PhoneE164
$PhoneBareSql = Escape-SqlLiteral $PhoneBare
$PhoneLocalSql = Escape-SqlLiteral $PhoneLocal
$PhoneWhatsappSql = Escape-SqlLiteral $PhoneWhatsapp
$AlsoSeedJobCandidatesSql = if ($AlsoSeedJobCandidates) { 'true' } else { 'false' }

Write-Host ">> Using region: $Region"
if ($PhoneE164) {
  Write-Host ">> Looking up worker by phone variants: $PhoneE164 / $PhoneBare / $PhoneLocal"
}

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
\pset format aligned
SET row_security = off;

DO `$`$
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'jobs table does not exist. Apply migrations first.';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users table does not exist. Apply migrations first.';
  END IF;
  IF to_regclass('public.worker_profiles') IS NULL THEN
    RAISE EXCEPTION 'worker_profiles table does not exist. Apply migrations first.';
  END IF;
  IF to_regclass('public.whatsapp_outbox') IS NULL THEN
    RAISE EXCEPTION 'whatsapp_outbox table does not exist. Apply WhatsApp migrations first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = ANY (current_schemas(false))
      AND table_name = 'whatsapp_outbox'
      AND column_name = 'content_template'
  ) THEN
    RAISE EXCEPTION 'whatsapp_outbox.content_template is missing. Apply migration 013_whatsapp_template_outbox.sql first.';
  END IF;
END;
`$`$;

CREATE TEMP TABLE _target_worker(id uuid PRIMARY KEY, label text);

INSERT INTO _target_worker(id, label)
SELECT id, COALESCE(full_name, phone, whatsapp_number, cognito_sub) AS label
FROM users
WHERE '$WorkerIdSql' <> ''
  AND id = NULLIF('$WorkerIdSql', '')::uuid
  AND user_type = 'worker'
ON CONFLICT DO NOTHING;

INSERT INTO _target_worker(id, label)
SELECT id, COALESCE(full_name, phone, whatsapp_number, cognito_sub) AS label
FROM users
WHERE '$PhoneE164Sql' <> ''
  AND user_type = 'worker'
  AND (
    regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') IN ('$PhoneBareSql', '$PhoneLocalSql')
    OR regexp_replace(COALESCE(whatsapp_number, ''), '[^0-9]', '', 'g') IN ('$PhoneBareSql', '$PhoneLocalSql')
    OR phone IN ('$PhoneE164Sql', '$PhoneBareSql', '$PhoneLocalSql', '$PhoneWhatsappSql')
    OR whatsapp_number IN ('$PhoneE164Sql', '$PhoneBareSql', '$PhoneLocalSql', '$PhoneWhatsappSql')
  )
ORDER BY updated_at DESC NULLS LAST
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO _target_worker(id, label)
SELECT id, COALESCE(full_name, phone, whatsapp_number, cognito_sub) AS label
FROM users
WHERE '$WorkerIdSql' = ''
  AND '$PhoneE164Sql' = ''
  AND user_type = 'worker'
  AND (
    NULLIF(main_trade_other, '') IS NOT NULL
    OR NULLIF(main_trade, '') IS NOT NULL
  )
ORDER BY updated_at DESC NULLS LAST
LIMIT 1
ON CONFLICT DO NOTHING;

DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _target_worker) THEN
    RAISE EXCEPTION 'No worker found for the supplied phone or worker id.';
  END IF;
END;
`$`$;

CREATE TEMP TABLE _target_profile AS
SELECT
  tw.id AS worker_id,
  tw.label,
  COALESCE(
    NULLIF(u.main_trade_other, ''),
    NULLIF(CASE WHEN u.main_trade IS NOT NULL AND u.main_trade <> 'other' THEN u.main_trade ELSE NULL END, ''),
    NULLIF((SELECT string_agg(ws.skill, ' ' ORDER BY ws.skill) FROM worker_skills ws WHERE ws.worker_id = u.id), ''),
    'general labor'
  ) AS profile_profession,
  COALESCE(NULLIF(wp.location, ''), NULLIF(u.city, ''), 'El Paso, TX') AS profile_location,
  COALESCE(NULLIF(wp.availability, ''), NULLIF(u.availability, ''), 'full_time') AS profile_availability
FROM _target_worker tw
JOIN users u ON u.id = tw.id
LEFT JOIN worker_profiles wp ON wp.user_id = u.id;

CREATE TEMP TABLE _employer(id uuid PRIMARY KEY);
INSERT INTO users
  (cognito_sub, user_type, email, full_name, tos_version, tos_accepted_at, privacy_version, privacy_accepted_at)
VALUES
  ('seed-employer-profile-match', 'employer', 'jobs+profile-match@jale.test', 'Jale Profile Match Fixtures', '1.0', now(), '1.0', now())
ON CONFLICT (cognito_sub) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = EXCLUDED.full_name
RETURNING id
\gset seed_employer_

INSERT INTO _employer(id) VALUES (:'seed_employer_id');

CREATE TEMP TABLE _seed_jobs(
  fixture_key text PRIMARY KEY,
  title text NOT NULL,
  location text NOT NULL,
  pay text NOT NULL,
  job_type text NOT NULL,
  description text NOT NULL,
  score smallint NOT NULL,
  desired_rank integer NOT NULL,
  fit text NOT NULL
);

INSERT INTO _seed_jobs(fixture_key, title, location, pay, job_type, description, score, desired_rank, fit)
SELECT
  'profile-primary',
  initcap(profile_profession) || ' Profile Match Crew',
  profile_location,
  '$30-$38/hr',
  CASE WHEN profile_availability = 'part_time' THEN 'part-time' WHEN profile_availability = 'weekends' THEN 'contract' ELSE 'full-time' END,
  'Profile Match role for current worker profile. Work centers on ' || profile_profession || ' tasks, field tools, safety, cleanup, and steady production near ' || profile_location || '.',
  95,
  10,
  'current profile profession and location'
FROM _target_profile
UNION ALL
SELECT
  'profile-experienced',
  'Experienced ' || initcap(profile_profession) || ' - Same Area',
  profile_location,
  '$28-$35/hr',
  'contract',
  'Second profile-derived match for ' || profile_profession || '. The description intentionally repeats the current profile profession so the independent matcher can score it without seeded candidate rows.',
  88,
  20,
  'current profile profession repeated in title and description'
FROM _target_profile
UNION ALL
SELECT
  'profile-helper',
  initcap(profile_profession) || ' Helper - Local Project',
  profile_location,
  '$24-$30/hr',
  'full-time',
  'Local helper opening supporting ' || profile_profession || ' crews with materials, measurements, tools, site prep, and punch-list work.',
  76,
  30,
  'current profile profession with helper seniority'
FROM _target_profile
UNION ALL
SELECT
  'profile-control',
  'Warehouse General Labor Support',
  profile_location,
  '$20-$24/hr',
  'part-time',
  'Control posting for staging materials, sweeping, loading, and general site cleanup. It should not outrank jobs that mention the worker profile profession.',
  30,
  90,
  'location-only control job'
FROM _target_profile;

CREATE TEMP TABLE _seeded_jobs(job_id uuid PRIMARY KEY, fixture_key text, title text, score smallint, desired_rank integer);

DO `$`$
DECLARE
  seed_job record;
  v_employer_id uuid;
  v_worker_id uuid;
  v_job_id uuid;
  rank_to_use integer;
BEGIN
  SELECT id INTO v_employer_id FROM _employer LIMIT 1;
  SELECT worker_id INTO v_worker_id FROM _target_profile LIMIT 1;

  FOR seed_job IN SELECT * FROM _seed_jobs ORDER BY desired_rank LOOP
    SELECT j.id INTO v_job_id
    FROM jobs j
    WHERE j.employer_id = v_employer_id
      AND j.title = seed_job.title
      AND j.location = seed_job.location
    ORDER BY j.created_at DESC
    LIMIT 1;

    IF v_job_id IS NULL THEN
      INSERT INTO jobs (employer_id, title, company, location, pay, job_type, description, status, required_docs)
      VALUES (v_employer_id, seed_job.title, 'Jale Profile Match Fixtures', seed_job.location, seed_job.pay,
              seed_job.job_type, seed_job.description, 'active', '{}')
      RETURNING id INTO v_job_id;
    ELSE
      UPDATE jobs
      SET company = 'Jale Profile Match Fixtures',
          pay = seed_job.pay,
          job_type = seed_job.job_type,
          description = seed_job.description,
          status = 'active',
          required_docs = '{}'
      WHERE id = v_job_id;
    END IF;

    IF $AlsoSeedJobCandidatesSql THEN
      IF to_regclass('public.job_candidates') IS NULL THEN
        RAISE EXCEPTION 'job_candidates table does not exist. Omit -AlsoSeedJobCandidates or apply matching migrations first.';
      END IF;

      DELETE FROM job_candidates jc WHERE jc.job_id = v_job_id AND jc.worker_id = v_worker_id;

      rank_to_use := seed_job.desired_rank;
      WHILE EXISTS (
        SELECT 1 FROM job_candidates jc
        WHERE jc.job_id = v_job_id AND jc.candidate_rank = rank_to_use
      ) LOOP
        rank_to_use := rank_to_use + 1;
      END LOOP;

      INSERT INTO job_candidates (job_id, worker_id, score, score_components, candidate_rank)
      VALUES (
        v_job_id,
        v_worker_id,
        seed_job.score,
        jsonb_build_object('seed', true, 'fixture', seed_job.fixture_key, 'fit', seed_job.fit),
        rank_to_use
      );
    END IF;

    INSERT INTO _seeded_jobs(job_id, fixture_key, title, score, desired_rank)
    VALUES (v_job_id, seed_job.fixture_key, seed_job.title, seed_job.score, seed_job.desired_rank);
  END LOOP;
END;
`$`$;

\echo '=== Target worker ==='
SELECT * FROM _target_worker;

\echo '=== Target profile used for seed ==='
SELECT worker_id, label, profile_profession, profile_location, profile_availability FROM _target_profile;

\echo '=== Seeded employer ==='
SELECT u.id, u.full_name, u.email FROM users u JOIN _employer e ON e.id = u.id;

\echo '=== Profile-derived jobs seeded ==='
SELECT desired_rank, score, title, fixture_key, job_id
FROM _seeded_jobs
ORDER BY desired_rank;

\echo '=== Worker-facing matcher should now score these jobs from profile text, not job_candidates ==='
SELECT title, fixture_key, job_id
FROM _seeded_jobs
ORDER BY desired_rank
LIMIT 5;
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
TMP="/tmp/jale-seed-whatsapp-profile-jobs.sql"
echo "$sqlB64" | base64 -d > "`$TMP"
psql -h "`$DB_HOST" -p "`$DB_PORT" -U "`$DB_USER" -d "`$DB_NAME" -v ON_ERROR_STOP=1 -f "`$TMP"
rm -f "`$TMP"
unset PGPASSWORD DB_PASS DB_SECRET_JSON
echo ">> Profile-derived WhatsApp jobs seed complete."
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
      --comment 'Jale profile-derived WhatsApp jobs seed' `
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
      --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' `
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
