#!/usr/bin/env bash
#
# Deploy JaleBastionStack without synthesizing the AI / app stacks.
#
# This avoids unrelated Lambda bundling work when the only goal is to bring up
# the temporary migration bastion, and keeps CDK output out of the repo tree so
# Defender is less likely to lock cdk.out.

set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/.tmp/jale-cdk-out-bastion"
mkdir -p "$OUT_DIR"
cd "$(dirname "$0")/../infra"
npx cdk -c bastionOnly=true deploy JaleBastionStack --exclusively -o "$OUT_DIR" --require-approval never
