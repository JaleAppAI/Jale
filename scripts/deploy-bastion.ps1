#!/usr/bin/env pwsh
#
# Deploy JaleBastionStack without synthesizing the AI / app stacks.
#
# This avoids unrelated Lambda bundling work when the only goal is to bring up
# the temporary migration bastion, and keeps CDK output out of the repo tree so
# Windows Defender is less likely to lock cdk.out.

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '..\.tmp\jale-cdk-out-bastion'

Push-Location (Join-Path $PSScriptRoot '..\infra')
try {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    npx cdk -c bastionOnly=true deploy JaleBastionStack --exclusively -o $outDir --require-approval never
    if ($LASTEXITCODE -ne 0) {
        throw "CDK bastion deployment failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
