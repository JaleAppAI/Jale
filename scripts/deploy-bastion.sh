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
  echo ">> Deploying JaleBastionStack (environment=$DEPLOYMENT_ENVIRONMENT)..."
  npx cdk -c bastionOnly=true -c "environment=$DEPLOYMENT_ENVIRONMENT" deploy JaleBastionStack --exclusively -o "$OUT_DIR" --require-approval never
  echo ""
  echo ">> Bastion up. Remember to tear it down when finished:"
  echo "     scripts/deploy-bastion.sh --destroy"
fi
