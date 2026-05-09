#!/usr/bin/env pwsh
#
# fast-deploy-frontend.ps1 - Deploy frontend code changes without running CDK.
#
# What it does:
#   1. Refuses to deploy if this git checkout is behind its upstream branch
#   2. Reads NEXT_PUBLIC_* vars from frontend/.env.local
#   3. Builds the Docker image locally (linux/amd64)
#   4. Pushes the image to the existing ECR repository used by the Lambda
#   5. Updates the Lambda function in-place
#   6. Invalidates CloudFront so users see the new build immediately
#
# Use this fast path for React components, pages, styles, translations, or
# client logic. Use deploy-frontend.ps1/CDK for infrastructure changes.
#
# Usage:
#   .\fast-deploy-frontend.ps1
#   .\fast-deploy-frontend.ps1 -Profile YourProfileName
#   .\fast-deploy-frontend.ps1 -DistributionId E1A2B3C4D5
#   .\fast-deploy-frontend.ps1 -SkipInvalidation
#   .\fast-deploy-frontend.ps1 -CheckOnly

param(
    [Parameter(Mandatory=$false)]
    [string]$Profile = "",

    [Parameter(Mandatory=$false)]
    [string]$DistributionId = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipInvalidation,

    [Parameter(Mandatory=$false)]
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$FrontendDir = Join-Path $RepoRoot "frontend"
$EnvFile = Join-Path $FrontendDir ".env.local"
$DeployStateFile = Join-Path $PSScriptRoot ".frontend-fast-deploy-last.env"

$LambdaRegion = "us-east-1"
$FunctionName = "jale-frontend-nextjs"
$StackName = "JaleFrontendStack"

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

Write-Host ""
Write-Host "Fast-deploying Jale frontend (Docker -> ECR -> Lambda)" -ForegroundColor Cyan
Write-Host "Auth:     $(Get-AuthLabel)"
Write-Host ""

# Safety gate: do not deploy from a checkout that is behind its upstream.
Write-Host "Checking repository freshness..." -ForegroundColor Cyan

$Branch = git -C $RepoRoot branch --show-current
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Branch)) {
    Write-Host "Failed to determine current git branch." -ForegroundColor Red
    exit 1
}

$Upstream = git -C $RepoRoot rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Upstream)) {
    Write-Host "Current branch '$Branch' has no upstream branch configured." -ForegroundColor Red
    Write-Host "Set one with: git branch --set-upstream-to=origin/$Branch $Branch" -ForegroundColor Yellow
    exit 1
}

git -C $RepoRoot fetch --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to fetch latest remote refs; refusing to deploy without a freshness check." -ForegroundColor Red
    exit 1
}

$AheadBehind = git -C $RepoRoot rev-list --left-right --count 'HEAD...@{u}'
if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to compare local branch with upstream '$Upstream'." -ForegroundColor Red
    exit 1
}

$Counts = $AheadBehind.Trim() -split '\s+'
$Ahead = [int]$Counts[0]
$Behind = [int]$Counts[1]

if ($Behind -gt 0) {
    Write-Host "Refusing to deploy: local branch '$Branch' is behind '$Upstream' by $Behind commit(s)." -ForegroundColor Red
    Write-Host "Run git pull --ff-only, resolve any issues, then deploy again." -ForegroundColor Yellow
    exit 1
}

if ($Ahead -gt 0) {
    Write-Host "Note: local branch is ahead of '$Upstream' by $Ahead commit(s). Deploying code that is not pushed yet." -ForegroundColor Yellow
}

$DirtyStatus = git -C $RepoRoot status --porcelain
$IsDirty = -not [string]::IsNullOrWhiteSpace($DirtyStatus)
if ($IsDirty) {
    Write-Host "Note: working tree has uncommitted changes; deployed image may not match a clean git commit." -ForegroundColor Yellow
}

$ShortSha = git -C $RepoRoot rev-parse --short HEAD
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ShortSha)) {
    Write-Host "Failed to read current git commit." -ForegroundColor Red
    exit 1
}

$ImageTag = "deploy-$ShortSha-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "Branch:   $Branch"
Write-Host "Upstream: $Upstream"
Write-Host "Commit:   $ShortSha"
Write-Host "Tag:      $ImageTag"
Write-Host ""

if ($CheckOnly) {
    Write-Host "CheckOnly passed; exiting before Docker, AWS, or CloudFront changes." -ForegroundColor Green
    exit 0
}

# Docker check
try {
    docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker info failed" }
} catch {
    Write-Host "Docker is not running. Start Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

# Load NEXT_PUBLIC_* from frontend/.env.local
if (-not (Test-Path $EnvFile)) {
    Write-Host "frontend/.env.local not found." -ForegroundColor Red
    Write-Host "Copy frontend/.env.local.example and fill in your values." -ForegroundColor Yellow
    exit 1
}

$BuildArgs = @()
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^(NEXT_PUBLIC_[^=]+)=(.+)$') {
        $Key = $matches[1].Trim()
        $Value = $matches[2].Trim()
        $BuildArgs += "--build-arg"
        $BuildArgs += "${Key}=${Value}"
    }
}

if ($BuildArgs.Count -eq 0) {
    Write-Host "No NEXT_PUBLIC_* variables found in frontend/.env.local." -ForegroundColor Red
    exit 1
}

Write-Host "Loaded $($BuildArgs.Count / 2) NEXT_PUBLIC_* build args from .env.local"

# Get ECR repository URI from the running Lambda.
Write-Host ""
Write-Host "Looking up ECR repository..." -ForegroundColor Cyan

