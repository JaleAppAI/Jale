#!/usr/bin/env bash
#
# Deploy (or destroy) JaleBastionStack without synthesizing the AI / app stacks.
#
# This avoids unrelated Lambda bundling work when the only goal is to bring up
# the temporary migration bastion, and keeps CDK output out of the repo tree so
# Defender is less likely to lock cdk.out.
#
# Usage:
#
#   scripts/deploy-bastion.sh                 # bring the bastion up
#   scripts/deploy-bastion.sh --destroy       # tear it down (cost hygiene)
#   scripts/deploy-bastion.sh --environment dev
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
# WHATSAPP_ALARM_TOPIC_ARN (optional) wires the TTL auto-teardown alarms to a
# real destination. This is the SAME environment variable the deploy workflow
# already feeds `-c whatsappAlarmTopicArn` from (vars.WHATSAPP_ALARM_TOPIC_ARN,
# see .github/workflows/_reusable-deploy.yml), so there is no second convention
# to remember -- export it and the alarms page somebody, leave it unset and
# they are created without actions.
#
# That mattered more once the bastion gained a TTL: this script is the ONLY
# path that deploys JaleBastionStack (it is in none of the deploy workflow's
# stack lists), so without this the auto-teardown backstop alarms were
# guaranteed to have no action. Unset is still allowed -- a missing alarm topic
# must never stop an operator bringing up a bastion to run a migration -- but
# it now says so out loud instead of failing silently.

set -euo pipefail

DEPLOYMENT_ENVIRONMENT="production"
DESTROY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --destroy)
      DESTROY=1
      shift
      ;;
    --environment)
      DEPLOYMENT_ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --environment=*)
      DEPLOYMENT_ENVIRONMENT="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--destroy] [--environment dev|production]" >&2
      exit 1
      ;;
  esac
done

if [ "$DEPLOYMENT_ENVIRONMENT" != "dev" ] && [ "$DEPLOYMENT_ENVIRONMENT" != "production" ]; then
  echo "!! --environment must be 'dev' or 'production' (got: '$DEPLOYMENT_ENVIRONMENT')" >&2
  exit 1
fi

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/.tmp/jale-cdk-out-bastion"
mkdir -p "$OUT_DIR"
cd "$(dirname "$0")/../infra"

if [ "$DESTROY" -eq 1 ]; then
  echo ">> Destroying JaleBastionStack (environment=$DEPLOYMENT_ENVIRONMENT)..."
  npx cdk -c bastionOnly=true -c "environment=$DEPLOYMENT_ENVIRONMENT" destroy JaleBastionStack --exclusively -o "$OUT_DIR" --force
  echo ">> Bastion destroyed."
else
  # Passed as a context flag only when set: `-c whatsappAlarmTopicArn=` with an
  # empty value would be read by the stack as "a topic was supplied", and
  # `Topic.fromTopicArn` on an empty string fails at synth.
  ALARM_CONTEXT=()
  if [ -n "${WHATSAPP_ALARM_TOPIC_ARN:-}" ]; then
    ALARM_CONTEXT=(-c "whatsappAlarmTopicArn=$WHATSAPP_ALARM_TOPIC_ARN")
    echo ">> TTL alarms will notify: $WHATSAPP_ALARM_TOPIC_ARN"
  else
    echo ">> WHATSAPP_ALARM_TOPIC_ARN is not set -- the bastion TTL alarms will"
    echo "   be created with NO notification action. The sweeper still stops the"
    echo "   bastion; only the backstop is silent. Export it to wire them up."
  fi

  echo ">> Deploying JaleBastionStack (environment=$DEPLOYMENT_ENVIRONMENT)..."
  npx cdk -c bastionOnly=true -c "environment=$DEPLOYMENT_ENVIRONMENT" "${ALARM_CONTEXT[@]}" deploy JaleBastionStack --exclusively -o "$OUT_DIR" --require-approval never
  echo ""
  echo ">> Bastion up. Remember to tear it down when finished:"
  echo "     scripts/deploy-bastion.sh --destroy"
fi
