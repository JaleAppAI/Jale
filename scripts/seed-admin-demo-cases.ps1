# Creates repeatable admin-console demo cases linked to an existing worker.
# Existing rows created by this script for the same worker are replaced.

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Phone,

    [string]$AdminEmail = 'luis@jaleapp.ai',

    [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-2' })
)

$ErrorActionPreference = 'Stop'
$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'
$phoneDigits = $Phone -replace '\D', ''

if ($phoneDigits.Length -lt 10) {
    throw 'Phone must contain at least 10 digits.'
}

$bastionId = aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $BastionStack `
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue | [0]" `
    --output text
$bastionId = $bastionId.Trim()

$dbSecretArn = aws cloudformation describe-stack-resources `
    --region $Region `
    --stack-name $DatabaseStack `
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]" `
    --output text
$dbSecretArn = $dbSecretArn.Trim()

if (-not $bastionId -or $bastionId -eq 'None' -or -not $dbSecretArn -or $dbSecretArn -eq 'None') {
    throw 'Unable to resolve the bastion or database secret.'
}

$phoneB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($phoneDigits))
$adminEmailB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($AdminEmail.ToLowerInvariant()))

$remoteScript = @'
#!/bin/bash
set -euo pipefail
REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"
PHONE_DIGITS=$(echo "__PHONE_B64__" | base64 -d)
ADMIN_EMAIL=$(echo "__ADMIN_EMAIL_B64__" | base64 -d)

DB_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
export PGPASSWORD=$(echo "$DB_JSON" | jq -r .password)
DB_HOST=$(echo "$DB_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_JSON" | jq -r .username)
PG=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

