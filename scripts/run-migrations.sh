#!/usr/bin/env bash
#
# run-migrations.sh — Apply DB migrations against the Jale RDS via the
# ephemeral BastionStack.
#
#   1. Deploy the bastion: `bash scripts/deploy-bastion.sh`
#   2. Run this script:    `bash scripts/run-migrations.sh`
#   3. Destroy the bastion: `cd infra && npx cdk destroy JaleBastionStack`
#
# Usage:
#   bash scripts/run-migrations.sh [--dry-run] [--baseline-through FILE]
#                                  [--rotate-secrets] [--skip-secrets]
#                                  [--force-replay] [--yes]
#
#   --dry-run         Resolve state and print the plan; change nothing.
#   --baseline-through FILE
#                     Record every migration up to and including FILE as
#                     applied WITHOUT executing it, then apply everything
#                     after it normally. This is how a database that was
#                     migrated before the ledger existed adopts the ledger.
#                     FILE must name a migration in the manifest. Choose the
#                     last migration you know is already applied — anything
#                     later is still executed, so an over-broad baseline
#                     cannot silently skip real work.
#   --rotate-secrets  Also reset the jale_matching / jale_admin_console /
#                     jale_billing role passwords from their generated
#                     secrets, mint a new jale_whatsapp password, and seed
#                     jale/whatsapp/db. NOT part of a routine migration run:
#                     rotating jale_whatsapp breaks in-flight Lambda
#                     containers until they refetch the secret.
#   --skip-secrets    Acknowledge that a fresh-database bootstrap (the ledger
#                     was absent or empty before this run) leaves
#                     jale_matching / jale_admin_console / jale_billing /
#                     jale_whatsapp with no usable password and
#                     jale/whatsapp/db unseeded, and print success anyway.
#                     Prefer --rotate-secrets unless something else already
#                     provisions those credentials.
#   --force-replay    Re-apply migrations the ledger already records. Unsafe:
#                     migration 042 self-audits its own ten-value step-key
#                     CHECK and raises once 050 widens it to seventeen.
#   --yes             Skip the interactive confirmation prompt.
#
# ---------------------------------------------------------------------------
# Why this script is shaped the way it is
# ---------------------------------------------------------------------------
# A previous revision inlined every migration as base64 into a single shell
# argument. Linux caps one argv entry at MAX_ARG_STRLEN (128 KiB); the corpus
# passed 400 KiB, so the `jq` that built the SSM payload died with E2BIG, the
# command substitution collapsed to an empty string, and `aws ssm send-command`
# was handed an empty command list. SSM ran nothing, returned exit code 0, and
# the script printed ">> All done." — a green result for a migration run that
# had touched nothing.
#
# Three rules follow from that, and this script holds all three:
#
#   1. Payloads never travel through argv. They are written to a file and
#      handed to the AWS CLI via --cli-input-json file://, so no per-argument
#      kernel limit applies.
#   2. Every step that produces a payload is checked for emptiness and for
#      size before it is sent. A truncated or empty payload is a hard failure,
#      never a silent no-op.
#   3. Exit code 0 is not trusted on its own. The remote script prints a
#      sentinel as its last act, and the run fails unless that sentinel comes
#      back in the output.
#
# The ledger (public.schema_migrations) is the other half. Without it every
# run replayed all 51 files against production, which is both needless churn
# and actively wrong: migration 042 pins its own ten-value CHECK constraint in
# a self-audit and raises once migration 050 widens it. With the ledger, an
# applied migration is never replayed, so the chain stays convergent.
#
# Requirements on the operator machine: aws CLI v2, jq, base64, gzip, and
# sha256sum (or shasum). No local psql — all DB work happens on the bastion.

set -euo pipefail

# Associative arrays need bash 4.0; the `local -n` nameref below needs 4.3.
# macOS ships bash 3.2, so fail with an actionable message rather than a
# confusing syntax error halfway through a production run.
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  echo "!! bash >= 4.3 required (found ${BASH_VERSION}). On macOS: brew install bash" >&2
  exit 1
fi

BASTION_STACK="JaleBastionStack"
DATABASE_STACK="JaleDatabaseStack"
WA_DB_SECRET_NAME="jale/whatsapp/db"
BILLING_DB_SECRET_NAME="jale/billing/db"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
LEDGER_TABLE="public.schema_migrations"
SENTINEL="__JALE_MIGRATION_RUN_OK__"

# SSM caps the SendCommand request; stay well under it. Migrations are gzipped
# before base64 so the whole corpus fits comfortably, but batches are still
# capped so that a fresh database cannot build one oversized request.
MAX_PAYLOAD_BYTES=60000

