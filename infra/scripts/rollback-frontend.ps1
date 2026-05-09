#!/usr/bin/env pwsh
#
# rollback-frontend.ps1 - Roll back the shared dev frontend Lambda image.
#
# By default this reads .frontend-fast-deploy-last.env written by
# fast-deploy-frontend.ps1 and rolls back to PREVIOUS_IMAGE_URI.
#
# Usage:
#   .\rollback-frontend.ps1
#   .\rollback-frontend.ps1 -CheckOnly
#   .\rollback-frontend.ps1 -ImageUri 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag
#   .\rollback-frontend.ps1 -Profile YourProfileName
#   .\rollback-frontend.ps1 -Yes

param(
    [Parameter(Mandatory=$false)]
    [string]$ImageUri = "",

    [Parameter(Mandatory=$false)]
    [string]$Profile = "",

    [Parameter(Mandatory=$false)]
    [string]$DistributionId = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipInvalidation,

    [Parameter(Mandatory=$false)]
    [switch]$CheckOnly,

    [Parameter(Mandatory=$false)]
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

$StateFile = Join-Path $PSScriptRoot ".frontend-fast-deploy-last.env"
$FunctionName = "jale-frontend-nextjs"
$LambdaRegion = "us-east-1"
$StackName = "JaleFrontendStack"
$State = @{}

function Get-StateFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return @{}
    }

    $Parsed = @{}
    Get-Content $Path | ForEach-Object {
        if ($_ -match '^([^=#]+)=(.*)$') {
            $Parsed[$matches[1]] = $matches[2]
        }
    }
    return $Parsed
}

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

$State = Get-StateFile $StateFile

if ($State.ContainsKey("FUNCTION_NAME") -and $State["FUNCTION_NAME"]) {
    $FunctionName = $State["FUNCTION_NAME"]
}
if ($State.ContainsKey("REGION") -and $State["REGION"]) {
    $LambdaRegion = $State["REGION"]
}
if ($State.ContainsKey("STACK_NAME") -and $State["STACK_NAME"]) {
    $StackName = $State["STACK_NAME"]
}
if (-not $DistributionId -and $State.ContainsKey("DISTRIBUTION_ID")) {
    $DistributionId = $State["DISTRIBUTION_ID"]
}

$UsedStateTarget = $false
if (-not $ImageUri) {
    if (-not $State.ContainsKey("PREVIOUS_IMAGE_URI") -or -not $State["PREVIOUS_IMAGE_URI"]) {
        Write-Host "No rollback image provided and no local rollback state exists." -ForegroundColor Red
        Write-Host "Pass -ImageUri <previous-image-uri>, or run fast-deploy-frontend.ps1 first." -ForegroundColor Yellow
        exit 1
    }
    $ImageUri = $State["PREVIOUS_IMAGE_URI"]
    $UsedStateTarget = $true
}

if ($ImageUri -notmatch '^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/.+(:[^\/:@]+|@sha256:[a-fA-F0-9]{64})$') {
    Write-Host "Image URI does not look like an ECR image URI:" -ForegroundColor Red
    Write-Host $ImageUri
    exit 1
}

Write-Host ""
Write-Host "Preparing frontend rollback" -ForegroundColor Cyan
Write-Host "Auth:     $(Get-AuthLabel)"
Write-Host "Function: $FunctionName"
Write-Host "Region:   $LambdaRegion"
Write-Host "Target:   $ImageUri"

$CurrentImageUri = Invoke-Aws @(
    "lambda", "get-function",
    "--function-name", $FunctionName,
    "--region", $LambdaRegion,
    "--query", "Code.ImageUri",
    "--output", "text"
)

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CurrentImageUri)) {
    Write-Host "Could not retrieve current Lambda image URI." -ForegroundColor Red
    exit 1
}

Write-Host "Current:  $CurrentImageUri"

if ($CurrentImageUri -eq $ImageUri) {
    Write-Host "Current Lambda image already matches the rollback target; nothing to change." -ForegroundColor Yellow
    exit 0
}

if ($UsedStateTarget -and $State.ContainsKey("NEW_IMAGE_URI") -and $State["NEW_IMAGE_URI"] -and $CurrentImageUri -ne $State["NEW_IMAGE_URI"]) {
    Write-Host "Local rollback state is stale: current Lambda image differs from the last fast deploy recorded on this machine." -ForegroundColor Red
    Write-Host "Pass -ImageUri explicitly if you still want to roll back to this target." -ForegroundColor Yellow
    exit 1
}

if (-not $SkipInvalidation -and -not $DistributionId) {
    Write-Host "Looking up CloudFront distribution ID from $StackName..." -ForegroundColor Cyan
    $DistributionId = Invoke-Aws @(
        "cloudformation", "describe-stacks",
        "--stack-name", $StackName,
        "--region", $LambdaRegion,
        "--query", "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue",
        "--output", "text"
    )
}

if (-not $SkipInvalidation) {
    Write-Host "Distribution: $DistributionId"
}

if ($CheckOnly) {
    Write-Host "CheckOnly passed; exiting before Lambda or CloudFront changes." -ForegroundColor Green
    exit 0
}

if (-not $Yes) {
    Write-Host ""
    $Confirmation = Read-Host "Type ROLLBACK to update Lambda to the target image"
    if ($Confirmation -ne "ROLLBACK") {
        Write-Host "Rollback cancelled." -ForegroundColor Yellow
        exit 1
    }
}

Write-Host ""
Write-Host "Updating Lambda function code..." -ForegroundColor Cyan
Invoke-Aws @(
    "lambda", "update-function-code",
    "--function-name", $FunctionName,
    "--image-uri", $ImageUri,
    "--region", $LambdaRegion
) | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "Lambda rollback update failed." -ForegroundColor Red
    exit 1
}

Write-Host "Waiting for Lambda to activate..." -ForegroundColor Cyan
Invoke-Aws @(
    "lambda", "wait", "function-updated-v2",
    "--function-name", $FunctionName,
    "--region", $LambdaRegion
)

if ($LASTEXITCODE -ne 0) {
    Write-Host "Wait timed out. Lambda may still be activating. Check the console." -ForegroundColor Yellow
}

if (-not $SkipInvalidation) {
    if ($DistributionId -and $DistributionId -ne "None") {
        Write-Host "Invalidating CloudFront cache ($DistributionId)..." -ForegroundColor Cyan
        Invoke-Aws @(
            "cloudfront", "create-invalidation",
            "--distribution-id", $DistributionId,
            "--paths", "/*"
        ) | Out-Null
    } else {
        Write-Host "No distribution ID found; skipping cache invalidation." -ForegroundColor Yellow
    }
}

$RolledBackAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$StateLines = @(
    "DEPLOYED_AT_UTC=$RolledBackAtUtc",
    "FUNCTION_NAME=$FunctionName",
    "REGION=$LambdaRegion",
    "STACK_NAME=$StackName",
    "DISTRIBUTION_ID=$DistributionId",
    "PREVIOUS_IMAGE_URI=$CurrentImageUri",
    "NEW_IMAGE_URI=$ImageUri",
    "ROLLBACK=true"
)
Set-Content -Path $StateFile -Value $StateLines -Encoding ASCII

Write-Host ""
Write-Host "Rollback complete" -ForegroundColor Green
Write-Host "New current image: $ImageUri"
Write-Host "Previous image before rollback: $CurrentImageUri"