MATCH_COUNT=$("${PG[@]}" -At -v phone_digits="$PHONE_DIGITS" <<'SQL'
SELECT COUNT(*)
FROM users
WHERE user_type = 'worker'
  AND (
    right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
    OR right(regexp_replace(COALESCE(whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
  );
SQL
)

if [[ "$MATCH_COUNT" != "1" ]]; then
  echo "Expected exactly one worker for phone ending ${PHONE_DIGITS: -4}; found $MATCH_COUNT."
  "${PG[@]}" -P pager=off -v phone_digits="$PHONE_DIGITS" <<'SQL'
SELECT
  u.id,
  u.user_type,
  u.full_name,
  u.cognito_sub,
  u.phone,
  u.whatsapp_number,
  u.whatsapp_linked_at,
  c.id AS conversation_id,
  c.conversation_state,
  c.updated_at AS conversation_updated_at
FROM users u
LEFT JOIN whatsapp_conversations c ON c.user_id = u.id
WHERE u.user_type = 'worker'
  AND (
    right(regexp_replace(COALESCE(u.phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
    OR right(regexp_replace(COALESCE(u.whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
  )
ORDER BY c.updated_at DESC NULLS LAST, u.whatsapp_linked_at DESC NULLS LAST;
SQL
  exit 1
fi

"${PG[@]}" -v phone_digits="$PHONE_DIGITS" -v admin_email="$ADMIN_EMAIL" <<'SQL'
BEGIN;

WITH target_worker AS (
  SELECT id
  FROM users
  WHERE user_type = 'worker'
    AND (
      right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
      OR right(regexp_replace(COALESCE(whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
    )
  LIMIT 1
)
DELETE FROM admin_cases
WHERE user_id = (SELECT id FROM target_worker)
  AND details->>'demoSeed' = 'admin-worker-live-demo';

WITH target_worker AS (
  SELECT id
  FROM users
  WHERE user_type = 'worker'
    AND (
      right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
      OR right(regexp_replace(COALESCE(whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
    )
  LIMIT 1
),
target_conversation AS (
  SELECT id
  FROM whatsapp_conversations
  WHERE user_id = (SELECT id FROM target_worker)
  ORDER BY updated_at DESC
  LIMIT 1
),
target_admin AS (
  SELECT id
  FROM admin_users
  WHERE lower(admin_email) = lower(:'admin_email')
  LIMIT 1
),
demo_cases(case_type, status, priority, case_number, summary, last_message, notes, verification_status, verification_step, reason) AS (
  VALUES
    ('help_request', 'open', 85, 'DEMO-HELP-001',
     'Worker requested help completing an application',
     'I need help understanding which documents are required.',
     ARRAY['Demo case linked to the live worker account.', 'Use Resolve case to demonstrate queue handling.'],
     NULL, NULL, NULL),
    ('verification_blocker', 'pending_admin', 95, 'DEMO-VERIFY-001',
     'Worker identity verification needs review',
     'My verification is still pending.',
     ARRAY['Demo verification blocker.', 'Approve, reject, request more info, or reset from the verification queue.'],
     'pending', 'identity', 'Uploaded identity details require manual review.'),
    ('outbound_failure', 'open', 70, 'DEMO-OUTBOUND-001',
     'WhatsApp support reply could not be delivered',
     'The last support message failed delivery.',
     ARRAY['Demo outbound delivery failure.', 'Reply and resend remain intentionally disabled in this release.'],
     NULL, NULL, NULL),
    ('conversation_stuck', 'pending_admin', 90, 'DEMO-STUCK-001',
     'Worker conversation appears stuck in onboarding',
     'The worker repeated the same answer without advancing.',
     ARRAY['Demo state-machine escalation.', 'Inspect the linked conversation reference during the demo.'],
     NULL, NULL, NULL)
),
inserted AS (
  INSERT INTO admin_cases (
    case_type, status, priority, user_id, conversation_id, assigned_admin_id,
    summary, details
  )
  SELECT
    d.case_type,
    d.status,
    d.priority,
    w.id,
    c.id,
    a.id,
    d.summary,
    jsonb_strip_nulls(jsonb_build_object(
      'demoSeed', 'admin-worker-live-demo',
      'caseNumber', d.case_number,
      'workerLabel', 'Live demo worker',
      'subjectType', 'worker',
      'lastMessage', d.last_message,
      'notes', to_jsonb(d.notes),
      'verificationStatus', d.verification_status,
      'verificationStep', d.verification_step,
      'reason', d.reason
    ))
  FROM demo_cases d
  CROSS JOIN target_worker w
  LEFT JOIN target_conversation c ON true
  LEFT JOIN target_admin a ON true
  RETURNING id, case_type, summary
)
INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
SELECT
  i.id,
  'case_created',
  CASE WHEN i.case_type = 'help_request' THEN 'worker' ELSE 'system' END,
  CASE WHEN i.case_type = 'help_request' THEN (SELECT id::text FROM target_worker) ELSE 'demo-seeder' END,
  jsonb_build_object(
    'title', CASE WHEN i.case_type = 'help_request' THEN 'Worker requested help' ELSE 'System escalation created' END,
    'detail', i.summary
  )
FROM inserted i;

INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
SELECT
  id,
  'demo_context_added',
  'system',
  'demo-seeder',
  jsonb_build_object(
    'title', 'Demo context prepared',
    'detail', 'This repeatable production demo record is linked to the selected live worker.'
  )
FROM admin_cases
WHERE details->>'demoSeed' = 'admin-worker-live-demo'
  AND user_id = (
    SELECT id
    FROM users
    WHERE user_type = 'worker'
      AND (
        right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
        OR right(regexp_replace(COALESCE(whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
      )
    LIMIT 1
  );

COMMIT;

SELECT
  u.id AS worker_id,
  u.full_name,
  COALESCE(u.whatsapp_number, u.phone) AS matched_phone,
  c.id AS conversation_id,
  COUNT(ac.id) AS demo_case_count
FROM users u
LEFT JOIN whatsapp_conversations c ON c.user_id = u.id
LEFT JOIN admin_cases ac
  ON ac.user_id = u.id
 AND ac.details->>'demoSeed' = 'admin-worker-live-demo'
WHERE u.user_type = 'worker'
  AND (
    right(regexp_replace(COALESCE(u.phone, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
    OR right(regexp_replace(COALESCE(u.whatsapp_number, ''), '\D', '', 'g'), 10) = right(:'phone_digits', 10)
  )
GROUP BY u.id, u.full_name, u.whatsapp_number, u.phone, c.id;
SQL

unset PGPASSWORD DB_JSON
'@

$remoteScript = $remoteScript `
    -replace '__REGION__', $Region `
    -replace '__DB_SECRET_ARN__', $dbSecretArn `
    -replace '__PHONE_B64__', $phoneB64 `
    -replace '__ADMIN_EMAIL_B64__', $adminEmailB64
$remoteScript = $remoteScript -replace "`r`n", "`n"

$parametersPath = [IO.Path]::GetTempFileName()
try {
    $json = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($parametersPath, $json, (New-Object Text.UTF8Encoding($false)))
    $commandId = aws ssm send-command `
        --region $Region `
        --document-name AWS-RunShellScript `
        --instance-ids $bastionId `
        --comment "Seed admin demo cases for phone ending $($phoneDigits.Substring($phoneDigits.Length - 4))" `
        --parameters "file://$parametersPath" `
        --query Command.CommandId `
        --output text
}
finally {
    Remove-Item -LiteralPath $parametersPath -Force -ErrorAction SilentlyContinue
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
aws ssm wait command-executed `
    --region $Region `
    --command-id $commandId `
    --instance-id $bastionId
$ErrorActionPreference = $previousErrorActionPreference

$result = aws ssm get-command-invocation `
    --region $Region `
    --command-id $commandId `
    --instance-id $bastionId | ConvertFrom-Json

if ($result.Status -ne 'Success') {
    Write-Host $result.StandardOutputContent
    throw $result.StandardErrorContent
}

Write-Host $result.StandardOutputContent
Write-Host 'Admin demo cases seeded successfully.'