# Overhead added by apply_batch()'s APPLY_ONE heredoc (~lines 559-570) around
# each migration file's base64 payload. The payload itself ($b64) is already
# counted separately via `encode_migration | wc -c`; everything else in that
# heredoc is measured here so the batch packer accounts for what SSM actually
# receives, not just the payload. Measured by rendering APPLY_ONE with
# f="" sum="" b64="" and piping the result through `wc -c`: 502 bytes. Within
# that fixed text, the filename ($f) is substituted 4 times -- the "-> $f"
# progress line, the "decoded to nothing" and "failed checksum verification"
# error messages, and the ledger INSERT's VALUES list -- and the checksum
# ($sum) is substituted 2 times -- the transfer-verification test and that
# same INSERT. Recompute APPLY_ONE_FIXED_BYTES if APPLY_ONE's body changes.
APPLY_ONE_FIXED_BYTES=502
APPLY_ONE_FILENAME_OCCURRENCES=4
APPLY_ONE_CHECKSUM_OCCURRENCES=2
# sha256_of (below) always returns a 64-character lowercase hex digest.
CHECKSUM_HEX_LEN=64

DRY_RUN=false
BASELINE_THROUGH=""
ROTATE_SECRETS=false
SKIP_SECRETS=false
FORCE_REPLAY=false
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --baseline-through)
      [[ $# -ge 2 ]] || { echo "!! --baseline-through needs a migration filename" >&2; exit 2; }
      BASELINE_THROUGH="$2"; shift ;;
    --rotate-secrets) ROTATE_SECRETS=true ;;
    --skip-secrets)   SKIP_SECRETS=true ;;
    --force-replay)   FORCE_REPLAY=true ;;
    --yes|-y)         ASSUME_YES=true ;;
    -h|--help)        sed -n '2,41p' "$0"; exit 0 ;;
    *) echo "!! Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Migration files in execution order — the canonical chain for a fresh RDS.
# KEEP IN SYNC with infra/db/migrations/; the script verifies the two agree
# before it touches the database, so drift fails fast instead of silently
# skipping a file.
MIGRATION_DIR="$(cd "$(dirname "$0")/../infra/db/migrations" && pwd)"
MIGRATIONS=(
  "001_initial_schema.sql"
  "002_rls_policies.sql"
  "003_jobs_and_applications.sql"
  "004_whatsapp.sql"
  "005_document_vault.sql"
  "006_trust_signal_layer.sql"
  "007_worker_marketplace.sql"
  "008_worker_skills.sql"
  "009_location_foundation.sql"
  "010_matching_write_semantics.sql"
  "011_ai_profile_media.sql"
  "012_ai_trust_assessment.sql"
  "013_whatsapp_template_outbox.sql"
  "014_employer_candidate_rankings.sql"
  "015_application_status_alignment.sql"
  "016_employer_profiles.sql"
  "017_document_upload_token_hardening.sql"
  "018_document_vault_rls_hardening.sql"
  "019_application_status_constraint_repair.sql"
  "020_worker_pii_rls_hardening.sql"
  "020b_rls_relationship_recursion_prevention.sql"
  "021_whatsapp_required_docs_apply_support.sql"
  "022_job_application_required_docs_guard.sql"
  "023_job_fields_and_statuses_mvp.sql"
  "024_sprint11_hiring_flow_hardening.sql"
  "025_job_messaging.sql"
  "026_admin_panel.sql"
  "027_admin_security_hardening.sql"
  "028_job_messaging_hardening.sql"
  "029_hired_count_trigger_security_definer.sql"
  "030_whatsapp_worker_skills_seed.sql"
  "031_employer_display_name.sql"
  "032_work_authorization_required.sql"
  "033_pay_interval_experience_months_worker_certifications.sql"
  "034_billing_foundation.sql"
  "035_job_delete_grants.sql"
  "036_billing_job_limit_enforcement.sql"
  "037_email_outbox.sql"
  "038_rls_relationship_recursion_repair.sql"
  "039_whatsapp_support_cases.sql"
  "040_whatsapp_delivery_status.sql"
  "041_whatsapp_web_worker_lookup_grant.sql"
  "042_whatsapp_onboarding_gate.sql"
  "043_whatsapp_worker_intent_transport.sql"
  "044_job_message_outbox_send_unknown.sql"
  "045_applications_employer_update_repair.sql"
  "046_whatsapp_active_workflow_rebind.sql"
  "047_whatsapp_identity_challenge_delete_hardening.sql"
  "048_worker_domain_outbox_user_fk.sql"
  "049_whatsapp_v2_flow_privilege_repair.sql"
  "050_whatsapp_v2_profile_steps.sql"
  "051_whatsapp_voice_intake_control.sql"
  "052_worker_pending_name_and_skills_reset.sql"
  "053_whatsapp_web_worker_bypass.sql"
  "054_remove_onboarding_v2_control.sql"
  "055_job_conversations_application_index.sql"
  "056_job_referrals.sql"
  "057_job_public_listing_opt_in.sql"
  "058_referral_open_dedupe_grant.sql"
  "059_share_link_claim_read.sql"
  "060_trade_aliases.sql"
  "061_job_geo_and_seo_grants.sql"
  "062_job_visibility_outbox.sql"
  "063_employer_referral_links.sql"
  "064_public_job_context_functions.sql"
  "065_city_keys_and_preferred_cities.sql"
  "066_preferred_cities_whatsapp_read.sql"
  "067_city_key_backfill_repair.sql"
  "068_preferred_city_centroids.sql"
  "069_employer_job_templates.sql"
  "070_worker_applied_job_visibility.sql"
  "071_wage_references.sql"
  "072_whatsapp_retrigger_sweep_definer.sql"
  "073_job_application_requirements.sql"
  "074_job_optional_requirements.sql"
  "075_worker_documents_multi_certification.sql"
  "076_ai_extraction_asr_metadata.sql"
  "077_jobs_structured_fields.sql"
  "078_worker_documents_cert_name.sql"
  "079_worker_application_defaults.sql"
)

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
die()  { echo "!! $*" >&2; exit 1; }
note() { echo ">> $*"; }

