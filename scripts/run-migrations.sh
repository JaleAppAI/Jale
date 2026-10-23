#!/usr/bin/env bash
#
# run-migrations.sh — Apply DB migrations against the Jale RDS via the
# ephemeral BastionStack.
#
#   1. Deploy the bastion: `bash scripts/deploy-bastion.sh`
#   2. Run this script:    `bash scripts/run-migrations.sh`
#   3. Destroy the bastion: `bash scripts/deploy-bastion.sh --destroy`
#
# Usage:
#   bash scripts/run-migrations.sh [--dry-run] [--baseline-through FILE]
#                                  [--rotate-secrets] [--skip-secrets]
#                                  [--force-replay] [--accept-posture-change]
#                                  [--yes]
#   bash scripts/run-migrations.sh --prepare-logins [--only LOGIN] [--dry-run]
#                                  [--accept-posture-change] [--yes]
#   bash scripts/run-migrations.sh --enable-pgaudit [--confirm-cutover-verified]
#                                  [--dry-run] [--accept-posture-change] [--yes]
#   bash scripts/run-migrations.sh --disable-master-audit [--dry-run]
#                                  [--accept-posture-change] [--yes]
#   bash scripts/run-migrations.sh --audit-status [--since UTC-TIME]
#   bash scripts/run-migrations.sh --list-holds
#   bash scripts/run-migrations.sh --release-hold STREAM SEQ [--yes]
#   bash scripts/run-migrations.sh --redact-and-release SEQ [--yes]
#   bash scripts/run-migrations.sh --report FILE
#
#   Every form also takes --without-command-log (see "Command output" below),
#   and the last five --accept-posture-change.
#
#   --dry-run         Resolve state and print the plan; change nothing. With
#                     --prepare-logins: check every login, change nothing.
#                     With --enable-pgaudit or --disable-master-audit: read
#                     the engine audit state and say what would change.
#   --baseline-through FILE
#                     Record every migration up to and including FILE as
#                     applied WITHOUT executing it, then apply everything
#                     after it normally. This is how a database that was
#                     migrated before the ledger existed adopts the ledger.
#                     FILE must name a migration in the manifest. Nothing
#                     checks the recorded files against the database: a
#                     FILE later than the last migration really applied
#                     records the ones in between as applied, and they are
#                     never run. Verify the database's state on its own
#                     before choosing FILE.
#   --rotate-secrets  Also reset the jale_matching / jale_admin_console /
#                     jale_billing role passwords from their generated
#                     secrets, mint a new jale_whatsapp password, and seed
#                     jale/whatsapp/db. NOT part of a routine migration run:
#                     rotating jale_whatsapp breaks in-flight Lambda
#                     containers until they refetch the secret. Passwords
#                     reach the database only as SCRAM-SHA-256 verifiers.
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
#   --prepare-logins  Prepare the least-privilege database logins instead of
#                     applying migrations. For each login the access manifest
#                     marks "prepare_secret": true (infra/db/access/
#                     manifest.json and manifest.d/*.json): check the role
#                     the migrations created, create the login's secret from an
#                     AWS-generated password if it does not exist yet (an
#                     existing secret is reused, never rotated), set the
#                     database password from a SCRAM-SHA-256 verifier, and
#                     prove the login signs in. jale_ai is then synced from
#                     its CDK-generated secret the same way. Prints one
#                     status line per login and never a value. Idempotent.
#                     Never combined with --rotate-secrets.
#   --only LOGIN      With --prepare-logins: prepare just this login.
#   --accept-posture-change
#                     Continue even though the posture control reads
#                     something other than its baseline (see below). Both
#                     readings are printed either way.
#   --enable-pgaudit  Turn on engine audit logging instead of applying
#                     migrations. It first checks, as the master login, that
#                     the server loaded pgaudit (shared_preload_libraries) and
#                     that log_error_verbosity is terse, and refuses to change
#                     anything otherwise: both come from the audit parameter
#                     group, which a maintenance window attaches. Then, in one
#                     transaction: CREATE EXTENSION IF NOT EXISTS pgaudit, and
#                     pgaudit.log = 'all' for every personal login
#                     (jale_person_*). Prints statuses and counts only.
#                     Idempotent.
#   --confirm-cutover-verified
#                     With --enable-pgaudit: also set pgaudit.log = 'all' for
#                     the master login. Give it only once the least-privilege
#                     cutover is verified, when no workload signs in as the
#                     master any more; otherwise every workload statement
#                     would be logged.
#   --disable-master-audit
#                     Reset the master login's pgaudit.log (ALTER ROLE
#                     jale_admin RESET pgaudit.log) instead of applying
#                     migrations. Part of a rollback that puts workloads back
#                     on the master. Personal logins keep their setting.
#   --audit-status    Print, as the master login, the audit export's state per
#                     stream (jale_ops.audit_export_status) and the access
#                     events per kind, outcome and surface
#                     (jale_ops.audit_event_counts). Changes nothing.
#   --since UTC-TIME  With --audit-status: count access events from this time,
#                     written like 2026-10-01T00:00:00Z (default: the last
#                     24 hours).
#   --list-holds      Print the rows the audit export held back for review
#                     (jale_audit.list_holds): stream, seq, times, surface
#                     (none for records without one) and the kind of pattern
#                     that matched (url, email, phone, several or none), never
#                     the value. Changes nothing.
#   --release-hold STREAM SEQ
#                     Release one held row as it is (jale_audit.release_hold),
#                     after review found no value in it. STREAM is events,
#                     changes or admin_actions_legacy.
#   --redact-and-release SEQ
#                     Replace a held event's reason with '[redacted]' and
#                     release it (jale_audit.redact_and_release). Events only.
#   --report FILE     Run the queries in FILE as the master login and print
#                     their results: a read-only report. FILE is checked here
#                     before anything is sent. It holds SELECT, WITH, VALUES
#                     and TABLE statements only, each ending with a
#                     semicolon, and comments only on lines of their own that
#                     start with --. Anything else is refused: a backslash
#                     (psql commands), INSERT, UPDATE, DELETE, MERGE or INTO
#                     anywhere, any other statement, any other comment. The
#                     comment lines are not sent. The queries run in one
#                     read-only transaction, in a session whose default is
#                     read-only, and the transaction is rolled back. The
#                     output is their results, never the queries. Changes
#                     nothing.
#   --without-command-log
#                     Send this run's commands even though the ops-command log
#                     group does not exist yet, so their output is not
#                     recorded. Only before the audit stack's first deploy;
#                     refused once the group exists.
#   --yes             Skip the interactive confirmation prompt.
#
# Command output: every command this script sends to the ops host asks Run
# Command to copy its output to the ops-command log group, and the request is
# checked for that before it is sent. The group is created by the audit stack,
# so every run first checks that it exists (a count, nothing else) and stops
# when it does not, unless --without-command-log says that this run comes
# before the audit stack's first deploy. The output itself is statuses only.
#
# Posture control: every run first reads, as the master login, the
# row_security_active() value on public.users and the engine's major
# version, and compares them with the reviewed baseline. The baseline for
# the master's reading is supplied by the operator, from the release
# record, in POSTURE_BASELINE_MASTER_ROW_SECURITY (t or f); the
# engine's is EXPECTED_ENGINE_MAJOR in this script. Every run, --dry-run
# included, refuses to start unless that variable is exactly t or f, before
# anything reaches AWS; the refusal names the variable and never prints what
# it holds. A different reading stops the run before it changes anything,
# unless --accept-posture-change.
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
# --prepare-logins and --rotate-secrets also need python3 on the bastion
# (Amazon Linux 2023 ships it) for scripts/lib/scram-verifier.py, which this
# script sends along inside the payload.

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
# The log group Run Command copies every command's output to. The audit stack
# creates it under this fixed name; the ops host may write to it, never
# create it.
OPS_COMMAND_LOG_GROUP="/jale/audit/ops-command"

# SSM caps the SendCommand request; stay well under it. Migrations are gzipped
# before base64 so the whole corpus fits comfortably, but batches are still
# capped so that a fresh database cannot build one oversized request.
MAX_PAYLOAD_BYTES=60000

# Waiting for a command on the ops host. No request sets either of Run
# Command's timeouts, so its defaults apply: an hour to deliver the command
# and an hour to run it, after which it ends TimedOut. The wait polls every
# SSM_POLL_SECONDS, at most SSM_MAX_POLLS times: a little over those two
# hours, after which the command will not report back.
SSM_POLL_SECONDS=5
SSM_MAX_POLLS=1500

# Overhead added by apply_batch()'s APPLY_ONE heredoc around each migration
# file's base64 payload. The payload itself ($b64) is already counted
# separately via `encode_migration | wc -c`; everything else in that heredoc
# is measured here so the batch packer accounts for what SSM actually
# receives, not just the payload. Measured by rendering APPLY_ONE with
# f="" sum="" b64="" (and LEDGER_TABLE at its real value) and piping the
# result through `wc -c`: 729 bytes. It was 502 before the change that added the
# stderr-capture wrapper around the apply, which is worth 189 bytes per file
# and shrinks each batch by that much, and 691 before the apply and its
# ledger INSERT asked psql for terse errors (38 bytes). Within that fixed
# text, the filename ($f) is substituted 4 times -- the "-> $f" progress
# line, the "decoded to nothing" and "failed checksum verification" error
# messages, and the ledger INSERT's VALUES list -- and the checksum ($sum) is
# substituted 2 times -- the transfer-verification test and that same
# INSERT. Recompute APPLY_ONE_FIXED_BYTES if APPLY_ONE's body changes.
APPLY_ONE_FIXED_BYTES=729
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
PREPARE_LOGINS=false
PREPARE_ONLY=""
ACCEPT_POSTURE_CHANGE=false
ENABLE_PGAUDIT=false
CONFIRM_CUTOVER_VERIFIED=false
DISABLE_MASTER_AUDIT=false
WITHOUT_COMMAND_LOG=false
AUDIT_STATUS=false
AUDIT_SINCE=""
AUDIT_SINCE_GIVEN=false
LIST_HOLDS=false
RELEASE_HOLD=false
REDACT_AND_RELEASE=false
HOLD_STREAM=""
HOLD_SEQ=""
REPORT=false
REPORT_FILE=""

