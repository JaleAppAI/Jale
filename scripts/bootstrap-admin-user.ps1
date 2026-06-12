# Creates or updates one Cognito administrator, assigns exactly one admin role,
# and upserts the matching admin_users database record through the SSM bastion.
# Cognito emails the temporary password; this script never handles or prints it.

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
    [string]$Email,

    [ValidateSet('admin_readonly', 'admin_ops', 'admin_superadmin')]
    [string]$Role = 'admin_superadmin',

    [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { 'us-east-2' })
)

$ErrorActionPreference = 'Stop'
$AdminStack = 'JaleAdminStack'
$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'

$poolId = aws cloudformation describe-stacks `
    --region $Region `
    --stack-name $AdminStack `
    --query "Stacks[0].Outputs[?OutputKey=='AdminUserPoolId'].OutputValue | [0]" `
    --output text
$poolId = $poolId.Trim()
if (-not $poolId -or $poolId -eq 'None') {
    throw "AdminUserPoolId is missing from $AdminStack."
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
aws cognito-idp admin-get-user --region $Region --user-pool-id $poolId --username $Email *> $null
$userExists = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previousErrorActionPreference

if (-not $userExists) {
    aws cognito-idp admin-create-user `
        --region $Region `
        --user-pool-id $poolId `
        --username $Email `
        --user-attributes "Name=email,Value=$Email" 'Name=email_verified,Value=true' `
        --desired-delivery-mediums EMAIL | Out-Null
} else {
    aws cognito-idp admin-update-user-attributes `
        --region $Region `
        --user-pool-id $poolId `
        --username $Email `
        --user-attributes "Name=email,Value=$Email" 'Name=email_verified,Value=true'
}

foreach ($group in @('admin_readonly', 'admin_ops', 'admin_superadmin')) {
    if ($group -ne $Role) {
        $ErrorActionPreference = 'Continue'
        aws cognito-idp admin-remove-user-from-group `
            --region $Region `
            --user-pool-id $poolId `
            --username $Email `
            --group-name $group 2>$null
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

aws cognito-idp admin-add-user-to-group `
    --region $Region `
    --user-pool-id $poolId `
    --username $Email `
    --group-name $Role

$sub = aws cognito-idp admin-get-user `
    --region $Region `
    --user-pool-id $poolId `
    --username $Email `
    --query "UserAttributes[?Name=='sub'].Value | [0]" `
    --output text
$sub = $sub.Trim()
if (-not $sub -or $sub -eq 'None') {
    throw 'Cognito user does not have a sub claim.'
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

$emailB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Email.ToLowerInvariant()))
$subB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sub))
$roleB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Role))

$remoteScript = @'
#!/bin/bash
set -euo pipefail
REGION="__REGION__"
DB_SECRET_ARN="__DB_SECRET_ARN__"
EMAIL=$(echo "__EMAIL_B64__" | base64 -d)
COGNITO_SUB=$(echo "__SUB_B64__" | base64 -d)
ADMIN_ROLE=$(echo "__ROLE_B64__" | base64 -d)

DB_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
export PGPASSWORD=$(echo "$DB_JSON" | jq -r .password)
DB_HOST=$(echo "$DB_JSON" | jq -r .host)
DB_PORT=$(echo "$DB_JSON" | jq -r .port)
DB_NAME=$(echo "$DB_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$DB_JSON" | jq -r .username)

psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -v admin_email="$EMAIL" -v cognito_sub="$COGNITO_SUB" -v admin_role="$ADMIN_ROLE" <<'SQL'
INSERT INTO admin_users (cognito_sub, admin_email, role, active)
VALUES (:'cognito_sub', :'admin_email', :'admin_role', true)
ON CONFLICT (admin_email) DO UPDATE
SET cognito_sub = EXCLUDED.cognito_sub,
    role = EXCLUDED.role,
    active = true,
    updated_at = NOW();
SQL

unset PGPASSWORD DB_JSON
'@

$remoteScript = $remoteScript `
    -replace '__REGION__', $Region `
    -replace '__DB_SECRET_ARN__', $dbSecretArn `
    -replace '__EMAIL_B64__', $emailB64 `
    -replace '__SUB_B64__', $subB64 `
    -replace '__ROLE_B64__', $roleB64
$remoteScript = $remoteScript -replace "`r`n", "`n"

$parametersPath = [IO.Path]::GetTempFileName()
try {
    $json = @{ commands = @($remoteScript) } | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($parametersPath, $json, (New-Object Text.UTF8Encoding($false)))
    $commandId = aws ssm send-command `
        --region $Region `
        --document-name AWS-RunShellScript `
        --instance-ids $bastionId `
        --comment "Bootstrap Jale administrator $Email" `
        --parameters "file://$parametersPath" `
        --query Command.CommandId `
        --output text
}
finally {
    Remove-Item -LiteralPath $parametersPath -Force -ErrorAction SilentlyContinue
}

aws ssm wait command-executed `
    --region $Region `
    --command-id $commandId `
    --instance-id $bastionId

$result = aws ssm get-command-invocation `
    --region $Region `
    --command-id $commandId `
    --instance-id $bastionId | ConvertFrom-Json

if ($result.Status -ne 'Success') {
    throw $result.StandardErrorContent
}

Write-Host "Administrator provisioned: $Email ($Role)"
Write-Host 'Cognito has emailed the temporary password. First login requires password replacement and TOTP enrollment.'