need_tool() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "need sha256sum or shasum"; fi
}

encode_migration() { gzip -9 -c "$1" | base64 | tr -d '\n'; }

# Send a script to the bastion and stream back its output. The body is read
# from a file so it never passes through argv, and the assembled request is
# validated before it leaves this machine.
#
# $3 (strict_truncation, default false) controls what happens when SSM
# reports the command's output was truncated: false (the default) tolerates
# it, because verify_ledger() re-reads authoritative database state after an
# apply/verify/rotate call and cannot be fooled by a lost stdout tail. true
# is for calls this script plans FROM, like the ledger read: a truncated read
# there gets parsed as if it were complete, mis-classifying already-applied
# migrations as pending, so it must hard-fail instead of proceeding on
# partial state.
run_on_bastion() {
  local script_file="$1" comment="$2" strict_truncation="${3:-false}"
  local request="$WORKDIR/request.json" out="$WORKDIR/out.txt"

  [[ -s "$script_file" ]] || die "refusing to send an empty script ($comment)"

  local script_bytes
  script_bytes=$(wc -c < "$script_file")
  (( script_bytes <= MAX_PAYLOAD_BYTES )) \
    || die "'$comment' renders to ${script_bytes}B, over the ${MAX_PAYLOAD_BYTES}B SSM payload ceiling"

  jq -Rn --rawfile s "$script_file" --arg id "$BASTION_ID" --arg c "$comment" \
     '{InstanceIds:[$id],DocumentName:"AWS-RunShellScript",Comment:$c,
       Parameters:{commands:[$s]}}' > "$request" \
    || die "failed to build the SSM request for $comment"

  [[ -s "$request" ]] || die "built an empty SSM request for $comment"

  # Prove the request really carries a command. An empty commands array is
  # exactly the failure mode this script exists to make impossible.
  jq -e '.Parameters.commands[0] | length > 0' "$request" >/dev/null \
    || die "SSM request for $comment carries no command"

  local cmd_id
  cmd_id=$(aws ssm send-command --region "$REGION" --cli-input-json "file://$request" \
            --query "Command.CommandId" --output text) \
    || die "send-command failed for $comment"
  [[ -n "$cmd_id" && "$cmd_id" != "None" ]] || die "no CommandId returned for $comment"

  # Poll and read output with get-command-invocation, NOT
  # list-command-invocations: the latter truncates its Output field at about
  # 2,500 characters, which silently cut the ledger read off at 28 of 51 rows
  # and produced a bogus "migration edited on disk" alarm. get-command-invocation
  # returns up to 24,000 characters of StandardOutputContent.
  local status
  while true; do
    status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
              --instance-id "$BASTION_ID" --query "Status" --output text 2>/dev/null || echo "Pending")
    case "$status" in
      Success) break ;;
      Failed|Cancelled|TimedOut)
        echo "!! bastion command '$comment' ended: $status" >&2
        aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
          --instance-id "$BASTION_ID" --query "StandardErrorContent" --output text >&2 || true
        exit 1 ;;
      *) sleep 5 ;;
    esac
  done

  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
    --instance-id "$BASTION_ID" --query "StandardOutputContent" --output text > "$out"

  cat "$out"

  # SSM truncates inline output at roughly 24 KB. A truncated tail can drop the
  # sentinel even though the remote script ran to completion, so absence of the
  # sentinel is only conclusive when the output was NOT truncated. When it was,
  # say so and leave the verdict to verify_ledger(), which reads database state
  # and cannot be fooled by a lost stdout tail.
  if grep -q "$SENTINEL" "$out"; then
    :
  elif grep -q -- '---Output truncated---' "$out"; then
    if $strict_truncation; then
      die "'$comment' output was truncated by SSM; the ledger read was truncated and the run cannot plan from partial state"
    fi
    echo "!! '$comment' output was truncated by SSM; falling back to state verification" >&2
  else
    die "'$comment' reported Success but never printed the completion sentinel — treating as failed"
  fi
}

