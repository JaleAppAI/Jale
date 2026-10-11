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
#
# AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT (required) is the engine's default
# shared_preload_libraries from the pre-check (`none` when it is empty): the
# same variable the deploy workflow passes as `-c dbSharedPreloadLibrariesDefault`.
# The CDK app will not synthesize production without it, and `cdk destroy`
# synthesizes the app too, so both directions pass it, and the script refuses
# to call CDK at all without it. The refusal names the variable; the value is
# never printed.
#
# WHATSAPP_ALARM_TOPIC_ARN (optional) wires the TTL auto-teardown alarms to a
# real destination, as deploy-bastion.sh does. This is the SAME environment
# variable the deploy workflow already feeds `-c whatsappAlarmTopicArn` from
# (vars.WHATSAPP_ALARM_TOPIC_ARN, see .github/workflows/_reusable-deploy.yml),
# so there is no second convention to remember -- set it and the alarms page
# somebody, leave it unset and they are created without actions. The two
# bastion scripts are the only paths that deploy JaleBastionStack (it is in
# none of the deploy workflow's stack lists), so without it the backstop
# alarms have no action. Unset is still allowed -- a missing alarm topic must
# never stop an operator bringing up a bastion to run a migration -- but the
# script says so out loud. Only the deploy passes it, and its value is never
# printed.

[CmdletBinding()]
param(
    [ValidateSet('dev', 'production')]
    [string]$DeploymentEnvironment = 'production',

    [switch]$Destroy
)

$ErrorActionPreference = 'Stop'

# The preload default (see the header): checked before anything else runs.
if ([string]::IsNullOrWhiteSpace($env:AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT)) {
    Write-Error -ErrorAction Continue 'AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT is not set (or is empty). Set it to the engine default preload list from the pre-check (or none), then re-run. The CDK app needs it to synthesize, for deploy and destroy alike.'
    exit 1
}

# Everything CDK prints goes through Hide-ResourceId, as deploy-bastion.sh
# runs it through redact_ids, so the bastion session's terminal output
# carries no resource identifiers: ARNs (the stack ARN, the alarm topic),
# account ids, instance and other resource ids, IP addresses. The masking is
# for display only; nothing parses CDK's output, and
# scripts/run-migrations.sh finds the bastion through CloudFormation itself.
# The rules are deploy-bastion.sh's, in its order, and case-sensitive as sed
# is (-creplace). Each numeric rule runs twice, because a match consumes the
# character that separates it from an adjacent one.
function Hide-ResourceId {
    param([Parameter(ValueFromPipeline = $true)] $Line)
    process {
        # A line CDK wrote to stderr arrives as an error record; its text is the line.
        $text = "$Line"
        $text = $text -creplace 'arn:aws[A-Za-z0-9-]*:[^\s"'',)]*', '<arn>'
        $text = $text -creplace 'i-[0-9a-f]{8,17}', '<instance-id>'
        $text = $text -creplace '(sg|subnet|vpc|eni|vol|ami|igw|nat|rtb|acl|snap|eipalloc|lt)-[0-9a-f]{8,17}', '<resource-id>'
        $text = $text -creplace '(^|[^0-9])[0-9]{12}([^0-9]|$)', '${1}<account-id>${2}'
        $text = $text -creplace '(^|[^0-9])[0-9]{12}([^0-9]|$)', '${1}<account-id>${2}'
        $text = $text -creplace '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)', '${1}<ip>${3}'
        $text = $text -creplace '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)', '${1}<ip>${3}'
        Write-Host $text
    }
}

# Runs one CDK call, whose stdout and stderr go through Hide-ResourceId, and
# returns its exit code. The call runs with the error preference at
# 'Continue': under 'Stop', Windows PowerShell 5.1 ends the script at the
# first line a native command writes to a redirected stderr, and CDK writes
# its progress there. The repo's other scripts relax it the same way.
function Invoke-MaskedCdk {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command
        $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

$outDir = Join-Path $PSScriptRoot '..\.tmp\jale-cdk-out-bastion'

Push-Location (Join-Path $PSScriptRoot '..\infra')
try {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    if ($Destroy) {
        Write-Host ">> Destroying JaleBastionStack (environment=$DeploymentEnvironment)..."
        $cdkExitCode = Invoke-MaskedCdk {
            npx cdk -c bastionOnly=true -c "environment=$DeploymentEnvironment" -c "dbSharedPreloadLibrariesDefault=$env:AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT" destroy JaleBastionStack --exclusively -o $outDir --force 2>&1 | Hide-ResourceId
        }
        if ($cdkExitCode -ne 0) {
            throw "CDK bastion destroy failed with exit code $cdkExitCode."
        }
        Write-Host ">> Bastion destroyed."
    }
    else {
        # Passed as a context flag only when set: `-c whatsappAlarmTopicArn=` with an
        # empty value would be read by the stack as "a topic was supplied", and
        # `Topic.fromTopicArn` on an empty string fails at synth.
        $alarmContext = @()
        if (-not [string]::IsNullOrEmpty($env:WHATSAPP_ALARM_TOPIC_ARN)) {
            $alarmContext = @('-c', "whatsappAlarmTopicArn=$env:WHATSAPP_ALARM_TOPIC_ARN")
            Write-Host ">> TTL alarms will notify the topic in WHATSAPP_ALARM_TOPIC_ARN."
        }
        else {
            Write-Host ">> WHATSAPP_ALARM_TOPIC_ARN is not set -- the bastion TTL alarms will"
            Write-Host "   be created with NO notification action. The sweeper still stops the"
            Write-Host "   bastion; only the backstop is silent. Set it to wire them up."
        }

        Write-Host ">> Deploying JaleBastionStack (environment=$DeploymentEnvironment)..."
        $cdkExitCode = Invoke-MaskedCdk {
            npx cdk -c bastionOnly=true -c "environment=$DeploymentEnvironment" -c "dbSharedPreloadLibrariesDefault=$env:AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT" @alarmContext deploy JaleBastionStack --exclusively -o $outDir --require-approval never 2>&1 | Hide-ResourceId
        }
        if ($cdkExitCode -ne 0) {
            throw "CDK bastion deployment failed with exit code $cdkExitCode."
        }
        Write-Host ""
        Write-Host ">> Bastion up. Remember to tear it down when finished:"
        Write-Host "     .\scripts\deploy-bastion.ps1 -Destroy"
    }
}
finally {
    Pop-Location
}
