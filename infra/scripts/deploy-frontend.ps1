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

$profileArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    $profileArgs += "--profile"
    $profileArgs += $Profile
}

Push-Location (Join-Path $RepoRoot "infra")
try {
    Write-Host ""
    Write-Host "Running cdk deploy JaleFrontendStack..." -ForegroundColor Cyan
    Write-Host "CDK builds Docker image, pushes to ECR, and updates Lambda."

    npx cdk deploy JaleFrontendStack `
        @profileArgs `
        --require-approval=never `
        @ctxArgs

    if ($LASTEXITCODE -ne 0) {
        throw "cdk deploy failed (exit code $LASTEXITCODE)"
    }
} finally {
    Pop-Location
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
