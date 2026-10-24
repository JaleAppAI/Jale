#!/usr/bin/env bash
#
# employer-pool-enable-all.sh: enable every disabled user of the employer
# user pool. The Phase 3 rollback step (employer organizations, Release step
# 8): use it only if JaleBillingStack is rolled back to Phase 2 code.
#
# WARNINGS
#   - Never run while Phase 3 code is deployed: it would re-enable removed and
#     billing-suspended foremen (the member-access sync disables them again
#     within 15 minutes, but they can sign in meanwhile).
#   - Review the dry-run list for users disabled on purpose; this enables every disabled user.
#
# Usage:
#   bash scripts/ops/employer-pool-enable-all.sh --user-pool-id <id> [--region <r>] [--apply]
#
#   --user-pool-id  the employer pool's id, e.g. us-east-2_AbCdEf123
#   --region        the pool's region; by default the one in the pool id
#   --apply         enable them; without it, a dry run that only lists them
#
# Example (dry run, then apply):
#   AWS_PROFILE=IvanJale bash scripts/ops/employer-pool-enable-all.sh --user-pool-id us-east-2_AbCdEf123
#   AWS_PROFILE=IvanJale bash scripts/ops/employer-pool-enable-all.sh --user-pool-id us-east-2_AbCdEf123 --apply
#
# Why: Phase 3 disables the Cognito user of a removed or billing-suspended
# foreman, and its member-access sync keeps the pool matching the database.
# Phase 2 code has neither the sync nor any foreman, so after a rollback a
# disabled user would stay locked out with nothing to enable them again.
# Before Phase 3 the employer pool had no disabled users, so enabling every
# disabled one restores Phase 2's state.
#
# It prints the AWS account it acts in (sts get-caller-identity), lists every
# user of the pool (list-users, one page at a time), keeps those with
# Enabled == false (jq), and prints their count and usernames (the employer
# pool's usernames are the users' subs). With --apply it runs
# admin-enable-user for each one, keeps going past a failure, and exits 1 if
# any failed. The AWS profile comes from the environment (AWS_PROFILE).
#
# ---------------------------------------------------------------------------

set -euo pipefail
umask 077

die()  { echo "!! $*" >&2; exit 1; }
usage_error() { echo "!! $*" >&2; echo "   see: bash scripts/ops/employer-pool-enable-all.sh --help" >&2; exit 2; }

POOL_ID=""
REGION=""
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) awk 'NR > 1 && /^# ---/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    --user-pool-id)
      [[ $# -ge 2 ]] || usage_error "--user-pool-id needs the employer pool's id"
      POOL_ID="$2"; shift ;;
    --region)
      [[ $# -ge 2 ]] || usage_error "--region needs a region"
      REGION="$2"; shift ;;
    --apply) APPLY=1 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

[[ -n "$POOL_ID" ]] || usage_error "--user-pool-id is required"
[[ "$POOL_ID" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]_[A-Za-z0-9]+$ ]] \
  || usage_error "--user-pool-id must look like us-east-2_AbCdEf123"
# A pool lives in the region its id names; AWS_REGION would only be a way to
# ask the wrong region for it.
[[ -n "$REGION" ]] || REGION="${POOL_ID%%_*}"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || usage_error "--region must look like us-east-2"

command -v aws >/dev/null 2>&1 || die "the aws CLI is not on PATH"
command -v jq  >/dev/null 2>&1 || die "jq is not on PATH"

ACCOUNT="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)" \
  || die "sts get-caller-identity failed; check AWS_PROFILE"
echo "account $ACCOUNT, region $REGION, pool $POOL_ID"

# ── List every disabled user, one page at a time ───────────────────────────
DISABLED=()
TOKEN=""
while :; do
  PAGE_ARGS=(cognito-idp list-users --region "$REGION" --user-pool-id "$POOL_ID" --limit 60 --no-paginate --output json)
  [[ -n "$TOKEN" ]] && PAGE_ARGS+=(--pagination-token "$TOKEN")
  PAGE="$(aws "${PAGE_ARGS[@]}")" || die "list-users failed; nothing was enabled"
  while IFS= read -r username; do
    [[ -n "$username" ]] && DISABLED+=("$username")
  done < <(jq -r '.Users[]? | select(.Enabled == false) | .Username' <<<"$PAGE")
  TOKEN="$(jq -r '.PaginationToken // empty' <<<"$PAGE")"
  [[ -n "$TOKEN" ]] || break
done

echo "${#DISABLED[@]} disabled user(s) in $POOL_ID"
for username in ${DISABLED[@]+"${DISABLED[@]}"}; do
  echo "  $username"
done

if [[ "$APPLY" -ne 1 ]]; then
  echo "dry run: nothing changed; review the list, then re-run with --apply to enable them"
  exit 0
fi

# ── Enable them ─────────────────────────────────────────────────────────────
ENABLED=0
FAILED=0
for username in ${DISABLED[@]+"${DISABLED[@]}"}; do
  if aws cognito-idp admin-enable-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$username"; then
    ENABLED=$((ENABLED + 1))
  else
    echo "!! could not enable $username" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo "enabled $ENABLED, failed $FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1