$CurrentImageUri = Invoke-Aws @(
    "lambda", "get-function",
    "--function-name", $FunctionName,
    "--region", $LambdaRegion,
    "--query", "Code.ImageUri",
    "--output", "text"
)

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CurrentImageUri)) {
    Write-Host "Could not retrieve Lambda image URI." -ForegroundColor Red
    Write-Host "Is '$FunctionName' deployed in $LambdaRegion?" -ForegroundColor Yellow
    exit 1
}

if ($CurrentImageUri -match '@') {
    $EcrRepo = ($CurrentImageUri -split '@')[0]
} else {
    $EcrRepo = $CurrentImageUri -replace ':[^:/]+$', ''
}

$EcrEndpoint = ($EcrRepo -split '/')[0]
$NewImageUri = "${EcrRepo}:${ImageTag}"
$LocalTag = "jale-frontend:${ImageTag}"

Write-Host "ECR repo: $EcrRepo"
Write-Host "Current Lambda image: $CurrentImageUri"

# ECR login
Write-Host ""
Write-Host "Logging in to ECR ($EcrEndpoint)..." -ForegroundColor Cyan

Invoke-Aws @(
    "ecr", "get-login-password",
    "--region", $LambdaRegion
) |
    docker login --username AWS --password-stdin $EcrEndpoint

if ($LASTEXITCODE -ne 0) {
    Write-Host "ECR login failed. Check that your profile has ecr:GetAuthorizationToken." -ForegroundColor Red
    exit 1
}

# Build Docker image.
Write-Host ""
Write-Host "Building Docker image..." -ForegroundColor Cyan

docker build `
    --platform linux/amd64 `
    @BuildArgs `
    -t $LocalTag `
    $FrontendDir

if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker build failed." -ForegroundColor Red
    exit 1
}

# Push to ECR.
Write-Host ""
Write-Host "Pushing image to ECR..." -ForegroundColor Cyan

docker tag $LocalTag $NewImageUri
docker push $NewImageUri

if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker push failed. Check that your profile has ecr:PutImage." -ForegroundColor Red
    exit 1
}

# Update Lambda function code.
Write-Host ""
Write-Host "Updating Lambda function..." -ForegroundColor Cyan

Invoke-Aws @(
    "lambda", "update-function-code",
    "--function-name", $FunctionName,
    "--image-uri", $NewImageUri,
    "--region", $LambdaRegion
) | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "Lambda update failed. Check that your profile has lambda:UpdateFunctionCode." -ForegroundColor Red
    exit 1
}

Write-Host "Waiting for Lambda to activate (image pull + warm-up)..." -ForegroundColor Cyan

Invoke-Aws @(
    "lambda", "wait", "function-updated-v2",
    "--function-name", $FunctionName,
    "--region", $LambdaRegion
)

if ($LASTEXITCODE -ne 0) {
    Write-Host "Wait timed out. Lambda may still be activating. Check the console." -ForegroundColor Yellow
} else {
    Write-Host "Lambda active" -ForegroundColor Green
}

# Invalidate CloudFront cache.
if (-not $SkipInvalidation) {
    $DistId = $DistributionId
    if (-not $DistId) {
        Write-Host ""
        Write-Host "Looking up CloudFront distribution ID from $StackName..." -ForegroundColor Cyan
        $DistId = Invoke-Aws @(
            "cloudformation", "describe-stacks",
            "--stack-name", $StackName,
            "--region", $LambdaRegion,
            "--query", "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue",
            "--output", "text"
        )
    }

    if ($DistId -and $DistId -ne "None") {
        Write-Host ""
        Write-Host "Invalidating CloudFront cache ($DistId)..." -ForegroundColor Cyan
        Invoke-Aws @(
            "cloudfront", "create-invalidation",
            "--distribution-id", $DistId,
            "--paths", "/*"
        ) | Out-Null

        if ($LASTEXITCODE -ne 0) {
            Write-Host "Cache invalidation failed. HTML may stay stale for up to 1 hour." -ForegroundColor Yellow
        } else {
            Write-Host "CloudFront cache invalidated" -ForegroundColor Green
        }
    } else {
        Write-Host "No distribution ID found; skipping cache invalidation." -ForegroundColor Yellow
        Write-Host "Pass -DistributionId <id> to force invalidation." -ForegroundColor Yellow
    }
}

$DeployedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$StateLines = @(
    "DEPLOYED_AT_UTC=$DeployedAtUtc",
    "FUNCTION_NAME=$FunctionName",
    "REGION=$LambdaRegion",
    "STACK_NAME=$StackName",
    "DISTRIBUTION_ID=$DistId",
    "PREVIOUS_IMAGE_URI=$CurrentImageUri",
    "NEW_IMAGE_URI=$NewImageUri",
    "GIT_BRANCH=$Branch",
    "GIT_UPSTREAM=$Upstream",
    "GIT_COMMIT=$ShortSha",
    "DIRTY_WORKTREE=$($IsDirty.ToString().ToLowerInvariant())"
)
Set-Content -Path $DeployStateFile -Value $StateLines -Encoding ASCII
Write-Host "Rollback state saved: $DeployStateFile"

Write-Host ""
Write-Host "Fast deploy complete" -ForegroundColor Green
Write-Host "New image: $NewImageUri"
Write-Host "Previous image for rollback: $CurrentImageUri"
Write-Host "Verify:    https://jaleapp.ai"
$ProfileArg = ""
if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    $ProfileArg = " --profile $Profile"
}
Write-Host "Tail logs: aws logs tail /aws/lambda/$FunctionName --region $LambdaRegion$ProfileArg --follow"
