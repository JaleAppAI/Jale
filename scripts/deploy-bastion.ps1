#!/usr/bin/env pwsh
#
# Deploy (or destroy) JaleBastionStack without synthesizing the AI / app stacks.
#
# This avoids unrelated Lambda bundling work when the only goal is to bring up
# the temporary migration bastion, and keeps CDK output out of the repo tree so
# Windows Defender is less likely to lock cdk.out.
#
# Usage:
#
#   .\scripts\deploy-bastion.ps1                  # bring the bastion up
#   .\scripts\deploy-bastion.ps1 -Destroy         # tear it down (cost hygiene)
#   .\scripts\deploy-bastion.ps1 -DeploymentEnvironment dev
#
# infra/bin/jale-app.ts requires `-c environment=dev|production` and throws
# CDK_ENVIRONMENT_REQUIRED without it, so this script always passes it. The
# value does not affect the synthesized bastion: `environment` only gates that
# guard and supplies FrontendStack's default apiStageName, and FrontendStack is
# not synthesized under `-c bastionOnly=true`. It defaults to 'production' to
# match docs/production-upgrade-020b-040.md. Stack names are NOT
# environment-suffixed -- JaleBastionStack is the same stack either way -- so
# this flag does not pick between two separate bastions.
#
# `--exclusively` deploys only JaleBastionStack, so bringing the bastion up
# never touches JaleNetworkStack or JaleDatabaseStack even though both are
# synthesized to resolve the cross-stack secret-read grants.

[CmdletBinding()]
param(
    [ValidateSet('dev', 'production')]
    [string]$DeploymentEnvironment = 'production',

    [switch]$Destroy
)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '..\.tmp\jale-cdk-out-bastion'

Push-Location (Join-Path $PSScriptRoot '..\infra')
try {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    if ($Destroy) {
        Write-Host ">> Destroying JaleBastionStack (environment=$DeploymentEnvironment)..."
        npx cdk -c bastionOnly=true -c "environment=$DeploymentEnvironment" destroy JaleBastionStack --exclusively -o $outDir --force
        if ($LASTEXITCODE -ne 0) {
            throw "CDK bastion destroy failed with exit code $LASTEXITCODE."
        }
        Write-Host ">> Bastion destroyed."
    }
    else {
        Write-Host ">> Deploying JaleBastionStack (environment=$DeploymentEnvironment)..."
        npx cdk -c bastionOnly=true -c "environment=$DeploymentEnvironment" deploy JaleBastionStack --exclusively -o $outDir --require-approval never
        if ($LASTEXITCODE -ne 0) {
            throw "CDK bastion deployment failed with exit code $LASTEXITCODE."
        }
        Write-Host ""
        Write-Host ">> Bastion up. Remember to tear it down when finished:"
        Write-Host "     .\scripts\deploy-bastion.ps1 -Destroy"
    }
}
finally {
    Pop-Location
}
