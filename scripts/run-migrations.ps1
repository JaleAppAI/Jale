# run-migrations.ps1 - Apply DB migrations through the bastion using an
# SSM port-forward tunnel, then run psql locally.
#
# This branch's bastion does NOT have NAT, so it cannot install psql on boot.
# Instead, the bastion is only a tunnel target and the machine running this
# script must have a local psql client available.
#
# Usage:
#   .\scripts\run-migrations.ps1
#   .\scripts\run-migrations.ps1 -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'

[CmdletBinding()]
param(
    [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { 'us-east-2' }),
    [string]$PsqlPath
)

$ErrorActionPreference = 'Stop'

$BastionStack = 'JaleBastionStack'
$DatabaseStack = 'JaleDatabaseStack'
$LocalPort = 5432
$RemotePort = 5432

$MigrationFiles = @(
    '001_initial_schema.sql',
    '002_rls_policies.sql',
    '003_jobs_and_applications.sql',
    '004_document_vault.sql',
    '005_worker_marketplace.sql'
)

$MigrationDir = (Resolve-Path (Join-Path $PSScriptRoot '..\infra\db\migrations')).Path

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
    param(
        [string]$HostName,
        [int]$Port
    )

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
    param(
        [string]$BastionId,
        [string]$RemoteHost
    )

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

Write-Host ">> Using region: $Region"

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
    throw "DB secret JSON did not include host/username/password."
}

foreach ($f in $MigrationFiles) {
    $p = Join-Path $MigrationDir $f
    if (-not (Test-Path $p)) {
        throw "Migration file missing: $p"
    }
}

$psql = Get-RequiredCommand -Name 'psql' -ExplicitPath $PsqlPath

$tunnelProc = $null
$env:PGPASSWORD = $dbPass

try {
    Write-Host ">> Starting SSM tunnel through bastion..."
    $tunnelProc = Start-BastionTunnel -BastionId $bastionId -RemoteHost $dbHost
    Write-Host "   tunnel active: 127.0.0.1:$LocalPort -> $dbHost:$RemotePort"

    foreach ($f in $MigrationFiles) {
        $path = Join-Path $MigrationDir $f
        Write-Host "   -> $f"
        & $psql -h 127.0.0.1 -p $LocalPort -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $path
        if ($LASTEXITCODE -ne 0) {
            throw "psql failed while applying $f"
        }
    }

    Write-Host ">> Migrations applied cleanly."
}
finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host ">> All done. Next:"
Write-Host "   npx cdk destroy JaleBastionStack    # cost hygiene"