# Authoritative check: does the database now record exactly what we intended?
# stdout can be truncated or lost; the ledger cannot.
verify_ledger() {
  local -n _expect="$1"
  (( ${#_expect[@]} > 0 )) || return 0

  local list="" f
  for f in "${_expect[@]}"; do list+="${list:+,}'$f'"; done

  {
    emit_pg_preamble
    cat <<VERIFY
echo "---VERIFY-BEGIN---"
"\${PG[@]}" -At -F '|' -c "SELECT filename, coalesce(checksum,'') FROM $LEDGER_TABLE
  WHERE filename IN ($list) ORDER BY filename;"
echo "---VERIFY-END---"
unset PGPASSWORD
echo "$SENTINEL"
VERIFY
  } > "$WORKDIR/verify.sh"

  run_on_bastion "$WORKDIR/verify.sh" "verify ledger" > "$WORKDIR/verify-out.txt"

  sed -n '/---VERIFY-BEGIN---/,/---VERIFY-END---/p' "$WORKDIR/verify-out.txt" \
    | grep -v -- '---VERIFY-' > "$WORKDIR/verified.txt" || true

  declare -A GOT
  local fname csum
  while IFS='|' read -r fname csum; do
    [[ -n "$fname" ]] && GOT["$fname"]="$csum"
  done < "$WORKDIR/verified.txt"

  local bad=()
  for f in "${_expect[@]}"; do
    local want; want="$(sha256_of "$MIGRATION_DIR/$f")"
    [[ "${GOT[$f]:-}" == "$want" ]] || bad+=("$f")
  done

  if (( ${#bad[@]} > 0 )); then
    echo "!! the ledger does not record these as applied with the expected checksum:" >&2
    printf '     %s\n' "${bad[@]}" >&2
    die "migration run could not be verified against database state"
  fi

  note "Verified against the ledger: ${#_expect[@]} migration(s) recorded with matching checksums."
}

# Shared bastion preamble: fetch admin creds, build the psql command array.
emit_pg_preamble() {
  cat <<PREAMBLE
#!/bin/bash
set -euo pipefail
REGION="$REGION"
DB_SECRET_ARN="$DB_SECRET_ARN"
SECRET_JSON=\$(aws secretsmanager get-secret-value --secret-id "\$DB_SECRET_ARN" \
  --region "\$REGION" --query SecretString --output text)
export PGPASSWORD=\$(echo "\$SECRET_JSON" | jq -r .password)
DB_HOST=\$(echo "\$SECRET_JSON" | jq -r .host)
DB_PORT=\$(echo "\$SECRET_JSON" | jq -r .port)
DB_NAME=\$(echo "\$SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=\$(echo "\$SECRET_JSON" | jq -r .username)
PG=(psql -h "\$DB_HOST" -p "\$DB_PORT" -U "\$DB_USER" -d "\$DB_NAME" -v ON_ERROR_STOP=1)
PREAMBLE
}

# The ledger table may predate this script. Production already carried a
# public.schema_migrations(filename, applied_at) holding a single stale row for
# 001_initial_schema.sql, so the DDL below has to adopt an existing table
# rather than assume a clean slate: create it if absent, and add the columns
# this script needs if they are missing. checksum is deliberately NULLABLE —
# legacy rows record that a migration was applied but not what it looked like,
# and inventing a checksum for them would fake a verification that never
# happened.
emit_ledger_ddl() {
  cat <<'LEDGER'
"${PG[@]}" -q -c "
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE public.schema_migrations
    ADD COLUMN IF NOT EXISTS checksum   TEXT,
    ADD COLUMN IF NOT EXISTS applied_by TEXT NOT NULL DEFAULT current_user;
  REVOKE ALL ON public.schema_migrations FROM PUBLIC;
"
LEDGER
}

# ---------------------------------------------------------------------------
# Preconditions.
# ---------------------------------------------------------------------------
for t in aws jq base64 gzip; do need_tool "$t"; done

note "Using region: $REGION"

missing=()
for f in "${MIGRATIONS[@]}"; do
  [[ -f "$MIGRATION_DIR/$f" ]] || missing+=("$f")
done
(( ${#missing[@]} == 0 )) || die "manifest lists files absent from $MIGRATION_DIR: ${missing[*]}"

untracked=()
while IFS= read -r f; do
  case " ${MIGRATIONS[*]} " in
    *" $f "*) ;;
    *) untracked+=("$f") ;;
  esac
done < <(cd "$MIGRATION_DIR" && ls -1 ./*.sql 2>/dev/null | sed 's|^\./||' | sort)
(( ${#untracked[@]} == 0 )) \
  || die "migration files on disk are missing from the manifest: ${untracked[*]} — add them to MIGRATIONS"

note "Manifest verified: ${#MIGRATIONS[@]} migrations, in sync with $MIGRATION_DIR"

note "Resolving bastion instance ID..."
BASTION_ID=$(aws cloudformation describe-stacks --stack-name "$BASTION_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
[[ -n "$BASTION_ID" && "$BASTION_ID" != "None" ]] \
  || die "no BastionInstanceId on $BASTION_STACK. Deploy it first: bash scripts/deploy-bastion.sh"
note "   bastion: resolved"

# The four DB-role secrets are resolved with their CloudFormation logical-ID
# prefixes spelled out in full. The queries are deliberately not factored into
# a helper: infra/test/unit/db/migrations.test.ts asserts on these exact
# strings, so keeping them literal keeps that guard meaningful.
describe_secret_arn() {
  aws cloudformation describe-stack-resources --stack-name "$DATABASE_STACK" \
    --region "$REGION" --query "$1" --output text
}

note "Resolving jale_admin DB secret ARN..."
DB_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]")
[[ -n "$DB_SECRET_ARN" && "$DB_SECRET_ARN" != "None" ]] \
  || die "could not find the jale_admin DB secret in $DATABASE_STACK"
note "   db-secret: resolved"

note "Resolving jale_matching DB secret ARN..."
MATCHING_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'MatchingDbSecret')].PhysicalResourceId | [0]")
[[ -n "$MATCHING_SECRET_ARN" && "$MATCHING_SECRET_ARN" != "None" ]] \
  || die "could not find the jale_matching DB secret in $DATABASE_STACK"
note "   matching-secret: resolved"

note "Resolving jale_admin_console DB secret ARN..."
ADMIN_CONSOLE_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'AdminConsoleDbSecret')].PhysicalResourceId | [0]")
[[ -n "$ADMIN_CONSOLE_SECRET_ARN" && "$ADMIN_CONSOLE_SECRET_ARN" != "None" ]] \
  || die "could not find the jale_admin_console DB secret in $DATABASE_STACK"
note "   admin-console-secret: resolved"

note "Resolving jale_billing DB secret ARN..."
BILLING_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'BillingDbSecret')].PhysicalResourceId | [0]")
[[ -n "$BILLING_SECRET_ARN" && "$BILLING_SECRET_ARN" != "None" ]] \
  || die "could not find the jale_billing DB secret in $DATABASE_STACK"
note "   billing-secret: resolved"

# jale_public_jobs (migration 056) is the anonymous read role behind the public
# job pages. Its secret only exists once JaleDatabaseStack has deployed with
# ReferralsDbSecret, so — unlike the four roles above — absence is only fatal
# when rotating: a plain migration run on a pre-referrals database must not be
# bricked by it, but a rotate must NEVER silently skip the sync (a skipped sync
# is exactly the vault/database password drift that leaves the public page
# failing every request while everything else looks healthy).
note "Resolving jale_public_jobs DB secret ARN..."
REFERRALS_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'ReferralsDbSecret')].PhysicalResourceId | [0]")
if [[ -z "$REFERRALS_SECRET_ARN" || "$REFERRALS_SECRET_ARN" == "None" ]]; then
  if $ROTATE_SECRETS; then
    die "could not find the jale/referrals/db secret in $DATABASE_STACK — deploy JaleDatabaseStack first; refusing to silently skip the jale_public_jobs password sync"
  fi
  note "   referrals-secret: not found (JaleDatabaseStack predates ReferralsDbSecret) — jale_public_jobs sync unavailable until it deploys"
  REFERRALS_SECRET_ARN=""
else
  note "   referrals-secret: resolved"
fi

# ---------------------------------------------------------------------------
# Read the ledger.
# ---------------------------------------------------------------------------
note "Reading migration ledger from $LEDGER_TABLE..."
{
  emit_pg_preamble
  emit_ledger_ddl
  cat <<LEDGER_READ
echo "---LEDGER-BEGIN---"
"\${PG[@]}" -At -F '|' -c "SELECT filename, checksum FROM $LEDGER_TABLE ORDER BY filename;"
echo "---LEDGER-END---"
unset PGPASSWORD
echo "$SENTINEL"
LEDGER_READ
} > "$WORKDIR/read-ledger.sh"

# strict_truncation=true: this call is what the rest of the run plans FROM.
# A truncated read here cannot be waived the way apply/verify/rotate output
# can, because there is no later state-verification pass to catch a
# mis-classified PENDING/applied migration before it acts on that plan.
run_on_bastion "$WORKDIR/read-ledger.sh" "read migration ledger" true > "$WORKDIR/ledger-out.txt"

sed -n '/---LEDGER-BEGIN---/,/---LEDGER-END---/p' "$WORKDIR/ledger-out.txt" \
  | grep -v -- '---LEDGER-' > "$WORKDIR/applied.txt" || true

declare -A APPLIED_SUM
while IFS='|' read -r fname csum; do
  [[ -n "$fname" ]] && APPLIED_SUM["$fname"]="$csum"
done < "$WORKDIR/applied.txt"

note "   ledger records ${#APPLIED_SUM[@]} applied migration(s)"

# A fresh RDS (or one whose ledger was never adopted) has no rows here before
# this run. Role password resets and jale/whatsapp/db seeding sit entirely
# behind --rotate-secrets, so a bootstrap onto a fresh database would
# otherwise finish green while every runtime role is left with no usable
# password. Captured now, before anything is applied, so the check below
# reflects state as it was BEFORE this run, not after.
FRESH_DATABASE=false
if (( ${#APPLIED_SUM[@]} == 0 )); then FRESH_DATABASE=true; fi

# ---------------------------------------------------------------------------
# Build the plan: what is pending, and has anything already applied drifted?
# ---------------------------------------------------------------------------
# --baseline-through names the last migration already applied out-of-band.
# Everything up to and including it is recorded, not executed; everything
# after it runs for real, so an over-broad baseline cannot skip real work
# silently — it can only be wrong about history, never about the future.
declare -A BASELINE_ONLY
if [[ -n "$BASELINE_THROUGH" ]]; then
  found=false
  for f in "${MIGRATIONS[@]}"; do
    BASELINE_ONLY["$f"]=1
    if [[ "$f" == "$BASELINE_THROUGH" ]]; then found=true; break; fi
  done
  $found || die "--baseline-through '$BASELINE_THROUGH' is not in the manifest"
  note "Baseline: recording through $BASELINE_THROUGH (${#BASELINE_ONLY[@]} file(s)) without executing them"
fi

PENDING=()
DRIFTED=()
LEGACY=()
for f in "${MIGRATIONS[@]}"; do
  sum="$(sha256_of "$MIGRATION_DIR/$f")"
  if [[ ! -v "APPLIED_SUM[$f]" ]]; then
    PENDING+=("$f")
  elif [[ -z "${APPLIED_SUM[$f]}" ]]; then
    # Recorded by an older ledger that stored no checksum. The migration is
    # applied, but unverifiable. A baseline pass re-records it so drift
    # detection starts working; outside one, leave it alone.
    if [[ -n "${BASELINE_ONLY[$f]:-}" ]]; then PENDING+=("$f"); else LEGACY+=("$f"); fi
  else
    [[ "${APPLIED_SUM[$f]}" == "$sum" ]] || DRIFTED+=("$f")
    if $FORCE_REPLAY; then PENDING+=("$f"); fi
  fi
done

if (( ${#LEGACY[@]} > 0 )); then
  note "${#LEGACY[@]} migration(s) recorded without a checksum (pre-ledger rows): ${LEGACY[*]}"
  note "   re-run with --baseline-through to backfill their checksums"
fi

if (( ${#DRIFTED[@]} > 0 )); then
  echo "!! These migrations changed on disk after they were applied:" >&2
  printf '     %s\n' "${DRIFTED[@]}" >&2
  die "an applied migration must never be edited — add a new migration instead"
fi

if (( ${#PENDING[@]} == 0 )); then
  note "Nothing to apply — the database matches the manifest."
  if ! $ROTATE_SECRETS; then note "Done."; exit 0; fi
else
  note "Plan (${#PENDING[@]} pending):"
  n_exec=0; n_record=0
  for f in "${PENDING[@]}"; do
    if [[ -n "${BASELINE_ONLY[$f]:-}" ]]; then
      echo "     record  $f"; n_record=$((n_record + 1))
    else
      echo "     APPLY   $f"; n_exec=$((n_exec + 1))
    fi
  done
  note "   $n_exec to execute, $n_record to record as already-applied"
fi

if $DRY_RUN; then
  note "--dry-run: stopping before any change."
  if $ROTATE_SECRETS; then
    note "   --rotate-secrets would reset role passwords and reseed $WA_DB_SECRET_NAME."
  fi
  exit 0
fi

if ! $ASSUME_YES; then
  target="execute ${n_exec:-0} and record ${n_record:-0} migration(s)"
  echo
  echo "About to $target against $DATABASE_STACK in $REGION."
  if $ROTATE_SECRETS; then
    echo "Also rotating role passwords and reseeding $WA_DB_SECRET_NAME."
  fi
  read -r -p "Type 'yes' to continue: " reply
  [[ "$reply" == "yes" ]] || die "aborted by operator"
fi

# ---------------------------------------------------------------------------
# Apply (or baseline) the pending migrations, in size-capped batches.
#
# Each file is applied and then recorded in the ledger. The migration files
# carry their own BEGIN/COMMIT, so the ledger insert cannot join that
# transaction; it runs immediately after, and `set -e` on the bastion stops
# the batch at the first failure. A batch that dies partway leaves the files
# it already finished both applied and recorded, so a re-run resumes cleanly.
# ---------------------------------------------------------------------------
apply_batch() {
  local -n _batch="$1"
  local label="$2" script="$WORKDIR/apply-$2.sh"
  { emit_pg_preamble; emit_ledger_ddl; } > "$script"

  # Baseline entries are folded into one multi-row INSERT rather than a line
  # of output each. SSM truncates inline command output at roughly 24 KB, and
  # a chatty run can push the completion sentinel past that cutoff — which
  # looks exactly like a failure that did not happen.
  local f sum b64 values=""
  for f in "${_batch[@]}"; do
    if [[ -n "${BASELINE_ONLY[$f]:-}" ]]; then
      sum="$(sha256_of "$MIGRATION_DIR/$f")"
      values+="${values:+,}('$f','$sum')"
    fi
  done
  if [[ -n "$values" ]]; then
    cat >> "$script" <<BASELINE_ALL
"\${PG[@]}" -q -c "INSERT INTO $LEDGER_TABLE (filename, checksum)
  VALUES $values
  ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;"
BASELINE_ALL
  fi

  for f in "${_batch[@]}"; do
    [[ -z "${BASELINE_ONLY[$f]:-}" ]] || continue
    sum="$(sha256_of "$MIGRATION_DIR/$f")"

    b64="$(encode_migration "$MIGRATION_DIR/$f")"
    [[ -n "$b64" ]] || die "encoded $f to an empty payload"

    cat >> "$script" <<APPLY_ONE
echo "   -> $f"
printf '%s' '$b64' | base64 -d | gunzip > /tmp/jale-mig.sql
test -s /tmp/jale-mig.sql || { echo "!! $f decoded to nothing" >&2; exit 1; }
test "\$(sha256sum /tmp/jale-mig.sql | cut -d' ' -f1)" = "$sum" \
  || { echo "!! $f failed checksum verification after transfer" >&2; exit 1; }
"\${PG[@]}" -f /tmp/jale-mig.sql
"\${PG[@]}" -q -c "INSERT INTO $LEDGER_TABLE (filename, checksum)
  VALUES ('$f', '$sum')
  ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;"
rm -f /tmp/jale-mig.sql
APPLY_ONE
  done

  printf 'unset PGPASSWORD\necho "%s"\n' "$SENTINEL" >> "$script"
  run_on_bastion "$script" "$label"
}

# Every batch pays this fixed preamble cost once: emit_pg_preamble and
# emit_ledger_ddl are written to the script ahead of any per-file work (see
# apply_batch above). Measured directly rather than hardcoded because its
# size depends on the runtime REGION and DB_SECRET_ARN resolved above, not
# just literal script text.
PREAMBLE_BYTES=$( { emit_pg_preamble; emit_ledger_ddl; } | wc -c )

batch=()
batch_bytes=$PREAMBLE_BYTES
batch_n=0

flush_batch() {
  (( ${#batch[@]} > 0 )) || return 0
  batch_n=$((batch_n + 1))
  note "Applying batch $batch_n (${#batch[@]} file(s))..."
  apply_batch batch "batch-$batch_n"
  batch=()
  batch_bytes=$PREAMBLE_BYTES
}

for f in "${PENDING[@]}"; do
  if [[ -n "${BASELINE_ONLY[$f]:-}" ]]; then
    # A baseline entry ships only an INSERT, not the migration body.
    fsize=200
  else
    fsize=$(encode_migration "$MIGRATION_DIR/$f" | wc -c)
    # Charge the APPLY_ONE wrapper too — what SSM actually receives is the
    # payload wrapped in that heredoc, not the payload alone.
    fsize=$(( fsize + APPLY_ONE_FIXED_BYTES \
                     + APPLY_ONE_FILENAME_OCCURRENCES * ${#f} \
                     + APPLY_ONE_CHECKSUM_OCCURRENCES * CHECKSUM_HEX_LEN ))
    # A file that cannot share a batch with the preamble cannot be sent at
    # all, since every batch carries that preamble. Check against the same
    # budget the packer uses, so the failure names the offending file rather
    # than surfacing later as an oversized batch.
    (( fsize + PREAMBLE_BYTES <= MAX_PAYLOAD_BYTES )) \
      || die "$f encodes to ${fsize}B (payload + wrapper), which with the ${PREAMBLE_BYTES}B preamble exceeds the ${MAX_PAYLOAD_BYTES}B per-command ceiling. Stage it via S3 instead."
  fi
  if (( batch_bytes + fsize > MAX_PAYLOAD_BYTES )); then flush_batch; fi
  batch+=("$f")
  batch_bytes=$((batch_bytes + fsize))
done
flush_batch

if (( ${#PENDING[@]} > 0 )); then
  verify_ledger PENDING
  note "Migrations complete. Ledger updated."
fi

# A fresh-database bootstrap that just applied migrations must not report
# success while every runtime role is left with no usable password. Role
# rotation and jale/whatsapp/db seeding are opt-in (--rotate-secrets, never
# silent), so require the operator to either request them or explicitly
# acknowledge skipping them.
if $FRESH_DATABASE && (( ${n_exec:-0} > 0 )) && ! $ROTATE_SECRETS && ! $SKIP_SECRETS; then
  echo "!! This looks like a fresh-database bootstrap: $LEDGER_TABLE was absent or empty before this run, and migrations were just applied." >&2
  echo "!! Without --rotate-secrets, these roles have no usable password: jale_matching, jale_admin_console, jale_billing, jale_whatsapp, jale_public_jobs." >&2
  echo "!! The secret $WA_DB_SECRET_NAME does not exist." >&2
  echo "!! Re-run with --rotate-secrets to provision them, or pass --skip-secrets to acknowledge this and continue anyway." >&2
  die "refusing to report success from a fresh-database bootstrap with credential-less roles"
fi

if $FRESH_DATABASE && (( ${n_exec:-0} > 0 )) && $SKIP_SECRETS && ! $ROTATE_SECRETS; then
  note "--skip-secrets acknowledged: jale_matching, jale_admin_console, jale_billing, jale_whatsapp, jale_public_jobs have no usable password and $WA_DB_SECRET_NAME was not created."
fi

# ---------------------------------------------------------------------------
# Optional: role password rotation + jale/whatsapp/db seeding.
# ---------------------------------------------------------------------------
if $ROTATE_SECRETS; then
  note "Rotating role passwords and reseeding $WA_DB_SECRET_NAME..."
  {
    emit_pg_preamble
    cat <<ROTATE
MATCHING_PW=\$(aws secretsmanager get-secret-value --secret-id "$MATCHING_SECRET_ARN" \
  --region "\$REGION" --query SecretString --output text | jq -r .password)
"\${PG[@]}" -q -c "ALTER ROLE jale_matching WITH PASSWORD '\$MATCHING_PW';"

ADMIN_CONSOLE_PW=\$(aws secretsmanager get-secret-value --secret-id "$ADMIN_CONSOLE_SECRET_ARN" \
  --region "\$REGION" --query SecretString --output text | jq -r .password)
"\${PG[@]}" -q -c "ALTER ROLE jale_admin_console WITH PASSWORD '\$ADMIN_CONSOLE_PW';"

BILLING_PW=\$(aws secretsmanager get-secret-value --secret-id "$BILLING_SECRET_ARN" \
  --region "\$REGION" --query SecretString --output text | jq -r .password)
"\${PG[@]}" -q -c "ALTER ROLE jale_billing WITH PASSWORD '\$BILLING_PW';"

# jale_public_jobs: copy the CDK-generated vault password onto the role, then
# PROVE the login works before this session can report success. The check also
# exercises the role's one grant (public job columns), so both password drift
# and a broken grant die here on the bastion instead of surfacing as a public
# page that 500s every request. Neither value is ever printed.
PUBLIC_JOBS_PW=\$(aws secretsmanager get-secret-value --secret-id "$REFERRALS_SECRET_ARN" \
  --region "\$REGION" --query SecretString --output text | jq -r .password)
"\${PG[@]}" -q -c "ALTER ROLE jale_public_jobs WITH PASSWORD '\$PUBLIC_JOBS_PW';"
PUBLIC_JOBS_CHECK=\$(PGPASSWORD="\$PUBLIC_JOBS_PW" psql -h "\$DB_HOST" -p "\$DB_PORT" \
  -U jale_public_jobs -d "\$DB_NAME" -v ON_ERROR_STOP=1 \
  -tAc "SELECT count(*) FROM jobs WHERE public_listing_enabled") || {
  echo "!! jale_public_jobs credential check FAILED — vault and database disagree, or the role's grant on jobs is broken" >&2
  exit 1
}
echo "   jale_public_jobs credential check OK (\$PUBLIC_JOBS_CHECK publicly listed jobs)"

WA_PW=\$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-24)
"\${PG[@]}" -q -c "ALTER ROLE jale_whatsapp WITH PASSWORD '\$WA_PW';"

SECRET_STRING=\$(jq -n --arg host "\$DB_HOST" --arg port "\$DB_PORT" --arg dbname "\$DB_NAME" \
  --arg username "jale_whatsapp" --arg password "\$WA_PW" \
  '{host: \$host, port: (\$port | tonumber), dbname: \$dbname, username: \$username, password: \$password}')

if aws secretsmanager describe-secret --secret-id "$WA_DB_SECRET_NAME" --region "\$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$WA_DB_SECRET_NAME" --region "\$REGION" \
    --secret-string "\$SECRET_STRING" >/dev/null
  echo "   updated existing $WA_DB_SECRET_NAME"
else
  aws secretsmanager create-secret --name "$WA_DB_SECRET_NAME" --region "\$REGION" \
    --description "jale_whatsapp role credentials for WhatsApp Lambdas" \
    --secret-string "\$SECRET_STRING" >/dev/null
  echo "   created $WA_DB_SECRET_NAME"
fi

unset PGPASSWORD WA_PW SECRET_STRING MATCHING_PW ADMIN_CONSOLE_PW BILLING_PW PUBLIC_JOBS_PW PUBLIC_JOBS_CHECK
echo "$SENTINEL"
ROTATE
  } > "$WORKDIR/rotate.sh"
  run_on_bastion "$WORKDIR/rotate.sh" "rotate role secrets"
  note "Secrets rotated. WhatsApp Lambdas will error until they refetch $WA_DB_SECRET_NAME."
fi

echo
note "All done. Next:"
echo "   cd infra && npx cdk destroy JaleBastionStack    # cost hygiene"
echo "   gh workflow run deploy-production.yml --ref prod -f deploy_scope=all"