usage_error() { echo "!! $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --baseline-through)
      [[ $# -ge 2 ]] || usage_error "--baseline-through needs a migration filename"
      BASELINE_THROUGH="$2"; shift ;;
    --rotate-secrets) ROTATE_SECRETS=true ;;
    --skip-secrets)   SKIP_SECRETS=true ;;
    --force-replay)   FORCE_REPLAY=true ;;
    --prepare-logins) PREPARE_LOGINS=true ;;
    --only)
      [[ $# -ge 2 ]] || usage_error "--only needs a login name"
      [[ -z "$PREPARE_ONLY" ]] || usage_error "--only may be given once"
      PREPARE_ONLY="$2"; shift ;;
    --accept-posture-change) ACCEPT_POSTURE_CHANGE=true ;;
    --enable-pgaudit) ENABLE_PGAUDIT=true ;;
    --confirm-cutover-verified) CONFIRM_CUTOVER_VERIFIED=true ;;
    --disable-master-audit) DISABLE_MASTER_AUDIT=true ;;
    --without-command-log) WITHOUT_COMMAND_LOG=true ;;
    --audit-status)   AUDIT_STATUS=true ;;
    --since)
      [[ $# -ge 2 ]] || usage_error "--since needs a UTC time like 2026-10-01T00:00:00Z"
      AUDIT_SINCE_GIVEN=true; AUDIT_SINCE="$2"; shift ;;
    --list-holds)     LIST_HOLDS=true ;;
    --release-hold)
      [[ $# -ge 3 ]] || usage_error "--release-hold needs a stream and a seq"
      RELEASE_HOLD=true; HOLD_STREAM="$2"; HOLD_SEQ="$3"; shift 2 ;;
    --redact-and-release)
      [[ $# -ge 2 ]] || usage_error "--redact-and-release needs a seq"
      REDACT_AND_RELEASE=true; HOLD_STREAM="events"; HOLD_SEQ="$2"; shift ;;
    --report)
      [[ $# -ge 2 ]] || usage_error "--report needs a SQL file"
      if $REPORT; then usage_error "--report may be given once"; fi
      REPORT=true; REPORT_FILE="$2"; shift ;;
    --yes|-y)         ASSUME_YES=true ;;
    # The usage block is the header up to the first "# ---" rule line.
    -h|--help)        awk 'NR > 1 && /^# ---/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    *) usage_error "Unknown argument: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Least-privilege database logins (--prepare-logins).
# ---------------------------------------------------------------------------
# The logins to prepare come from the access manifest, the reviewed list of
# the logins the migrations create: every entry marked "prepare_secret": true,
# with the connection limit its role is created with. The manifest is
# manifest.json plus any fragments in manifest.d/*.json; a fragment adds
# entries and never repeats one, so a login listed in two files is refused.
# This script keeps no list of its own, so a login added to the manifest (with
# its migration) is prepared without touching this file. Each one gets its own
# secret, named by prepare_secret_name(). Only the names and limits reach the
# bastion.
ACCESS_DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/db/access"
ACCESS_MANIFEST="$ACCESS_DIR/manifest.json"
ACCESS_FRAGMENT_DIR="$ACCESS_DIR/manifest.d"
PREPARE_NEW_LOGINS=()
# Existing logins whose password is synced from their CDK-generated secret
# (never created or rewritten here).
PREPARE_SYNC_LOGINS=("jale_ai")

# A login name: "jale_" and lowercase ASCII words joined by single
# underscores, the rule the CDK secret-name helper enforces, so a login the
# stacks accept is never refused here. The C locale keeps [a-z] to ASCII.
is_login_name() { local LC_ALL=C; [[ "$1" =~ ^jale_[a-z0-9]+(_[a-z0-9]+)*$ ]]; }

load_prepare_logins() {
  local files=() f rel lines dupes name limit kind sync
  command -v jq >/dev/null 2>&1 || usage_error "--prepare-logins needs jq to read the access manifest"
  [[ -f "$ACCESS_MANIFEST" ]] \
    || usage_error "the access manifest is missing ($ACCESS_MANIFEST); it lists the logins to prepare, so run from the release commit"
  files=("$ACCESS_MANIFEST")
  # Every fragment, if there are any: an unmatched glob stays literal and is skipped.
  for f in "$ACCESS_FRAGMENT_DIR"/*.json; do
    [[ -e "$f" ]] && files+=("$f")
  done
  for f in "${files[@]}"; do
    rel="${f#"$ACCESS_DIR"/}"
    jq -e 'type == "object" and ((.logins // {}) | type == "object")' "$f" >/dev/null 2>&1 \
      || usage_error "the access manifest is not readable JSON with a logins object ($rel)"
  done
  # A login listed in more than one file is refused, whatever the files say:
  # merging would silently keep one of the entries.
  dupes=$(jq -rn --arg dir "$ACCESS_DIR/" \
            '[inputs | input_filename as $f | (.logins // {}) | keys[] | {name: ., file: ($f | ltrimstr($dir))}]
             | group_by(.name)[] | select(length > 1)
             | "\(.[0].name) (\(map(.file) | join(", ")))"' "${files[@]}" 2>/dev/null) \
    || usage_error "the access manifest could not be read for duplicate logins"
  [[ -z "$dupes" ]] \
    || usage_error "the access manifest lists a login in more than one file: ${dupes//$'\n'/; }. A fragment adds logins and never repeats one."
  lines=$(jq -rs 'map(.logins // {}) | add | to_entries[] | select(.value.prepare_secret == true)
                  | "\(.key)|\(.value.connection_limit)|\(.value.kind)"' "${files[@]}" 2>/dev/null) \
    || usage_error "the access manifest is not readable JSON ($ACCESS_MANIFEST)"
  while IFS='|' read -r name limit kind; do
    [[ -n "$name" ]] || continue
    is_login_name "$name" \
      || usage_error "the access manifest marks an entry for preparation whose name is not a login name"
    [[ "$limit" =~ ^-?[0-9]+$ ]] \
      || usage_error "the access manifest gives $name no whole-number connection_limit"
    case "$kind" in
      request|public|job|posture) ;;
      *) usage_error "the access manifest marks $name for preparation, but its kind is '$kind'; only request, public, job and posture logins get a prepared secret" ;;
    esac
    for sync in "${PREPARE_SYNC_LOGINS[@]}"; do
      [[ "$name" != "$sync" ]] || usage_error "the access manifest marks $name for preparation, but it is synced from its CDK-generated secret instead"
    done
    PREPARE_NEW_LOGINS+=("$name|$limit")
  done <<<"$lines"
  (( ${#PREPARE_NEW_LOGINS[@]} > 0 )) \
    || usage_error "the access manifest marks no login with \"prepare_secret\": true ($ACCESS_MANIFEST and manifest.d/); nothing to prepare"
}

# The one place a new login's secret name is derived: the login without its
# "jale_" prefix, underscores turned into hyphens, in the repo's existing
# jale/<name>/db secret naming. The CDK imports and the ops host's IAM grant
# follow the same rule.
prepare_secret_name() {
  local slug="${1#jale_}"
  printf 'jale/%s/db' "${slug//_/-}"
}

if $PREPARE_LOGINS; then
  if $ROTATE_SECRETS; then
    usage_error "--prepare-logins never runs with --rotate-secrets: that mode re-mints the WhatsApp login's password and resets four others. Run each only when it is intended, separately."
  fi
  if [[ -n "$BASELINE_THROUGH" ]] || $FORCE_REPLAY || $SKIP_SECRETS; then
    usage_error "--prepare-logins applies no migrations, so --baseline-through, --force-replay and --skip-secrets do not apply to it"
  fi
  load_prepare_logins
  if [[ -n "$PREPARE_ONLY" ]]; then
    only_known=false
    for entry in "${PREPARE_NEW_LOGINS[@]}" "${PREPARE_SYNC_LOGINS[@]}"; do
      if [[ "${entry%%|*}" == "$PREPARE_ONLY" ]]; then only_known=true; fi
    done
    $only_known || usage_error "--only '$PREPARE_ONLY' is not a login --prepare-logins prepares"
  fi
elif [[ -n "$PREPARE_ONLY" ]]; then
  usage_error "--only needs --prepare-logins"
fi

# The engine audit modes and the audit operations (the read-only report among
# them) are runs of their own: no migration, no credential, and one of them at
# a time.
AUDIT_OPERATION=false
if $AUDIT_STATUS || $LIST_HOLDS || $RELEASE_HOLD || $REDACT_AND_RELEASE || $REPORT; then AUDIT_OPERATION=true; fi
n_modes=0
for mode in "$PREPARE_LOGINS" "$ENABLE_PGAUDIT" "$DISABLE_MASTER_AUDIT" \
            "$AUDIT_STATUS" "$LIST_HOLDS" "$RELEASE_HOLD" "$REDACT_AND_RELEASE" "$REPORT"; do
  if $mode; then n_modes=$((n_modes + 1)); fi
done
(( n_modes <= 1 )) \
  || usage_error "--prepare-logins, --enable-pgaudit, --disable-master-audit, --audit-status, --list-holds, --release-hold, --redact-and-release and --report are separate runs; give one of them"
if $ENABLE_PGAUDIT || $DISABLE_MASTER_AUDIT || $AUDIT_OPERATION; then
  if $ROTATE_SECRETS || [[ -n "$BASELINE_THROUGH" ]] || $FORCE_REPLAY || $SKIP_SECRETS; then
    usage_error "the engine audit and audit operation runs apply no migrations and change no password, so --rotate-secrets, --baseline-through, --force-replay and --skip-secrets do not apply to them"
  fi
fi
if $CONFIRM_CUTOVER_VERIFIED && ! $ENABLE_PGAUDIT; then
  usage_error "--confirm-cutover-verified needs --enable-pgaudit"
fi
if $AUDIT_SINCE_GIVEN && ! $AUDIT_STATUS; then
  usage_error "--since needs --audit-status"
fi
if $AUDIT_OPERATION && $DRY_RUN; then
  usage_error "--dry-run does not apply to --audit-status, --list-holds, --report, --release-hold or --redact-and-release: the first three change nothing, and --list-holds shows what the other two would act on"
fi

# The audit operations' inputs, checked here: they reach the database only as
# psql variables, but nothing unchecked is sent at all.
AUDIT_STREAMS=(events changes admin_actions_legacy)
# A bigint from 1 to 9223372036854775807.
is_hold_seq() { local LC_ALL=C; [[ "$1" =~ ^[1-9][0-9]{0,18}$ ]] && { (( ${#1} < 19 )) || [[ ! "$1" > "9223372036854775807" ]]; }; }
# A UTC time to the second: 2026-10-01T00:00:00Z.
is_utc_timestamp() { local LC_ALL=C; [[ "$1" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$ ]]; }
if $AUDIT_SINCE_GIVEN; then
  is_utc_timestamp "$AUDIT_SINCE" || usage_error "--since must be a UTC time like 2026-10-01T00:00:00Z"
fi
if $RELEASE_HOLD; then
  stream_known=false
  for stream in "${AUDIT_STREAMS[@]}"; do
    if [[ "$HOLD_STREAM" == "$stream" ]]; then stream_known=true; fi
  done
  $stream_known || usage_error "the stream must be events, changes or admin_actions_legacy"
fi
if $RELEASE_HOLD || $REDACT_AND_RELEASE; then
  is_hold_seq "$HOLD_SEQ" || usage_error "the seq must be a whole number from 1 to 9223372036854775807"
fi

# The read-only report's file, checked here, before anything is sent, and
# refused unless it plainly only reads: SELECT, WITH, VALUES and TABLE
# statements, each ending with a semicolon, with comments only on lines of
# their own that start with --. Those lines are left empty, so line numbers
# hold; a comment anywhere else is refused, so no comment can carry part of a
# statement past this check. Statements are split at every semicolon, those
# inside quotes included, so each statement psql would send starts one of the
# pieces checked. A refusal names the rule and the line, never the text. Sets
# REPORT_SQL to what is sent: exactly the text checked here.
REPORT_SQL=""
check_report_file() {
  local LC_ALL=C file="$1" line upper text="" rest piece lead nl word
  local n=0 at=1 start_line statements=0
  local anywhere='[^A-Z0-9_](INSERT|UPDATE|DELETE|MERGE|INTO)[^A-Z0-9_]'
  local first_word='^[[:space:](]*([A-Za-z_]+)'
  [[ -f "$file" && -r "$file" ]] || usage_error "--report: the file does not exist or cannot be read"
  [[ -s "$file" ]] || usage_error "--report: the file is empty"
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ "$line" =~ ^[[:space:]]*-- ]]; then text+=$'\n'; continue; fi
    if [[ "$line" == *\\* ]]; then
      usage_error "--report: line $n holds a backslash; psql commands are refused"
    fi
    if [[ "$line" == *--* || "$line" == */\** || "$line" == *\*/* ]]; then
      usage_error "--report: line $n holds a comment that is not on a line of its own; start each comment line with --"
    fi
    upper=" ${line^^} "
    if [[ "$upper" =~ $anywhere ]]; then
      usage_error "--report: line $n holds ${BASH_REMATCH[1]}; a report only reads, so INSERT, UPDATE, DELETE, MERGE and INTO are refused anywhere, a WITH query included"
    fi
    text+="$line"$'\n'
  done < "$file"
  rest="$text"
  while [[ "$rest" == *';'* ]]; do
    piece="${rest%%;*}"
    rest="${rest#*;}"
    if [[ ! "$piece" =~ ^[[:space:]]*$ ]]; then
      lead="${piece%%[![:space:](]*}"
      nl="${lead//[!$'\n']/}"
      start_line=$((at + ${#nl}))
      word=""
      if [[ "$piece" =~ $first_word ]]; then word="${BASH_REMATCH[1]^^}"; fi
      case "$word" in
        SELECT|WITH|VALUES|TABLE) statements=$((statements + 1)) ;;
        BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE|SET|RESET|DISCARD|LOCK|COPY|DO|CALL|VACUUM|ANALYZE|CHECKPOINT|LISTEN|NOTIFY)
          usage_error "--report: the statement on line $start_line starts with $word; transaction control and session statements are refused (the report runs in a read-only transaction of its own)" ;;
        INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|SECURITY|REFRESH|REINDEX|CLUSTER|IMPORT)
          usage_error "--report: the statement on line $start_line starts with $word; data and schema changes are refused" ;;
        *)
          usage_error "--report: the statement on line $start_line does not start with SELECT, WITH, VALUES or TABLE" ;;
      esac
    fi
    nl="${piece//[!$'\n']/}"
    at=$((at + ${#nl}))
  done
  [[ "$rest" =~ ^[[:space:]]*$ ]] || usage_error "--report: the last statement does not end with a semicolon"
  (( statements > 0 )) || usage_error "--report: the file holds no statement"
  REPORT_SQL="$text"
}
if $REPORT; then
  check_report_file "$REPORT_FILE"
fi

# The posture control's baseline for the master's reading (see the header):
# checked once the arguments are, before anything else runs. Every run
# compares its reading with it, so none starts without a valid one. The
# refusal names the variable; what it holds is never printed.
if [[ "${POSTURE_BASELINE_MASTER_ROW_SECURITY:-}" != "t" && "${POSTURE_BASELINE_MASTER_ROW_SECURITY:-}" != "f" ]]; then
  echo "!! POSTURE_BASELINE_MASTER_ROW_SECURITY is not set to t or f." >&2
  echo "   Export the reviewed baseline from the release record, then re-run. Every" >&2
  echo "   run compares the posture control's reading with it, --dry-run included." >&2
  exit 1
fi

# Selected for this run: everything, or the one --only names.
prepare_selected() { [[ -z "$PREPARE_ONLY" || "$PREPARE_ONLY" == "$1" ]]; }

SCRAM_HELPER="$(cd "$(dirname "$0")" && pwd)/lib/scram-verifier.py"

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
  "080_whatsapp_application_fill.sql"
  "081_whatsapp_application_defaults_read.sql"
  "082_employer_digest_settings.sql"
  "083_media_board.sql"
  "084_preferred_cities_whatsapp_write.sql"
  "085_employer_trust_assessment_read.sql"
  "086_trust_extractions_and_web_onboarding.sql"
  "087_bind_reuses_ready_web_worker.sql"
  "088_admin_analytics.sql"
  "089_admin_analytics_rls_repair.sql"
  "090_email_outbox_delivery_metadata.sql"
  "091_application_stages.sql"
  "092_onboarding_cleanup_drops.sql"
  "093_worker_intent_outbox_defer.sql"
  "094_sprint24_data_backfills.sql"
  "095_application_hire_ack.sql"
  "096_job_conversations_employer_read_backfill.sql"
  "097_twilio_callback_job_message_outbox.sql"
  "098_admin_analytics_hires_and_delivery.sql"
  "099_job_application_status_events.sql"
  "100_subscription_status_history.sql"
  "101_worker_identity_challenge_events.sql"
  "102_admin_identity_lockouts.sql"
  "103_worker_referred_jobs.sql"
  "104_least_privilege_logins.sql"
  "105_least_privilege_capability_functions.sql"
  "106_least_privilege_access_rights.sql"
  "107_problem_reports_schema.sql"
  "108_problem_reports_functions.sql"
  "109_audit_storage.sql"
  "110_admin_audit_log_freeze.sql"
  "111_audit_change_log.sql"
  "112_audit_operator_functions.sql"
  "113_admin_onboarding_funnel.sql"
  "114_admin_employer_health.sql"
  "114b_access_manifest_alignment.sql"
  "115_admin_ops_health.sql"
  "117_admin_queues.sql"
  "118_employer_organizations.sql"
  "119_employer_org_owner_access.sql"
  "120_admin_access.sql"
  "121_whatsapp_support_mode.sql"
  "122_admin_inbox.sql"
  "123_admin_analytics_s28.sql"
  "124_analytics_capture.sql"
  "125_hire_details_and_billing_resume.sql"
  "126_job_conversations_whatsapp_update_columns.sql"
  "127_company_billing.sql"
  "128_company_limits.sql"
  "129_org_owner_carry_overs.sql"
  "130_user_tutorial_progress.sql"
  "131_job_shift_periods.sql"
  "132_job_limit_increase.sql"
)

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
die()  { echo "!! $*" >&2; exit 1; }
note() { echo ">> $*"; }

# The AWS CLI's error text names accounts, roles and resources, so only its
# error code is ever shown. $1: the file that holds the CLI's stderr.
aws_error_code() {
  local code
  code=$(grep -m 1 -oE 'An error occurred \([A-Za-z0-9]+\)' "$1" 2>/dev/null | sed -E 's/^.*\(([A-Za-z0-9]+)\)$/\1/') || code=""
  printf '%s' "${code:-no error code}"
}

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

  # CloudWatchOutputConfig is the request form of the CLI's
  # --cloud-watch-output-config: Run Command copies the output to the
  # ops-command log group. It is left out only when this run was started with
  # --without-command-log and the group does not exist (COMMAND_LOG=false).
  jq -Rn --rawfile s "$script_file" --arg id "$BASTION_ID" --arg c "$comment" \
        --arg group "$OPS_COMMAND_LOG_GROUP" --argjson logged "$COMMAND_LOG" \
     '{InstanceIds:[$id],DocumentName:"AWS-RunShellScript",Comment:$c,
       Parameters:{commands:[$s]}}
      + (if $logged then {CloudWatchOutputConfig:{CloudWatchOutputEnabled:true,CloudWatchLogGroupName:$group}} else {} end)' \
     > "$request" \
    || die "failed to build the SSM request for $comment"

  [[ -s "$request" ]] || die "built an empty SSM request for $comment"

  # Prove the request really carries a command. An empty commands array is
  # exactly the failure mode this script exists to make impossible.
  jq -e '.Parameters.commands[0] | length > 0' "$request" >/dev/null \
    || die "SSM request for $comment carries no command"

  # And that its output is recorded, unless this run said why it cannot be.
  if $COMMAND_LOG; then
    jq -e --arg group "$OPS_COMMAND_LOG_GROUP" \
       '.CloudWatchOutputConfig == {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}' "$request" >/dev/null \
      || die "SSM request for $comment does not carry the ops-command output config"
  else
    jq -e 'has("CloudWatchOutputConfig") | not' "$request" >/dev/null \
      || die "SSM request for $comment carries an output config this run did not check"
  fi

  # Every AWS call here keeps its stdout only: its error text, which names
  # the account, the role and the instance, goes to a file and only its code
  # is shown.
  local cmd_id
  cmd_id=$(aws ssm send-command --region "$REGION" --cli-input-json "file://$request" \
            --query "Command.CommandId" --output text 2>"$WORKDIR/ssm-send.err") \
    || die "send-command failed for $comment ($(aws_error_code "$WORKDIR/ssm-send.err"))"
  [[ -n "$cmd_id" && "$cmd_id" != "None" ]] || die "no CommandId returned for $comment"

  # Poll and read output with get-command-invocation, NOT
  # list-command-invocations: the latter truncates its Output field at about
  # 2,500 characters, which silently cut the ledger read off at 28 of 51 rows
  # and produced a bogus "migration edited on disk" alarm. get-command-invocation
  # returns up to 24,000 characters of StandardOutputContent.
  local status poll
  for (( poll = 1; ; poll++ )); do
    if status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
                  --instance-id "$BASTION_ID" --query "Status" --output text 2>"$WORKDIR/ssm-wait.err"); then
      case "$status" in
        Success) break ;;
        Failed|Cancelled|TimedOut)
          echo "!! bastion command '$comment' ended: $status" >&2
          # The command's own error output is relayed (a failed migration's
          # error comes back this way); the read's error text is not.
          aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
            --instance-id "$BASTION_ID" --query "StandardErrorContent" --output text >&2 2>"$WORKDIR/ssm-read.err" \
            || echo "!! reading its error output failed ($(aws_error_code "$WORKDIR/ssm-read.err"))" >&2
          exit 1 ;;
      esac
    else
      # Right after the send the invocation may not be visible yet, and a
      # throttled read is worth another try. No other error goes away by
      # waiting: an expired sign-in or a refused read would otherwise stall
      # the run without a word.
      case "$(aws_error_code "$WORKDIR/ssm-wait.err")" in
        InvocationDoesNotExist|ThrottlingException|Throttling|TooManyRequestsException|RequestLimitExceeded) ;;
        *) die "waiting for '$comment' on the ops host failed ($(aws_error_code "$WORKDIR/ssm-wait.err")); its outcome is unknown. Check the ops-command log, and the ledger before re-running." ;;
      esac
    fi
    (( poll < SSM_MAX_POLLS )) \
      || die "'$comment' did not finish on the ops host after $SSM_MAX_POLLS status reads (at least $(( (SSM_MAX_POLLS - 1) * SSM_POLL_SECONDS / 60 )) minutes); its outcome is unknown. Check the ops-command log, and the ledger before re-running."
    sleep "$SSM_POLL_SECONDS"
  done

  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
    --instance-id "$BASTION_ID" --query "StandardOutputContent" --output text > "$out" 2>"$WORKDIR/ssm-read.err" \
    || die "'$comment' ended Success, but reading its output failed ($(aws_error_code "$WORKDIR/ssm-read.err")). Check the ops-command log, and the ledger before re-running."

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
"\${PG[@]}" -v VERBOSITY=terse -At -F '|' -c "SELECT filename, coalesce(checksum,'') FROM $LEDGER_TABLE
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
# The AWS CLI's error text names the account, the role and the secret, and a
# failed command's error output is relayed to the operator and recorded, so a
# failed secret read shows its error code alone.
emit_pg_preamble() {
  cat <<PREAMBLE
#!/bin/bash
set -euo pipefail
REGION="$REGION"
DB_SECRET_ARN="$DB_SECRET_ARN"
SECRET_ERR=\$(mktemp)
if ! SECRET_JSON=\$(aws secretsmanager get-secret-value --secret-id "\$DB_SECRET_ARN" \
    --region "\$REGION" --query SecretString --output text 2>"\$SECRET_ERR"); then
  SECRET_CODE=\$(grep -m 1 -oE 'An error occurred \([A-Za-z0-9]+\)' "\$SECRET_ERR" | sed -E 's/^.*\(([A-Za-z0-9]+)\)\$/\1/') || SECRET_CODE=""
  rm -f "\$SECRET_ERR"
  echo "!! the ops host could not read the master login's secret (\${SECRET_CODE:-no error code})" >&2
  exit 1
fi
rm -f "\$SECRET_ERR"
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
"${PG[@]}" -v VERBOSITY=terse -q -c "
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

# The bastion half of every credential operation (--prepare-logins and
# --rotate-secrets): scripts/lib/scram-verifier.py, shipped inside the payload
# and checksum-verified on arrival, and the shell functions around it. A
# password only ever moves through pipes and a child process's environment;
# it is never an argument, never part of a statement, never printed.
emit_remote_credential_lib() {
  printf "SCRAM_HELPER_B64='%s'\nSCRAM_HELPER_SUM='%s'\n" \
    "$(encode_migration "$SCRAM_HELPER")" "$(sha256_of "$SCRAM_HELPER")"
  cat <<'CREDENTIAL_LIB'
say()  { printf '   %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { warn "$*"; exit 1; }

command -v python3 >/dev/null 2>&1 \
  || fail "python3 is not installed on the bastion; it computes the SCRAM verifiers"
CRED_DIR=$(mktemp -d)
trap 'rm -rf "$CRED_DIR"' EXIT
printf '%s' "$SCRAM_HELPER_B64" | base64 -d | gunzip > "$CRED_DIR/scram-verifier.py"
[[ "$(sha256sum "$CRED_DIR/scram-verifier.py" | cut -d' ' -f1)" == "$SCRAM_HELPER_SUM" ]] \
  || fail "the SCRAM helper failed checksum verification after transfer"

# stdin: a password. stdout: its SCRAM-SHA-256 verifier, format-checked.
scram_verifier() {
  local v
  v=$(python3 "$CRED_DIR/scram-verifier.py") || return 1
  [[ "$v" =~ ^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$ ]] || return 1
  printf '%s' "$v"
}
CREDENTIAL_LIB
}

# The --prepare-logins payload. Everything it prints is a status: a login
# name and what happened to it, never a value, a secret name, an ARN or a
# host. AWS and psql errors are reduced to an error code or a kind, because
# their raw text names resources and hosts.
emit_prepare_payload() {
  emit_pg_preamble
  emit_remote_credential_lib
  printf 'PREPARE_DRY_RUN=%s\n' "$DRY_RUN"
  cat <<'PREPARE_LOGINS'
ERR="$CRED_DIR/stderr"
STATUS="" REASON="" PROOF_PROBLEM="" AWS_CODE="" PSQL_KIND="" LOGIN_PW=""
ROLE_ATTRS_SQL="SELECT r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolconnlimit, (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) FROM pg_catalog.pg_roles r WHERE r.rolname = :'login'"
ROLE_ATTR_NAMES=(rolcanlogin rolsuper rolinherit rolcreaterole rolcreatedb rolreplication rolbypassrls rolconnlimit memberships)
LOGIN_PROBE_SQL="SELECT current_user, (SELECT row_security_active(c.oid) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'users')"

# psql as the master login, with terse errors: a failing statement is never
# echoed back.
master_psql() { "${PG[@]}" -X -q -At -v VERBOSITY=terse "$@"; }

# Sets AWS_CODE from the AWS CLI's captured stderr: the error code only.
aws_error_code() {
  AWS_CODE=$(grep -oE '\([A-Za-z]+(Exception|Error|Fault)\)' "$ERR" 2>/dev/null | head -n 1 | tr -d '()') || AWS_CODE=""
  [[ -n "$AWS_CODE" ]] || AWS_CODE="no error code"
}

# Sets PSQL_KIND from psql's captured stderr: what went wrong, not the text.
psql_error_kind() {
  if grep -q 'password authentication failed' "$ERR" 2>/dev/null; then PSQL_KIND="password rejected"
  elif grep -qE 'could not connect|Connection refused|timeout expired|could not translate host' "$ERR" 2>/dev/null; then PSQL_KIND="could not connect"
  elif grep -q 'does not exist' "$ERR" 2>/dev/null; then PSQL_KIND="role or database not found"
  elif grep -q 'permission denied' "$ERR" 2>/dev/null; then PSQL_KIND="permission denied"
  else PSQL_KIND="query failed"
  fi
}

# stdin: the new password. Wraps it in the secret's value and hands that to
# the AWS CLI on stdin, as --secret-string's file. The name, description and
# tags hold no secret and go on argv. Never --cli-input-json from a pipe: the
# AWS CLI reads that file twice, so a pipe arrives empty and the create fails
# before any request is sent.
create_login_secret() {   # $1 login, $2 secret name
  local tags
  tags=$(jq -nc --arg login "$1" '[
      {Key: "project", Value: "jale"},
      {Key: "db-login", Value: $login},
      {Key: "managed-by", Value: "scripts/run-migrations.sh"}
    ]') || return 1
  jq -Rsjc --arg login "$1" --arg host "$DB_HOST" --arg port "$DB_PORT" --arg dbname "$DB_NAME" \
      '{host: $host, port: ($port | tonumber), dbname: $dbname, username: $login, password: .}' \
    | aws secretsmanager create-secret --region "$REGION" --name "$2" \
        --description "Database credentials for the $1 login, created by scripts/run-migrations.sh --prepare-logins" \
        --tags "$tags" --secret-string file:///dev/stdin
}

# Signs in as the login with the password in LOGIN_PW (a variable, so the
# function runs in this shell and the password reaches psql only through its
# environment), then checks that it is that login and that row-level security
# is active for it on public.users. Sets PROOF_PROBLEM when it is not.
prove_login() {   # $1 login; reads LOGIN_PW
  local got
  PROOF_PROBLEM=""
  got=$(PGPASSWORD="$LOGIN_PW" PGCONNECT_TIMEOUT=10 psql -X -h "$DB_HOST" -p "$DB_PORT" -U "$1" -d "$DB_NAME" \
          -v ON_ERROR_STOP=1 -v VERBOSITY=terse -At -F '|' -c "$LOGIN_PROBE_SQL" 2>"$ERR") \
    || { psql_error_kind; PROOF_PROBLEM="$PSQL_KIND"; return 1; }
  if [[ "$got" == "$1|t" ]]; then return 0; fi
  if [[ "${got%%|*}" != "$1" ]]; then PROOF_PROBLEM="it signed in as another role"
  else PROOF_PROBLEM="row-level security is not active for it on public.users"
  fi
  return 1
}

# One login. Sets STATUS on success and REASON on failure. It runs as an `if`
# condition, where `set -e` does not apply, so every step checks itself.
prepare_login() {   # $1 login, $2 new|sync, $3 connection limit (new only), $4 secret id
  local login="$1" kind="$2" limit="$3" secret_id="$4"
  local attrs want got i state secret_json="" pw="" verifier="" attempt
  local bad=() parts=()

  # 1. The role, exactly as the migrations create it.
  attrs=$(printf '%s\n' "$ROLE_ATTRS_SQL" | master_psql -F '|' -v login="$login" -f - 2>"$ERR") \
    || { psql_error_kind; REASON="the role check failed ($PSQL_KIND)"; return 1; }
  if [[ -z "$attrs" ]]; then REASON="role not found; apply migrations first"; return 1; fi
  # new:  LOGIN NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION
  #       NOBYPASSRLS, its CONNECTION LIMIT, no memberships.
  # sync: the same, except INHERIT and the limit stay as the role was created.
  if [[ "$kind" == new ]]; then want="t|f|f|f|f|f|f|$limit|0"; else want="t|f|*|f|f|f|f|*|0"; fi
  IFS='|' read -r -a got <<<"$attrs"
  IFS='|' read -r -a want <<<"$want"
  for i in "${!ROLE_ATTR_NAMES[@]}"; do
    if [[ "${want[$i]}" != '*' && "${got[$i]:-}" != "${want[$i]}" ]]; then bad+=("${ROLE_ATTR_NAMES[$i]}"); fi
  done
  if (( ${#bad[@]} > 0 )); then
    REASON="role attributes differ from the least-privilege definition (${bad[*]}); refusing to set a password"
    return 1
  fi

  # 2. The secret: reused when it exists, created when it does not.
  if aws secretsmanager describe-secret --secret-id "$secret_id" --region "$REGION" >/dev/null 2>"$ERR"; then
    state=exists
  elif grep -q 'ResourceNotFoundException' "$ERR"; then
    state=missing
  else
    aws_error_code; REASON="checking its secret failed ($AWS_CODE); nothing was changed"; return 1
  fi
  if [[ "$state" == missing ]]; then
    if [[ "$kind" == sync ]]; then
      REASON="its CDK-generated secret was not found; deploy JaleDatabaseStack first"; return 1
    fi
    if $PREPARE_DRY_RUN; then
      STATUS="role ok, secret missing (would be created), password not set yet"; return 0
    fi
    pw=$(aws secretsmanager get-random-password --password-length 40 --exclude-punctuation --require-each-included-type \
           --region "$REGION" --query RandomPassword --output text 2>"$ERR") \
      || { aws_error_code; REASON="generating a password failed ($AWS_CODE); nothing was changed"; return 1; }
    if (( ${#pw} != 40 )); then pw=""; REASON="the generated password has an unexpected length; nothing was changed"; return 1; fi
    printf '%s' "$pw" | create_login_secret "$login" "$secret_id" >/dev/null 2>"$ERR" \
      || { pw=""; aws_error_code; REASON="creating its secret failed ($AWS_CODE); the database was not changed"; return 1; }
    pw=""
    parts+=("secret created")
  else
    parts+=("secret exists")
  fi

  # 3. Read the secret back: the database gets exactly what the workloads
  #    will read. A secret created a moment ago may need a few seconds.
  for attempt in 1 2 3; do
    if secret_json=$(aws secretsmanager get-secret-value --secret-id "$secret_id" --region "$REGION" \
                       --query SecretString --output text 2>"$ERR"); then
      break
    fi
    secret_json=""
    grep -q 'ResourceNotFoundException' "$ERR" || break
    sleep 2
  done
  if [[ -z "$secret_json" ]]; then aws_error_code; REASON="reading its secret failed ($AWS_CODE)"; return 1; fi
  if ! printf '%s' "$secret_json" | jq -e --arg u "$login" --arg h "$DB_HOST" --arg p "$DB_PORT" --arg d "$DB_NAME" \
        '(.username == $u) and (.host == $h) and ((.port | tostring) == $p) and (.dbname == $d)
         and (.password | type == "string" and length >= 20)' >/dev/null 2>&1; then
    secret_json=""
    REASON="its secret does not match this login (username, host, port, dbname or password); nothing was changed"
    return 1
  fi
  pw=$(printf '%s' "$secret_json" | jq -r '.password')
  secret_json=""

  # Dry run: report whether the login already signs in with its secret.
  if $PREPARE_DRY_RUN; then
    LOGIN_PW="$pw"; pw=""
    if prove_login "$login"; then
      STATUS="role ok, secret exists, login verified (no change)"
    else
      STATUS="role ok, secret exists, login does not verify yet (would be synced)"
    fi
    LOGIN_PW=""
    return 0
  fi

  # 4. The database password, from the verifier, on psql's stdin.
  if ! verifier=$(printf '%s' "$pw" | scram_verifier); then
    pw=""; REASON="computing the SCRAM verifier failed; nothing was changed"; return 1
  fi
  if ! printf "ALTER ROLE %s WITH PASSWORD '%s';\n" "$login" "$verifier" | master_psql -f - >/dev/null 2>"$ERR"; then
    pw=""; verifier=""; psql_error_kind; REASON="setting the database password failed ($PSQL_KIND)"; return 1
  fi
  verifier=""
  parts+=("password synced")

  # 5. Prove it.
  LOGIN_PW="$pw"; pw=""
  if ! prove_login "$login"; then
    LOGIN_PW=""; REASON="login check failed ($PROOF_PROBLEM)"; return 1
  fi
  LOGIN_PW=""
  parts+=("login verified")
  STATUS="${parts[0]}"
  for i in "${parts[@]:1}"; do STATUS+=", $i"; done
  return 0
}

DONE_LOGINS=()
BLOCKED=0
run_login() {   # same arguments as prepare_login
  STATUS=""; REASON=""
  if prepare_login "$@"; then
    say "$1: $STATUS"
    DONE_LOGINS+=("$1")
  elif $PREPARE_DRY_RUN; then
    say "$1: blocked: $REASON"
    BLOCKED=$((BLOCKED + 1))
  else
    if (( ${#DONE_LOGINS[@]} > 0 )); then warn "already prepared in this run: ${DONE_LOGINS[*]}"; fi
    fail "$1: $REASON"
  fi
}

PASSWORD_ENCRYPTION=$(master_psql -c "SHOW password_encryption" 2>"$ERR") \
  || { psql_error_kind; fail "reading password_encryption failed ($PSQL_KIND)"; }
[[ "$PASSWORD_ENCRYPTION" == "scram-sha-256" ]] \
  || fail "password_encryption is $PASSWORD_ENCRYPTION, not scram-sha-256; refusing to set any password"
PREPARE_LOGINS
}

# The per-login calls that close the --prepare-logins payload, in order: the
# new logins first, then the synced ones.
emit_prepare_calls() {
  local entry login
  for entry in "${PREPARE_NEW_LOGINS[@]}"; do
    login="${entry%%|*}"
    prepare_selected "$login" || continue
    printf "run_login '%s' new '%s' '%s'\n" "$login" "${entry#*|}" "$(prepare_secret_name "$login")"
  done
  for login in "${PREPARE_SYNC_LOGINS[@]}"; do
    prepare_selected "$login" || continue
    case "$login" in
      jale_ai) printf "run_login '%s' sync '' '%s'\n" "$login" "$AI_SECRET_ARN" ;;
      *) die "no CDK secret is known for $login" ;;
    esac
  done
  cat <<'PREPARE_END'
if $PREPARE_DRY_RUN; then
  say "dry run: ${#DONE_LOGINS[@]} login(s) checked, $BLOCKED blocked; nothing was changed"
else
  say "prepared ${#DONE_LOGINS[@]} login(s)"
fi
unset PGPASSWORD LOGIN_PW
PREPARE_END
  printf 'echo "%s"\n' "$SENTINEL"
}

# ---------------------------------------------------------------------------
# Engine audit logging (--enable-pgaudit, --disable-master-audit).
# ---------------------------------------------------------------------------
# pgAudit's scope is set per role in SQL. The audit parameter group holds only
# the static floor (pgaudit loaded, terse errors), because changing a group
# with static parameters restarts the instance. These payloads run as the
# master login and print statuses and counts only: never a personal login's
# name, a host or a value.

# Shared by the master's engine audit and audit operation payloads.
emit_master_ops_lib() {
  cat <<'MASTER_OPS_LIB'
say()  { printf '   %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { warn "$*"; exit 1; }

AUDIT_DIR=$(mktemp -d)
trap 'rm -rf "$AUDIT_DIR"' EXIT
ERR="$AUDIT_DIR/stderr"

# psql as the master login, with terse errors: a failing statement is never
# echoed back.
master_psql() { "${PG[@]}" -X -q -At -v VERBOSITY=terse "$@"; }
# The same, where an error is reported by its SQLSTATE alone.
master_psql_code() { "${PG[@]}" -X -q -At -v VERBOSITY=sqlstate "$@"; }

# Sets PSQL_KIND from psql's captured stderr: what went wrong, not the text.
psql_error_kind() {
  if grep -q 'password authentication failed' "$ERR" 2>/dev/null; then PSQL_KIND="password rejected"
  elif grep -qE 'could not connect|Connection refused|timeout expired|could not translate host' "$ERR" 2>/dev/null; then PSQL_KIND="could not connect"
  elif grep -q 'permission denied' "$ERR" 2>/dev/null; then PSQL_KIND="permission denied"
  elif grep -q 'must be superuser' "$ERR" 2>/dev/null; then PSQL_KIND="not allowed for this login"
  else PSQL_KIND="query failed"
  fi
}

# Sets SQL_CODE from the captured stderr of master_psql_code: the SQLSTATE,
# or empty when psql did not get as far as a statement.
sql_error_code() {
  SQL_CODE=$(grep -oE 'ERROR:  [0-9A-Z]{5}$' "$ERR" 2>/dev/null | head -n 1 | cut -c 9-13) || SQL_CODE=""
}
MASTER_OPS_LIB
}

# One read of the engine audit state.
emit_engine_audit_lib() {
  cat <<'ENGINE_AUDIT_LIB'
# One row: whether the server loaded pgaudit, log_error_verbosity, the login
# signed in, whether the extension exists, the master's pgaudit.log ('' when
# unset), and how many personal logins exist and how many of them log every
# statement. A personal login is jale_person_ and the handle that
# jale_ops.provision_person accepts.
AUDIT_STATE_SQL=$(cat <<'AUDIT_STATE'
SELECT 'pgaudit' = ANY (pg_catalog.string_to_array(pg_catalog.replace(pg_catalog.current_setting('shared_preload_libraries'), ' ', ''), ',')),
       pg_catalog.current_setting('log_error_verbosity'),
       current_user,
       EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = 'pgaudit'),
       coalesce((SELECT pg_catalog.lower(pg_catalog.substr(c.setting, 13))
                   FROM pg_catalog.pg_roles r, pg_catalog.unnest(r.rolconfig) AS c(setting)
                  WHERE r.rolname = 'jale_admin' AND c.setting LIKE 'pgaudit.log=%'), ''),
       (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname ~ '^jale_person_[a-z][a-z0-9]{1,15}$'),
       (SELECT count(*) FROM pg_catalog.pg_roles r
         WHERE r.rolname ~ '^jale_person_[a-z][a-z0-9]{1,15}$' AND 'pgaudit.log=all' = ANY (r.rolconfig));
AUDIT_STATE
)

# Sets PGAUDIT_LOADED, ERROR_VERBOSITY, PGAUDIT_EXTENSION, MASTER_AUDIT,
# PERSONS and PERSONS_AUDITED. $1 says what a failure here means.
read_audit_state() {
  local row signed_in_as
  row=$(printf '%s\n' "$AUDIT_STATE_SQL" | master_psql -F '|' -f - 2>"$ERR") \
    || { psql_error_kind; fail "reading the engine audit state failed ($PSQL_KIND); $1"; }
  IFS='|' read -r PGAUDIT_LOADED ERROR_VERBOSITY signed_in_as PGAUDIT_EXTENSION MASTER_AUDIT PERSONS PERSONS_AUDITED <<<"$row"
  if [[ "$signed_in_as" != "jale_admin" ]]; then
    fail "the ops host did not sign in as the master login; $1"
  fi
  if [[ ! "$PERSONS" =~ ^[0-9]+$ || ! "$PERSONS_AUDITED" =~ ^[0-9]+$ || ! "$ERROR_VERBOSITY" =~ ^[a-z]+$ ]]; then
    fail "the engine audit state could not be read; $1"
  fi
}

# The master's pgaudit.log, as a status.
master_audit_status() {
  case "$MASTER_AUDIT" in
    "")  printf 'not set' ;;
    all) printf 'all' ;;
    *)   printf 'set to another value' ;;
  esac
}
ENGINE_AUDIT_LIB
}

# The --enable-pgaudit payload: the preflight, then one transaction, then a
# read-back.
emit_enable_pgaudit() {
  printf 'AUDIT_DRY_RUN=%s\nAUDIT_SET_MASTER=%s\n' "$DRY_RUN" "$CONFIRM_CUTOVER_VERIFIED"
  cat <<'PGAUDIT_ENABLE'
# 1. The preflight. Nothing changes unless the server loaded pgaudit and
#    writes terse errors: both come from the audit parameter group, which a
#    maintenance window attaches. Without terse errors the engine log would
#    carry row contents.
read_audit_state "nothing was changed"
if [[ "$PGAUDIT_LOADED" != t || "$ERROR_VERBOSITY" != terse ]]; then
  if [[ "$PGAUDIT_LOADED" != t ]]; then warn "preflight: shared_preload_libraries does not include pgaudit"; fi
  if [[ "$ERROR_VERBOSITY" != terse ]]; then warn "preflight: log_error_verbosity is $ERROR_VERBOSITY, not terse"; fi
  fail "refusing to enable engine audit logging before the audit parameter group is attached; nothing was changed"
fi
say "preflight: pgaudit is loaded and log_error_verbosity is terse"

WAS_EXTENSION="$PGAUDIT_EXTENSION"
WAS_MASTER=$(master_audit_status)
TO_SET=$((PERSONS - PERSONS_AUDITED))

if $AUDIT_DRY_RUN; then
  if [[ "$PGAUDIT_EXTENSION" == t ]]; then say "pgaudit extension: present (no change)"; else say "pgaudit extension: would be created"; fi
  if ! $AUDIT_SET_MASTER; then
    say "master pgaudit.log: $WAS_MASTER (not changed without --confirm-cutover-verified)"
  elif [[ "$MASTER_AUDIT" == all ]]; then
    say "master pgaudit.log: all (no change)"
  else
    say "master pgaudit.log: $WAS_MASTER, would be set to all"
  fi
  say "personal logins: $PERSONS_AUDITED of $PERSONS log every statement; $TO_SET would be set"
  say "dry run: nothing was changed"
else
  # 2. One transaction: the extension, the master when the cutover is
  #    verified, and every personal login.
  enable_sql() {
    printf '%s\n' "CREATE EXTENSION IF NOT EXISTS pgaudit;"
    if $AUDIT_SET_MASTER; then printf '%s\n' "ALTER ROLE jale_admin SET pgaudit.log = 'all';"; fi
    cat <<'PERSONS_SQL'
DO $persons$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT p.rolname FROM pg_catalog.pg_roles p
            WHERE p.rolname ~ '^jale_person_[a-z][a-z0-9]{1,15}$' ORDER BY p.rolname LOOP
    EXECUTE pg_catalog.format('ALTER ROLE %I SET pgaudit.log = %L', r.rolname, 'all');
  END LOOP;
END;
$persons$;
PERSONS_SQL
  }
  enable_sql | master_psql -1 -f - >/dev/null 2>"$ERR" \
    || { psql_error_kind; fail "enabling engine audit logging failed ($PSQL_KIND); the transaction was rolled back and nothing was changed"; }

  # 3. Read it back.
  read_audit_state "the change was committed but could not be read back; check it with --dry-run"
  [[ "$PGAUDIT_EXTENSION" == t ]] || fail "the pgaudit extension is not present after the change"
  if $AUDIT_SET_MASTER && [[ "$MASTER_AUDIT" != all ]]; then fail "the master's pgaudit.log is not all after the change"; fi
  [[ "$PERSONS_AUDITED" == "$PERSONS" ]] \
    || fail "$((PERSONS - PERSONS_AUDITED)) personal login(s) do not log every statement after the change"
  if [[ "$WAS_EXTENSION" == t ]]; then say "pgaudit extension: present (no change)"; else say "pgaudit extension: created"; fi
  if ! $AUDIT_SET_MASTER; then
    say "master pgaudit.log: $(master_audit_status) (not changed without --confirm-cutover-verified)"
  elif [[ "$WAS_MASTER" == all ]]; then
    say "master pgaudit.log: all (no change)"
  else
    say "master pgaudit.log: set to all (was $WAS_MASTER)"
  fi
  say "personal logins: $PERSONS of $PERSONS log every statement ($TO_SET set by this run)"
fi
unset PGPASSWORD
PGAUDIT_ENABLE
  printf 'echo "%s"\n' "$SENTINEL"
}

# The --disable-master-audit payload: the rollback step that stops logging
# every master statement once workloads sign in as the master again.
emit_disable_master_audit() {
  printf 'AUDIT_DRY_RUN=%s\n' "$DRY_RUN"
  cat <<'MASTER_AUDIT_RESET'
read_audit_state "nothing was changed"
WAS_MASTER=$(master_audit_status)
if [[ -z "$MASTER_AUDIT" ]]; then
  say "master pgaudit.log: not set (no change)"
elif $AUDIT_DRY_RUN; then
  say "master pgaudit.log: $WAS_MASTER, would be reset"
else
  printf '%s\n' "ALTER ROLE jale_admin RESET pgaudit.log;" | master_psql -f - >/dev/null 2>"$ERR" \
    || { psql_error_kind; fail "resetting the master's pgaudit.log failed ($PSQL_KIND); nothing was changed"; }
  read_audit_state "the reset was committed but could not be read back; check it with --dry-run"
  [[ -z "$MASTER_AUDIT" ]] || fail "the master's pgaudit.log is still set after the reset"
  say "master pgaudit.log: reset (was $WAS_MASTER)"
fi
say "personal logins: unchanged ($PERSONS_AUDITED of $PERSONS log every statement)"
if $AUDIT_DRY_RUN; then say "dry run: nothing was changed"; fi
unset PGPASSWORD
MASTER_AUDIT_RESET
  printf 'echo "%s"\n' "$SENTINEL"
}

# The master's audit operations (--audit-status, --list-holds, --release-hold,
# --redact-and-release). Each runs fixed statements whose inputs, checked
# locally, arrive as psql variables (:'name'). They print codes, counts,
# stream names, seqs and times only: never a value column, never psql's text.
emit_audit_ops() {
  local op
  if $AUDIT_STATUS; then op=status
  elif $LIST_HOLDS; then op=holds
  elif $RELEASE_HOLD; then op=release
  else op=redact
  fi
  printf "AUDIT_OP='%s'\nAUDIT_SINCE='%s'\nHOLD_STREAM='%s'\nHOLD_SEQ='%s'\n" "$op" "$AUDIT_SINCE" "$HOLD_STREAM" "$HOLD_SEQ"
  cat <<'AUDIT_OPS'
EXPORT_STATUS_SQL=$(cat <<'SQL'
SELECT s.stream, coalesce(to_char(s.watermark_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'never'), s.unexported_rows, s.batches, coalesce(to_char(s.last_batch_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'never'), coalesce(s.last_batch_rows, 0), s.held_rows, s.released_pending FROM jale_ops.audit_export_status() s ORDER BY s.stream;
SQL
)
SINCE_SQL=$(cat <<'SQL'
SELECT to_char(coalesce(nullif(:'since', '')::timestamptz, now() - interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SQL
)
EVENT_COUNTS_SQL=$(cat <<'SQL'
SELECT c.kind, c.outcome, c.surface, c.events FROM jale_ops.audit_event_counts(coalesce(nullif(:'since', '')::timestamptz, now() - interval '24 hours')) c ORDER BY c.kind, c.outcome, c.surface;
SQL
)
HOLDS_COUNT_SQL=$(cat <<'SQL'
SELECT count(*) FROM jale_audit.list_holds();
SQL
)
LIST_HOLDS_SQL=$(cat <<'SQL'
SELECT h.stream, h.seq, to_char(h.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), coalesce(h.surface, 'none'), to_char(h.held_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), h.pattern_kind FROM jale_audit.list_holds() h ORDER BY h.held_at, h.stream, h.seq LIMIT 200;
SQL
)
RELEASE_HOLD_SQL=$(cat <<'SQL'
SELECT jale_audit.release_hold(:'stream', :'seq'::bigint);
SQL
)
REDACT_AND_RELEASE_SQL=$(cat <<'SQL'
SELECT jale_audit.redact_and_release('events', :'seq'::bigint);
SQL
)

# A read that fails is reported by its SQLSTATE or the kind of failure.
read_failed() {   # $1 what was being read
  sql_error_code
  case "$SQL_CODE" in
    42883|3F000) fail "reading $1 failed ($SQL_CODE): the audit functions are not in the database; apply the migrations first" ;;
    42501) fail "reading $1 failed (42501): permission denied" ;;
    "") psql_error_kind; fail "reading $1 failed ($PSQL_KIND)" ;;
    *) fail "reading $1 failed ($SQL_CODE)" ;;
  esac
}

# A refused change is reported by its SQLSTATE alone.
change_refused() {   # $1 function, $2 what 22023 means
  sql_error_code
  case "$SQL_CODE" in
    22023) fail "$1 refused (22023): $2; nothing was changed" ;;
    42883|3F000) fail "$1 refused ($SQL_CODE): the audit functions are not in the database; apply the migrations first" ;;
    42501) fail "$1 refused (42501): permission denied; nothing was changed" ;;
    "") psql_error_kind; fail "$1 failed ($PSQL_KIND); nothing was changed" ;;
    *) fail "$1 refused ($SQL_CODE); nothing was changed" ;;
  esac
}

case "$AUDIT_OP" in
  status)
    rows=$(printf '%s\n' "$EXPORT_STATUS_SQL" | master_psql_code -F '|' -f - 2>"$ERR") || read_failed "the export status"
    while IFS='|' read -r stream mark_at unexported batches last_at last_rows held released; do
      [[ -n "$stream" ]] || continue
      say "export $stream: watermark at $mark_at, $unexported unexported row(s), $batches batch(es), last batch at $last_at with $last_rows row(s), $held held, $released released and waiting"
    done <<<"$rows"
    since=$(printf '%s\n' "$SINCE_SQL" | master_psql_code -v since="$AUDIT_SINCE" -f - 2>"$ERR") || read_failed "the time"
    rows=$(printf '%s\n' "$EVENT_COUNTS_SQL" | master_psql_code -F '|' -v since="$AUDIT_SINCE" -f - 2>"$ERR") || read_failed "the access event counts"
    if [[ -z "$rows" ]]; then
      say "access events since $since: none"
    else
      say "access events since $since:"
      while IFS='|' read -r kind outcome surface events; do
        [[ -n "$kind" ]] && say "$kind $outcome $surface: $events"
      done <<<"$rows"
    fi
    ;;
  holds)
    total=$(printf '%s\n' "$HOLDS_COUNT_SQL" | master_psql_code -f - 2>"$ERR") || read_failed "the holds"
    say "held rows: $total"
    rows=$(printf '%s\n' "$LIST_HOLDS_SQL" | master_psql_code -F '|' -f - 2>"$ERR") || read_failed "the holds"
    while IFS='|' read -r stream seq occurred surface held pattern; do
      [[ -n "$stream" ]] && say "hold: stream $stream, seq $seq, occurred $occurred, surface $surface, held $held, pattern $pattern"
    done <<<"$rows"
    if [[ "$total" =~ ^[0-9]+$ ]] && (( total > 200 )); then say "showing the first 200 by the time they were held"; fi
    ;;
  release)
    hold=$(printf '%s\n' "$RELEASE_HOLD_SQL" | master_psql_code -v stream="$HOLD_STREAM" -v seq="$HOLD_SEQ" -f - 2>"$ERR") \
      || change_refused release_hold "the row is not held, or is already released"
    say "released: stream $HOLD_STREAM, seq $HOLD_SEQ (hold record $hold)"
    ;;
  redact)
    hold=$(printf '%s\n' "$REDACT_AND_RELEASE_SQL" | master_psql_code -v seq="$HOLD_SEQ" -f - 2>"$ERR") \
      || change_refused redact_and_release "the event is not held, or is already released"
    say "redacted and released: stream events, seq $HOLD_SEQ (hold record $hold)"
    ;;
esac
unset PGPASSWORD
AUDIT_OPS
  printf 'echo "%s"\n' "$SENTINEL"
}

# The read-only report (--report): the statements check_report_file accepted,
# carried encoded and checksum-verified as a migration is, then run as the
# master login in one read-only transaction that is rolled back, in a session
# whose default is read-only, stopping at the first error. It prints the
# results once the transaction ended without an error, and a status; a
# failure is its SQLSTATE or kind. Never a statement, never psql's text.
emit_report_ops() {
  [[ -s "$WORKDIR/report.sql" ]] || die "the report's statements were not written"
  printf "REPORT_SQL_B64='%s'\nREPORT_SQL_SUM='%s'\n" \
    "$(encode_migration "$WORKDIR/report.sql")" "$(sha256_of "$WORKDIR/report.sql")"
  cat <<'REPORT_OPS'
REPORT_SQL="$AUDIT_DIR/report.sql"
printf '%s' "$REPORT_SQL_B64" | base64 -d | gunzip > "$REPORT_SQL"
[[ "$(sha256sum "$REPORT_SQL" | cut -d' ' -f1)" == "$REPORT_SQL_SUM" ]] \
  || fail "the report failed checksum verification after transfer; nothing was run"

report_failed() {
  sql_error_code
  case "$SQL_CODE" in
    25006) fail "the report stopped (25006): the read-only transaction refused a statement; nothing was changed" ;;
    "") psql_error_kind; fail "the report failed ($PSQL_KIND); nothing was changed" ;;
    *) fail "the report failed ($SQL_CODE); nothing was changed" ;;
  esac
}

{ printf '%s\n' 'BEGIN READ ONLY;'; cat "$REPORT_SQL"; printf '%s\n' 'ROLLBACK;'; } \
  | PGOPTIONS='-c default_transaction_read_only=on' "${PG[@]}" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -f - >"$AUDIT_DIR/report.out" 2>"$ERR" \
  || report_failed
cat "$AUDIT_DIR/report.out"
say "read-only report: complete; its transaction was rolled back"
unset PGPASSWORD
REPORT_OPS
  printf 'echo "%s"\n' "$SENTINEL"
}

# ---------------------------------------------------------------------------
# Preconditions.
# ---------------------------------------------------------------------------
for t in aws jq base64 gzip; do need_tool "$t"; done
if $PREPARE_LOGINS || $ROTATE_SECRETS; then
  [[ -s "$SCRAM_HELPER" ]] || die "missing $SCRAM_HELPER, which computes the SCRAM verifiers on the bastion"
fi

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

# ---------------------------------------------------------------------------
# Command output: is the ops-command log group there to record this run?
# ---------------------------------------------------------------------------
# A count, nothing else. Run Command never reports an output it could not
# deliver, so a missing group would lose this run's record silently; the ops
# host cannot create the group either. Only a run before the audit stack's
# first deploy may go ahead without it, and only when it says so.
COMMAND_LOG=false
note "Checking the ops-command log group..."
if ! log_groups=$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$OPS_COMMAND_LOG_GROUP" \
                    --query "length(logGroups[?logGroupName=='$OPS_COMMAND_LOG_GROUP'])" --output text \
                    2>"$WORKDIR/log-group.err"); then
  code=$(grep -oE '\([A-Za-z]+(Exception|Error|Fault)\)' "$WORKDIR/log-group.err" 2>/dev/null | head -n 1 | tr -d '()') || code=""
  die "checking the ops-command log group failed (${code:-no error code}); nothing was sent to the ops host"
fi
case "$log_groups" in
  1)
    if $WITHOUT_COMMAND_LOG; then
      die "--without-command-log is only for a run before the audit stack's first deploy, and the ops-command log group exists; run without it"
    fi
    COMMAND_LOG=true
    note "   ops-command output: recorded" ;;
  0)
    if ! $WITHOUT_COMMAND_LOG; then
      die "the ops-command log group does not exist, so this run's output would not be recorded. Before the audit stack's first deploy, re-run with --without-command-log; at any other time stop and find out why the group is missing."
    fi
    echo "!! --without-command-log: the ops-command log group does not exist, and this run's output is NOT recorded." >&2
    echo "!! That is expected only before the audit stack's first deploy." >&2 ;;
  *)
    die "could not tell whether the ops-command log group exists; nothing was sent to the ops host" ;;
esac

# The stack reads keep their stdout only: the AWS CLI's error text names the
# account and the role, so a failure shows its error code alone.
note "Resolving bastion instance ID..."
BASTION_ID=$(aws cloudformation describe-stacks --stack-name "$BASTION_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text 2>"$WORKDIR/stack-read.err") \
  || die "reading $BASTION_STACK failed ($(aws_error_code "$WORKDIR/stack-read.err")); if it is not deployed, deploy it first: bash scripts/deploy-bastion.sh"
[[ -n "$BASTION_ID" && "$BASTION_ID" != "None" ]] \
  || die "no BastionInstanceId on $BASTION_STACK. Deploy it first: bash scripts/deploy-bastion.sh"
note "   bastion: resolved"

# The four DB-role secrets are resolved with their CloudFormation logical-ID
# prefixes spelled out in full. The queries are deliberately not factored into
# a helper: infra/test/unit/db/migrations.test.ts asserts on these exact
# strings, so keeping them literal keeps that guard meaningful.
describe_secret_arn() {
  aws cloudformation describe-stack-resources --stack-name "$DATABASE_STACK" \
    --region "$REGION" --query "$1" --output text 2>"$WORKDIR/stack-read.err" \
    || die "reading the resources of $DATABASE_STACK failed ($(aws_error_code "$WORKDIR/stack-read.err"))"
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

# jale_ai's CDK-generated secret, which --prepare-logins syncs the role from.
AI_SECRET_ARN=""
if $PREPARE_LOGINS && prepare_selected jale_ai; then
  note "Resolving jale_ai DB secret ARN..."
  AI_SECRET_ARN=$(describe_secret_arn "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'AiDbSecret')].PhysicalResourceId | [0]")
  [[ -n "$AI_SECRET_ARN" && "$AI_SECRET_ARN" != "None" ]] \
    || die "could not find the jale_ai DB secret in $DATABASE_STACK"
  note "   ai-secret: resolved"
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
"\${PG[@]}" -v VERBOSITY=terse -At -F '|' -c "SELECT filename, checksum FROM $LEDGER_TABLE ORDER BY filename;"
echo "---LEDGER-END---"
unset PGPASSWORD
echo "$SENTINEL"
LEDGER_READ
} > "$WORKDIR/read-ledger.sh"

# The bastion installs psql/jq in first-boot UserData, which finishes MINUTES
# after `cdk deploy` returns. On 2026-09-01 a dry-run fired in that window and
# died with "psql: command not found" (exit 127) before reading the ledger;
# the same day a t4g.nano had dnf OOM-killed, so psql never arrived at all.
# Wait (bounded) for cloud-init, then prove psql exists, and if it does not,
# say exactly where to look instead of surfacing a bare 127 from line 12.
cat <<'BASTION_READY' > "$WORKDIR/bastion-ready.sh"
set -u
timeout 420 cloud-init status --wait >/dev/null 2>&1 || true
echo "cloud-init: $(cloud-init status 2>/dev/null || echo unknown)"
if ! command -v psql >/dev/null 2>&1; then
  echo "!! psql is not installed on the bastion." >&2
  echo "!! First-boot UserData (dnf install postgresql15 jq) did not complete." >&2
  echo "!! Inspect: /var/log/cloud-init-output.log (look for 'Killed' = OOM)." >&2
  echo "!! Fix: scripts/deploy-bastion.sh --destroy && scripts/deploy-bastion.sh" >&2
  tail -5 /var/log/cloud-init-output.log >&2 2>/dev/null || true
  exit 1
fi
echo "psql: $(psql --version)"
BASTION_READY
printf 'echo "%s"\n' "$SENTINEL" >> "$WORKDIR/bastion-ready.sh"
note "Waiting for the bastion to finish first boot (psql present)..."
run_on_bastion "$WORKDIR/bastion-ready.sh" "bastion readiness" false | grep -E '^(cloud-init|psql):' | sed 's/^/>>    /'

# ---------------------------------------------------------------------------
# Posture control: the first database read of every run, before the ledger
# DDL, a migration or a credential is touched.
# ---------------------------------------------------------------------------
# Two facts, read as the master login: row_security_active() on public.users,
# and the engine's major version. They are the reference reading for the
# database posture check, which reads every runtime login's posture daily and
# at deploy time. If either moves away from the reviewed baseline (the
# operator's POSTURE_BASELINE_MASTER_ROW_SECURITY, checked at the start of
# the run, and EXPECTED_ENGINE_MAJOR below), the assumptions this release was
# reviewed under no longer hold, so the run stops. --accept-posture-change
# continues anyway. Both readings are printed either way. Change either
# baseline only together with a recorded review.
EXPECTED_ENGINE_MAJOR=16
POSTURE_SQL="SELECT (SELECT row_security_active(c.oid) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'users'), current_setting('server_version_num')"
{
  emit_pg_preamble
  cat <<POSTURE
echo "---POSTURE-BEGIN---"
"\${PG[@]}" -X -At -F '|' -v VERBOSITY=terse -c "$POSTURE_SQL"
echo "---POSTURE-END---"
unset PGPASSWORD
echo "$SENTINEL"
POSTURE
} > "$WORKDIR/posture.sh"

note "Posture control: reading the master login's posture..."
# strict_truncation=true: the run decides whether to continue from this read.
run_on_bastion "$WORKDIR/posture.sh" "posture control" true > "$WORKDIR/posture-out.txt"
POSTURE_READING=$(sed -n '/---POSTURE-BEGIN---/,/---POSTURE-END---/p' "$WORKDIR/posture-out.txt" \
  | grep -v -- '---POSTURE-' | head -n 1) || true
IFS='|' read -r POSTURE_RLS POSTURE_VERSION_NUM <<<"$POSTURE_READING"
[[ "${POSTURE_VERSION_NUM:-}" =~ ^[0-9]+$ ]] \
  || die "posture control: could not read server_version_num; refusing to continue"
POSTURE_MAJOR=$(( POSTURE_VERSION_NUM / 10000 ))
POSTURE_READINGS="master row_security_active(public.users)=${POSTURE_RLS:-none}, server_version_num=$POSTURE_VERSION_NUM"

POSTURE_CHANGES=()
if [[ -z "$POSTURE_RLS" ]]; then
  POSTURE_CHANGES+=("public.users was not found, so there is no row_security_active reading")
elif [[ "$POSTURE_RLS" != "$POSTURE_BASELINE_MASTER_ROW_SECURITY" ]]; then
  POSTURE_CHANGES+=("master row_security_active(public.users) is $POSTURE_RLS, baseline $POSTURE_BASELINE_MASTER_ROW_SECURITY")
fi
if (( POSTURE_MAJOR != EXPECTED_ENGINE_MAJOR )); then
  POSTURE_CHANGES+=("engine major is $POSTURE_MAJOR (server_version_num=$POSTURE_VERSION_NUM), baseline $EXPECTED_ENGINE_MAJOR")
fi

if (( ${#POSTURE_CHANGES[@]} == 0 )); then
  note "Posture control: $POSTURE_READINGS (baseline $POSTURE_BASELINE_MASTER_ROW_SECURITY, major $EXPECTED_ENGINE_MAJOR): unchanged"
else
  echo "!! Posture control CHANGED. Readings: $POSTURE_READINGS" >&2
  printf '!!   %s\n' "${POSTURE_CHANGES[@]}" >&2
  if $ACCEPT_POSTURE_CHANGE; then
    echo "!! continuing because --accept-posture-change was given; record why in the release notes." >&2
  else
    die "posture control changed: stop and investigate before any migration or credential work. Once the change is understood and recorded, re-run with --accept-posture-change, and update the reviewed baseline: the release record for the master's reading, EXPECTED_ENGINE_MAJOR in this script for the engine."
  fi
fi

# ---------------------------------------------------------------------------
# --prepare-logins: credentials for the least-privilege logins, then stop.
# This branch never reaches the ledger, the migrations or --rotate-secrets.
# ---------------------------------------------------------------------------
if $PREPARE_LOGINS; then
  n_selected=0
  for entry in "${PREPARE_NEW_LOGINS[@]}" "${PREPARE_SYNC_LOGINS[@]}"; do
    if prepare_selected "${entry%%|*}"; then n_selected=$((n_selected + 1)); fi
  done

  if $DRY_RUN; then
    note "--dry-run: checking $n_selected database login(s); nothing will change."
  elif ! $ASSUME_YES; then
    echo
    echo "About to prepare $n_selected database login(s) against $DATABASE_STACK in $REGION:"
    echo "create each missing login secret from an AWS-generated password, and set each"
    echo "login's database password from its secret. Existing secrets are reused, never rotated."
    read -r -p "Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || die "aborted by operator"
  fi

  { emit_prepare_payload; emit_prepare_calls; } > "$WORKDIR/prepare-logins.sh"
  note "Preparing database logins..."
  run_on_bastion "$WORKDIR/prepare-logins.sh" "prepare database logins"
  if $DRY_RUN; then
    note "Login check complete. Nothing was changed."
  else
    note "Logins prepared. Each one signs in with its own secret; no value was shown."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# --enable-pgaudit / --disable-master-audit: engine audit settings, then stop.
# Neither reaches the ledger, the migrations or --rotate-secrets.
# ---------------------------------------------------------------------------
if $ENABLE_PGAUDIT || $DISABLE_MASTER_AUDIT; then
  if $ENABLE_PGAUDIT; then
    audit_payload="$WORKDIR/enable-pgaudit.sh"
    audit_comment="enable engine audit logging"
    { emit_pg_preamble; emit_master_ops_lib; emit_engine_audit_lib; emit_enable_pgaudit; } > "$audit_payload"
  else
    audit_payload="$WORKDIR/disable-master-audit.sh"
    audit_comment="reset master audit logging"
    { emit_pg_preamble; emit_master_ops_lib; emit_engine_audit_lib; emit_disable_master_audit; } > "$audit_payload"
  fi

  if $DRY_RUN; then
    note "--dry-run: reading the engine audit state; nothing will change."
  elif ! $ASSUME_YES; then
    echo
    if $ENABLE_PGAUDIT; then
      echo "About to enable engine audit logging against $DATABASE_STACK in $REGION:"
      echo "create the pgaudit extension, and log every statement of every personal login."
      if $CONFIRM_CUTOVER_VERIFIED; then
        echo "Also log every statement of the master login (--confirm-cutover-verified)."
      else
        echo "The master login is left as it is (no --confirm-cutover-verified)."
      fi
    else
      echo "About to reset the master login's pgaudit.log against $DATABASE_STACK in $REGION."
      echo "Personal logins keep their setting."
    fi
    read -r -p "Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || die "aborted by operator"
  fi

  note "Engine audit logging: ${audit_comment}..."
  # strict_truncation=true: the payload verifies its own change and the run
  # reports from that output.
  run_on_bastion "$audit_payload" "$audit_comment" true
  if $DRY_RUN; then
    note "Engine audit check complete. Nothing was changed."
  else
    note "Engine audit settings verified."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# The master's audit operations and the read-only report: one at a time, then
# stop. None reaches the ledger, the migrations or --rotate-secrets.
# ---------------------------------------------------------------------------
if $AUDIT_OPERATION; then
  if $AUDIT_STATUS; then audit_ops_comment="audit status"
  elif $LIST_HOLDS; then audit_ops_comment="list audit holds"
  elif $RELEASE_HOLD; then audit_ops_comment="release an audit hold"
  elif $REDACT_AND_RELEASE; then audit_ops_comment="redact and release an audit hold"
  else audit_ops_comment="read-only report"
  fi
  if $REPORT; then
    printf '%s' "$REPORT_SQL" > "$WORKDIR/report.sql"
    { emit_pg_preamble; emit_master_ops_lib; emit_report_ops; } > "$WORKDIR/audit-ops.sh"
  else
    { emit_pg_preamble; emit_master_ops_lib; emit_audit_ops; } > "$WORKDIR/audit-ops.sh"
  fi

  if ($RELEASE_HOLD || $REDACT_AND_RELEASE) && ! $ASSUME_YES; then
    echo
    if $RELEASE_HOLD; then
      echo "About to release held row $HOLD_STREAM $HOLD_SEQ against $DATABASE_STACK in $REGION:"
      echo "the next release batch exports it as it is. Do this only after review found no value in it."
    else
      echo "About to redact the reason of held event $HOLD_SEQ against $DATABASE_STACK in $REGION:"
      echo "the reason becomes '[redacted]' and the event is released for export."
    fi
    read -r -p "Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || die "aborted by operator"
  fi

  note "Audit operation: ${audit_ops_comment}..."
  # strict_truncation=true: the output is the report.
  run_on_bastion "$WORKDIR/audit-ops.sh" "$audit_ops_comment" true
  exit 0
fi

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
# after it runs for real. Nothing here checks the recorded files against the
# database, so a baseline past the real state records unapplied migrations
# as applied and they never run; the help tells the operator to verify first.
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
    note "   --rotate-secrets would reset role passwords and reseed the WhatsApp login's secret."
  fi
  exit 0
fi

if ! $ASSUME_YES; then
  target="execute ${n_exec:-0} and record ${n_record:-0} migration(s)"
  echo
  echo "About to $target against $DATABASE_STACK in $REGION."
  if $ROTATE_SECRETS; then
    echo "Also rotating role passwords and reseeding the WhatsApp login's secret."
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
#
# Every psql call here, and in the ledger read and verification, asks for
# terse errors: the severity and primary message, never the DETAIL and
# CONTEXT lines, which can quote row contents ("Failing row contains ...").
# The output is recorded in the ops-command log group. NOTICEs keep their
# primary message, so a migration's self-check lines still come back.
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
"\${PG[@]}" -v VERBOSITY=terse -q -c "INSERT INTO $LEDGER_TABLE (filename, checksum)
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
if ! "\${PG[@]}" -v VERBOSITY=terse -f /tmp/jale-mig.sql 2>/tmp/jale-mig.err; then
  sed 's/^/      /' /tmp/jale-mig.err >&2
  rm -f /tmp/jale-mig.err /tmp/jale-mig.sql
  exit 1
fi
sed 's/^/      /' /tmp/jale-mig.err
rm -f /tmp/jale-mig.err
"\${PG[@]}" -v VERBOSITY=terse -q -c "INSERT INTO $LEDGER_TABLE (filename, checksum)
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
  echo "!! The WhatsApp login's secret does not exist." >&2
  echo "!! Re-run with --rotate-secrets to provision them, or pass --skip-secrets to acknowledge this and continue anyway." >&2
  die "refusing to report success from a fresh-database bootstrap with credential-less roles"
fi

if $FRESH_DATABASE && (( ${n_exec:-0} > 0 )) && $SKIP_SECRETS && ! $ROTATE_SECRETS; then
  note "--skip-secrets acknowledged: jale_matching, jale_admin_console, jale_billing, jale_whatsapp, jale_public_jobs have no usable password and the WhatsApp login's secret was not created."
fi

# ---------------------------------------------------------------------------
# Optional: role password rotation + jale/whatsapp/db seeding.
# ---------------------------------------------------------------------------
if $ROTATE_SECRETS; then
  note "Rotating role passwords and reseeding the WhatsApp login's secret..."
  {
    emit_pg_preamble
    emit_remote_credential_lib
    cat <<'ROTATE_LIB'
# The AWS CLI's error text names resources and accounts; only its code is shown.
ROTATE_ERR="$CRED_DIR/rotate.err"
aws_code() {
  local code
  code=$(grep -oE '\([A-Za-z]+(Exception|Error|Fault)\)' "$ROTATE_ERR" 2>/dev/null | head -n 1 | tr -d '()') || code=""
  printf '%s' "${code:-no error code}"
}

# stdout: the password a login's CDK secret holds, only when it is a string of
# at least 20 characters. Anything else stops the run before this login's role
# (or any later one) is changed. A lenient read would turn a missing field into
# the literal password "null" and set the role from it.
read_source_password() {   # $1 login, $2 secret id
  local json
  json=$(aws secretsmanager get-secret-value --secret-id "$2" --region "$REGION" \
           --query SecretString --output text 2>"$ROTATE_ERR") \
    || fail "$1: reading its secret failed ($(aws_code)); stopped before changing this role or any after it"
  printf '%s' "$json" | jq -er '.password | select(type == "string" and length >= 20)' 2>/dev/null \
    || fail "$1: its secret has no usable password (missing, not a string, or shorter than 20 characters); stopped before changing this role or any after it"
}
ROTATE_LIB
    cat <<ROTATE
# Each password reaches the database only as a SCRAM-SHA-256 verifier on
# psql's stdin, and reaches Secrets Manager only on the AWS CLI's stdin:
# never inside a statement, never in argv.
MATCHING_PW=\$(read_source_password jale_matching "$MATCHING_SECRET_ARN") || exit 1
MATCHING_VERIFIER=\$(printf '%s' "\$MATCHING_PW" | scram_verifier)
printf "ALTER ROLE jale_matching WITH PASSWORD '%s';\n" "\$MATCHING_VERIFIER" | "\${PG[@]}" -q -f -

ADMIN_CONSOLE_PW=\$(read_source_password jale_admin_console "$ADMIN_CONSOLE_SECRET_ARN") || exit 1
ADMIN_CONSOLE_VERIFIER=\$(printf '%s' "\$ADMIN_CONSOLE_PW" | scram_verifier)
printf "ALTER ROLE jale_admin_console WITH PASSWORD '%s';\n" "\$ADMIN_CONSOLE_VERIFIER" | "\${PG[@]}" -q -f -

BILLING_PW=\$(read_source_password jale_billing "$BILLING_SECRET_ARN") || exit 1
BILLING_VERIFIER=\$(printf '%s' "\$BILLING_PW" | scram_verifier)
printf "ALTER ROLE jale_billing WITH PASSWORD '%s';\n" "\$BILLING_VERIFIER" | "\${PG[@]}" -q -f -

# jale_public_jobs: copy the CDK-generated vault password onto the role, then
# PROVE the login works before this session can report success. The check also
# exercises the role's one grant (public job columns), so both password drift
# and a broken grant die here on the bastion instead of surfacing as a public
# page that 500s every request. Neither value is ever printed.
PUBLIC_JOBS_PW=\$(read_source_password jale_public_jobs "$REFERRALS_SECRET_ARN") || exit 1
PUBLIC_JOBS_VERIFIER=\$(printf '%s' "\$PUBLIC_JOBS_PW" | scram_verifier)
printf "ALTER ROLE jale_public_jobs WITH PASSWORD '%s';\n" "\$PUBLIC_JOBS_VERIFIER" | "\${PG[@]}" -q -f -
PUBLIC_JOBS_CHECK=\$(PGPASSWORD="\$PUBLIC_JOBS_PW" psql -h "\$DB_HOST" -p "\$DB_PORT" \
  -U jale_public_jobs -d "\$DB_NAME" -v ON_ERROR_STOP=1 \
  -tAc "SELECT count(*) FROM jobs WHERE public_listing_enabled") || {
  echo "!! jale_public_jobs credential check FAILED — vault and database disagree, or the role's grant on jobs is broken" >&2
  exit 1
}
echo "   jale_public_jobs credential check OK (\$PUBLIC_JOBS_CHECK publicly listed jobs)"

# jale_whatsapp gets a new password. Its secret is written first; the role is
# set only after that write succeeded, from the same in-memory value, and then
# the login is proven. A failed write leaves the login on its previous
# password. A failure after the write leaves the secret ahead of the role,
# which a re-run repairs: every run starts again from a new password.
WA_PW=\$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-24) || WA_PW=""
[[ "\$WA_PW" =~ ^[A-Za-z0-9]{20,24}\$ ]] \
  || fail "jale_whatsapp: generating its password failed; nothing was changed"
SECRET_STRING=\$(printf '%s' "\$WA_PW" | jq -Rs --arg host "\$DB_HOST" --arg port "\$DB_PORT" --arg dbname "\$DB_NAME" \
  --arg username "jale_whatsapp" \
  '{host: \$host, port: (\$port | tonumber), dbname: \$dbname, username: \$username, password: .}')
# The value about to be written must carry exactly that password, for this
# login on this database.
WA_JSON_PW=\$(printf '%s' "\$SECRET_STRING" | jq -er --arg host "\$DB_HOST" --arg port "\$DB_PORT" --arg dbname "\$DB_NAME" \
  'select(.username == "jale_whatsapp" and .host == \$host and (.port | tostring) == \$port and .dbname == \$dbname)
   | .password | select(type == "string")') || WA_JSON_PW=""
[[ -n "\$WA_JSON_PW" && "\$WA_JSON_PW" == "\$WA_PW" ]] \
  || fail "jale_whatsapp: the secret value built for it does not carry its new password; nothing was changed"
WA_JSON_PW=""

if aws secretsmanager describe-secret --secret-id "$WA_DB_SECRET_NAME" --region "\$REGION" >/dev/null 2>&1; then
  printf '%s' "\$SECRET_STRING" | aws secretsmanager put-secret-value --secret-id "$WA_DB_SECRET_NAME" --region "\$REGION" \
    --secret-string file:///dev/stdin >/dev/null 2>"\$ROTATE_ERR" \
    || fail "jale_whatsapp: writing its secret failed (\$(aws_code)); the database was not changed and the login keeps its previous password"
  echo "   updated the WhatsApp login's existing secret"
else
  printf '%s' "\$SECRET_STRING" | aws secretsmanager create-secret --name "$WA_DB_SECRET_NAME" --region "\$REGION" \
    --description "jale_whatsapp role credentials for WhatsApp Lambdas" \
    --secret-string file:///dev/stdin >/dev/null 2>"\$ROTATE_ERR" \
    || fail "jale_whatsapp: creating its secret failed (\$(aws_code)); the database was not changed"
  echo "   created the WhatsApp login's secret"
fi

WA_VERIFIER=\$(printf '%s' "\$WA_PW" | scram_verifier) \
  || fail "jale_whatsapp: computing its verifier failed after its secret was written; re-run --rotate-secrets"
printf "ALTER ROLE jale_whatsapp WITH PASSWORD '%s';\n" "\$WA_VERIFIER" | "\${PG[@]}" -q -f - \
  || fail "jale_whatsapp: setting its database password failed after its secret was written; re-run --rotate-secrets"

# Sign in as jale_whatsapp with the password its secret now holds. psql's
# error text names the host, so only the outcome is shown.
WA_CHECK=\$(PGPASSWORD="\$WA_PW" psql -X -h "\$DB_HOST" -p "\$DB_PORT" -U jale_whatsapp -d "\$DB_NAME" \
  -v ON_ERROR_STOP=1 -tAc "SELECT current_user" 2>/dev/null) || WA_CHECK=""
[[ "\$WA_CHECK" == "jale_whatsapp" ]] \
  || fail "jale_whatsapp credential check FAILED: it does not sign in with the password its secret now holds; re-run --rotate-secrets"
echo "   jale_whatsapp credential check OK"

unset PGPASSWORD WA_PW WA_VERIFIER WA_JSON_PW WA_CHECK SECRET_STRING MATCHING_PW MATCHING_VERIFIER ADMIN_CONSOLE_PW ADMIN_CONSOLE_VERIFIER BILLING_PW BILLING_VERIFIER PUBLIC_JOBS_PW PUBLIC_JOBS_VERIFIER PUBLIC_JOBS_CHECK
echo "$SENTINEL"
ROTATE
  } > "$WORKDIR/rotate.sh"
  run_on_bastion "$WORKDIR/rotate.sh" "rotate role secrets"
  note "Secrets rotated. WhatsApp Lambdas will error until they read the WhatsApp login's secret again."
fi

echo
note "All done. Next:"
echo "   bash scripts/deploy-bastion.sh --destroy    # cost hygiene"
echo "   gh workflow run deploy-production.yml --ref prod -f deploy_scope=all"
