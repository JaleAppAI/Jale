#!/usr/bin/env pwsh
#
# deploy-frontend.ps1 - Build, push, and deploy the Jale frontend through CDK.
#
# CDK does the heavy lifting: it builds frontend/Dockerfile, pushes the image
# to ECR, and updates the Lambda function. After that, this script optionally
# invalidates CloudFront so users see the new build immediately.
#
# Usage:
#   .\deploy-frontend.ps1
#   .\deploy-frontend.ps1 -DistributionId E1A2B3C4D5
#   .\deploy-frontend.ps1 -Profile YourProfileName -SurveyOriginDomain d1a2b3.amplifyapp.com

param(
    [Parameter(Mandatory=$false)]
    [string]$Profile = "",

    [Parameter(Mandatory=$false)]
    [string]$DistributionId = "",

    [Parameter(Mandatory=$false)]
    [string]$SurveyOriginDomain = "",

    [Parameter(Mandatory=$false)]
    [string]$WorkerPoolId = "",

    [Parameter(Mandatory=$false)]
    [string]$WorkerClientId = "",

    [Parameter(Mandatory=$false)]
    [string]$EmployerPoolId = "",

    [Parameter(Mandatory=$false)]
    [string]$EmployerClientId = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipInvalidation
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Invoke-Aws {
    param([string[]]$Arguments)

    $ArgsWithProfile = @($Arguments)
    if (-not [string]::IsNullOrWhiteSpace($Profile)) {
        $ArgsWithProfile += @("--profile", $Profile)
    }

    aws @ArgsWithProfile
}

function Invoke-Cdk {
    param([string[]]$Arguments)

    if (Get-Command npx -ErrorAction SilentlyContinue) {
        npx cdk @Arguments
        return
    }

    $LocalCdk = Join-Path $RepoRoot "infra\node_modules\.bin\cdk.cmd"
    if (Test-Path $LocalCdk) {
        & $LocalCdk @Arguments
        return
    }

    throw "CDK CLI not found. Install npm/npx or run npm install in infra."
}

function Get-AuthLabel {
    if (-not [string]::IsNullOrWhiteSpace($Profile)) {
        return "profile '$Profile'"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:AWS_PROFILE)) {
        return "AWS_PROFILE '$env:AWS_PROFILE'"
    }
    return "default AWS credentials"
}

Write-Host "Deploying Jale frontend through CDK (Lambda + CloudFront)" -ForegroundColor Cyan
Write-Host "Auth:     $(Get-AuthLabel)"

try {
    docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker info failed" }
} catch {
    Write-Host "Docker is not running. Start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

$ctxArgs = @()
if ($SurveyOriginDomain) {
    $ctxArgs += "-c"
    $ctxArgs += "surveyOriginDomain=$SurveyOriginDomain"
}

$frontendConfig = @{
    workerPoolId = if ($WorkerPoolId) { $WorkerPoolId } else { $env:JALE_WORKER_POOL_ID }
    workerClientId = if ($WorkerClientId) { $WorkerClientId } else { $env:JALE_WORKER_CLIENT_ID }
    employerPoolId = if ($EmployerPoolId) { $EmployerPoolId } else { $env:JALE_EMPLOYER_POOL_ID }
    employerClientId = if ($EmployerClientId) { $EmployerClientId } else { $env:JALE_EMPLOYER_CLIENT_ID }
}

$missingFrontendConfig = @(
    if ([string]::IsNullOrWhiteSpace($frontendConfig.workerPoolId)) { "workerPoolId / JALE_WORKER_POOL_ID" }
    if ([string]::IsNullOrWhiteSpace($frontendConfig.workerClientId)) { "workerClientId / JALE_WORKER_CLIENT_ID" }
    if ([string]::IsNullOrWhiteSpace($frontendConfig.employerPoolId)) { "employerPoolId / JALE_EMPLOYER_POOL_ID" }
    if ([string]::IsNullOrWhiteSpace($frontendConfig.employerClientId)) { "employerClientId / JALE_EMPLOYER_CLIENT_ID" }
)

if ($missingFrontendConfig.Count -gt 0) {
    Write-Host "Missing frontend Cognito build config:" -ForegroundColor Red
    $missingFrontendConfig | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Pass these as script parameters or set the matching JALE_* environment variables." -ForegroundColor Yellow
    exit 1
}

foreach ($item in $frontendConfig.GetEnumerator()) {
    $ctxArgs += "-c"
    $ctxArgs += "$($item.Key)=$($item.Value)"
}

$profileArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    $profileArgs += "--profile"
    $profileArgs += $Profile
}

Push-Location (Join-Path $RepoRoot "infra")
$CdkOutputDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jale-cdk.out-" + [guid]::NewGuid().ToString("N"))
try {
    Write-Host ""
    Write-Host "Running cdk deploy JaleFrontendStack..." -ForegroundColor Cyan
    Write-Host "CDK builds Docker image, pushes to ECR, and updates Lambda."

    $cdkArgs = @("deploy", "JaleFrontendStack") + $profileArgs + @("--require-approval=never", "--output", $CdkOutputDir) + $ctxArgs
    Invoke-Cdk $cdkArgs

    if ($LASTEXITCODE -ne 0) {
        throw "cdk deploy failed (exit code $LASTEXITCODE)"
    }
} finally {
    Pop-Location
    if (Test-Path $CdkOutputDir) {
        try {
            Remove-Item -LiteralPath $CdkOutputDir -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host "Warning: could not remove temporary CDK output at $CdkOutputDir" -ForegroundColor Yellow
        }
    }
}

if (-not $SkipInvalidation -and $DistributionId) {
    Write-Host ""
    Write-Host "Invalidating CloudFront cache for $DistributionId..." -ForegroundColor Cyan
    Invoke-Aws @(
        "cloudfront", "create-invalidation",
        "--distribution-id", $DistributionId,
        "--paths", "/*"
    )

    if ($LASTEXITCODE -ne 0) {
        Write-Host "Invalidation failed. Deploy still succeeded; cache may take up to 1 hour to expire." -ForegroundColor Yellow
    } else {
        Write-Host "CloudFront cache invalidated" -ForegroundColor Green
    }
}

$ProfileArg = ""
if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    $ProfileArg = " --profile $Profile"
}

Write-Host ""
Write-Host "Deployment complete" -ForegroundColor Green
Write-Host "Verify: https://jaleapp.ai"
Write-Host "Tail logs: aws logs tail /aws/lambda/jale-frontend-nextjs$ProfileArg --follow"
