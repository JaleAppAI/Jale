#!/usr/bin/env pwsh
#
# deploy-frontend.ps1 — Build, push, and deploy the Jale frontend.
#
# CDK does the heavy lifting: it builds frontend/Dockerfile, pushes the image
# to ECR, and updates the Lambda function. After that, we optionally invalidate
# CloudFront so users see the new build immediately.
#
# Usage:
#   .\deploy-frontend.ps1                                       # default profile + no invalidation
#   .\deploy-frontend.ps1 -DistributionId E1A2B3C4D5            # auto-invalidate after deploy
#   .\deploy-frontend.ps1 -Profile IvanJale -SurveyOriginDomain d1a2b3.amplifyapp.com
#

param(
    [Parameter(Mandatory=$false)]
    [string]$Profile = "IvanJale",

    [Parameter(Mandatory=$false)]
    [string]$DistributionId = "",

    [Parameter(Mandatory=$false)]
    [string]$SurveyOriginDomain = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipInvalidation
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

Write-Host "🚀 Deploying Jale frontend (Lambda + CloudFront)" -ForegroundColor Cyan
Write-Host "Profile:  $Profile"

# Sanity: Docker daemon must be running (CDK builds the container image)
try {
    docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw }
} catch {
    Write-Host "❌ Docker is not running. Start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

# Build CDK context arguments
$ctxArgs = @()
if ($SurveyOriginDomain) {
    $ctxArgs += "-c"
    $ctxArgs += "surveyOriginDomain=$SurveyOriginDomain"
}

Push-Location (Join-Path $RepoRoot "infra")
try {
    Write-Host "`n📦 Running cdk deploy JaleFrontendStack..." -ForegroundColor Cyan
    Write-Host "    (CDK builds Docker image, pushes to ECR, updates Lambda)"

    npx cdk deploy JaleFrontendStack `
        --profile $Profile `
        --require-approval=never `
        @ctxArgs

    if ($LASTEXITCODE -ne 0) {
        throw "cdk deploy failed (exit code $LASTEXITCODE)"
    }
} finally {
    Pop-Location
}

# Optional cache invalidation
if (-not $SkipInvalidation -and $DistributionId) {
    Write-Host "`n🔄 Invalidating CloudFront cache for $DistributionId..." -ForegroundColor Cyan
    aws cloudfront create-invalidation `
        --profile $Profile `
        --distribution-id $DistributionId `
        --paths "/*"

    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️  Invalidation failed (deploy still succeeded; cache may take up to 1h to expire)" -ForegroundColor Yellow
    } else {
        Write-Host "✅ CloudFront cache invalidated" -ForegroundColor Green
    }
}

Write-Host "`n✅ Deployment complete" -ForegroundColor Green
Write-Host "Verify: https://jaleapp.ai"
Write-Host "Tail logs: aws logs tail /aws/lambda/jale-frontend-nextjs --profile $Profile --follow"
