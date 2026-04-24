# cleanup-whatsapp-rds-user.ps1
#
# Deletes one worker from RDS so you can retest the WhatsApp onboarding flow
# for that phone number. This branch's bastion does not have NAT, so the
# script opens an SSM tunnel through the bastion and runs psql locally.

[CmdletBinding()]
param(
    [string]$Phone,
    [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { 'us-east-2' }),
    [string]$PsqlPath
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'
$LocalPort = 5432
$RemotePort = 5432

function Get-RequiredCommand {
    param([string]$Name, [string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path $ExplicitPath)) {
            throw "Provided $Name path does not exist: $ExplicitPath"
        }
        return $ExplicitPath
    }

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    throw "$Name was not found. Install it locally or pass -PsqlPath."
}

function Test-TcpPort {
    param([string]$HostName, [int]$Port)

    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(1000)) {
            $client.Close()
            return $false
        }
        $client.EndConnect($iar)
        $client.Close()
        return $true
    }
    catch {
        return $false
    }
}

function Start-BastionTunnel {
    param([string]$BastionId, [string]$RemoteHost)

    $stdout = Join-Path $env:TEMP 'jale-bastion-tunnel.out.log'
    $stderr = Join-Path $env:TEMP 'jale-bastion-tunnel.err.log'
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

    $args = @(
        'ssm', 'start-session',
        '--target', $BastionId,
        '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
        '--parameters', ("{""host"":[""{0}""],""portNumber"":[""{1}""],""localPortNumber"":[""{2}""]}" -f $RemoteHost, $RemotePort, $LocalPort),
        '--region', $Region
    )

    $proc = Start-Process -FilePath 'aws' -ArgumentList $args -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $errText = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { '' }
            $outText = if (Test-Path $stdout) { Get-Content $stdout -Raw } else { '' }
            throw "Failed to start bastion tunnel.`n$outText`n$errText"
        }

        if (Test-TcpPort -HostName '127.0.0.1' -Port $LocalPort) {
            return $proc
        }

        Start-Sleep -Seconds 1
    }

    throw "Timed out waiting for the SSM tunnel on 127.0.0.1:$LocalPort."
}

if ([string]::IsNullOrWhiteSpace($Phone)) {
    $Phone = Read-Host 'Enter worker phone number to delete from RDS (E.164, example +19152272188)'
}

$Phone = $Phone.Trim()

if ($Phone -notmatch '^\+\d{8,15}$') {
    throw 'Phone must be E.164 format, for example +19152272188.'
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

if ([string]::IsNullOrWhiteSpace($bastionId) -or $bastionId -eq 'None') {
    throw "Could not find BastionInstanceId output on $BastionStack. Deploy it first: cd infra; npx cdk deploy $BastionStack"
}
Write-Host "   bastion: $bastionId"

Write-Host ">> Resolving DB secret ARN..."
$dbSecretArn = (aws cloudformation describe-stack-resources `
    --stack-name $DatabaseStack `
    --region $Region `
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId" `
    --output text).Trim()

if ([string]::IsNullOrWhiteSpace($dbSecretArn)) {
    throw "Could not find DB secret in $DatabaseStack."
}
Write-Host "   db-secret: $dbSecretArn"

Write-Host ">> Reading database connection details..."
$secretJson = (aws secretsmanager get-secret-value `
    --secret-id $dbSecretArn `
    --region $Region `
    --query SecretString `
    --output text).Trim()

$secret = $secretJson | ConvertFrom-Json
$dbHost = [string]$secret.host
$dbPort = [string]$secret.port
$dbName = if ($secret.dbname) { [string]$secret.dbname } else { 'jale' }
$dbUser = [string]$secret.username
$dbPass = [string]$secret.password

if ([string]::IsNullOrWhiteSpace($dbHost) -or [string]::IsNullOrWhiteSpace($dbUser) -or [string]::IsNullOrWhiteSpace($dbPass)) {
    throw 'DB secret JSON did not include host/username/password.'
}

$psql = Get-RequiredCommand -Name 'psql' -ExplicitPath $PsqlPath

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

$sqlPath = Join-Path $env:TEMP 'jale-cleanup-whatsapp-user.sql'
[System.IO.File]::WriteAllText($sqlPath, $sql, [System.Text.UTF8Encoding]::new($false))

$tunnelProc = $null
$env:PGPASSWORD = $dbPass

try {
    Write-Host '>> Starting SSM tunnel through bastion...'
    $tunnelProc = Start-BastionTunnel -BastionId $bastionId -RemoteHost $dbHost
    Write-Host "   tunnel active: 127.0.0.1:$LocalPort -> $dbHost:$RemotePort"

    & $psql -h 127.0.0.1 -p $LocalPort -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $sqlPath
    if ($LASTEXITCODE -ne 0) {
        throw 'psql failed while cleaning the WhatsApp worker.'
    }
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item $sqlPath -Force -ErrorAction SilentlyContinue

    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ">> WhatsApp RDS user cleanup completed for $Phone."
