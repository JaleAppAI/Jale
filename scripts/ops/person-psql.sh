#!/usr/bin/env bash
#
# person-psql.sh: psql on your own machine, signed in as your personal
# database login, through a port forward via the ops host.
#
# Usage:
#   bash scripts/ops/person-psql.sh <handle> [--local-port N]
#   bash scripts/ops/person-psql.sh <handle> [--local-port N] --check
#   bash scripts/ops/person-psql.sh <handle> [--local-port N] -- <psql options>
#
#   <handle>          your handle (scripts/ops/person-login.sh created the login)
#   --local-port N    the local end of the port forward (default 15432)
#   --check           sign in, print who you are and the login's limits, exit
#   -- <psql options> passed to psql, for example -f <file>; stdin is psql's
#
# It reads your own secret with your own AWS identity, opens a Session Manager
# port forward (AWS-StartPortForwardingSessionToRemoteHost) from 127.0.0.1 to
# the database through the ops host, runs psql against it and closes the
# forward when psql exits. The password reaches psql only through its
# environment; the database host stays in a file in a private directory and is
# never printed.
#
# What is recorded: CloudTrail names you on the secret read and on the
# session start; the engine's audit log records every statement your login
# runs. AWS does not record what goes through a port forward. Never type a
# contact value (an email address or phone number) into a statement: the
# audit log keeps the statement text. Look users up with
# scripts/ops/person-lookup.sh, which sends the value as a bound parameter.
#
# Requirements: bash, aws CLI v2, the Session Manager plugin, jq, and psql 16
# or newer (for \bind).
#
# ---------------------------------------------------------------------------

set -euo pipefail
umask 077

BASTION_STACK="JaleBastionStack"
DATABASE_STACK="JaleDatabaseStack"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
MIN_PSQL_MAJOR=16
DEFAULT_LOCAL_PORT=15432

die()  { echo "!! $*" >&2; exit 1; }
note() { echo ">> $*" >&2; }
usage_error() { echo "!! $*" >&2; echo "   see: bash scripts/ops/person-psql.sh --help" >&2; exit 2; }

# The handle rule jale_ops.provision_person enforces, in the C locale.
is_person_handle() { local LC_ALL=C; [[ "$1" =~ ^[a-z][a-z0-9]{1,15}$ ]]; }
person_login() { printf 'jale_person_%s' "$1"; }
person_secret_name() { printf 'jale/person-%s/db' "$1"; }

HANDLE=""
LOCAL_PORT="$DEFAULT_LOCAL_PORT"
CHECK=false
PSQL_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) awk 'NR > 1 && /^# ---/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    --local-port)
      [[ $# -ge 2 ]] || usage_error "--local-port needs a port number"
      LOCAL_PORT="$2"; shift ;;
    --check) CHECK=true ;;
    --) shift; PSQL_ARGS=("$@"); break ;;
    -*) usage_error "unknown option (psql options go after --)" ;;
    *)
      [[ -z "$HANDLE" ]] || usage_error "give one handle"
      HANDLE="$1" ;;
  esac
  shift
done

[[ -n "$HANDLE" ]] || usage_error "usage: person-psql.sh <handle>"
is_person_handle "$HANDLE" \
  || usage_error "the handle must be 2 to 16 lower-case letters and digits, starting with a letter"
[[ "$LOCAL_PORT" =~ ^[1-9][0-9]{3,4}$ ]] && (( LOCAL_PORT >= 1024 && LOCAL_PORT <= 65535 )) \
  || usage_error "--local-port must be a port from 1024 to 65535"
if $CHECK && (( ${#PSQL_ARGS[@]} > 0 )); then usage_error "--check takes no psql options"; fi

LOGIN=$(person_login "$HANDLE")
SECRET_NAME=$(person_secret_name "$HANDLE")

# ---------------------------------------------------------------------------
# Tools. psql 16 or newer, for \bind: person-lookup.sh sends values as bound
# parameters, never inside a statement.
# ---------------------------------------------------------------------------
command -v psql >/dev/null 2>&1 || die "psql $MIN_PSQL_MAJOR or newer is required"
psql_version=$(psql --version 2>/dev/null) || psql_version=""
version_rule='\(PostgreSQL\) ([0-9]+)'
[[ "$psql_version" =~ $version_rule ]] || die "could not read psql's version; psql $MIN_PSQL_MAJOR or newer is required"
(( BASH_REMATCH[1] >= MIN_PSQL_MAJOR )) \
  || die "psql $MIN_PSQL_MAJOR or newer is required (found ${BASH_REMATCH[1]}); \\bind needs it"
command -v aws >/dev/null 2>&1 || die "the aws CLI v2 is required"
[[ "$(aws --version 2>&1)" == aws-cli/2.* ]] || die "the aws CLI v2 is required (found another version)"
command -v session-manager-plugin >/dev/null 2>&1 || die "the Session Manager plugin for the aws CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

WORKDIR="$(mktemp -d)"
ERR="$WORKDIR/stderr"
SESSION_PID=""

stop_forward() {
  if [[ -n "$SESSION_PID" ]]; then
    # The CLI runs the Session Manager plugin as its child; stop both.
    pkill -TERM -P "$SESSION_PID" >/dev/null 2>&1 || true
    kill -TERM "$SESSION_PID" >/dev/null 2>&1 || true
    wait "$SESSION_PID" 2>/dev/null || true
    SESSION_PID=""
  fi
}
cleanup() { stop_forward; rm -rf "$WORKDIR"; }
trap cleanup EXIT
trap 'exit 143' TERM HUP

aws_code() {
  local code
  code=$(grep -oE 'An error occurred \([A-Za-z]+\)' "$ERR" 2>/dev/null | head -n 1 | grep -oE '\([A-Za-z]+\)' | tr -d '()') || code=""
  printf '%s' "${code:-no error code}"
}

# ---------------------------------------------------------------------------
# Your secret, the ops host and the database endpoint. Kept in variables and
# files in the private directory, never printed.
# ---------------------------------------------------------------------------
SECRET_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_NAME" \
                --query SecretString --output text 2>"$ERR") \
  || die "reading your secret failed ($(aws_code)); create your login with scripts/ops/person-login.sh create $HANDLE"
printf '%s' "$SECRET_JSON" | jq -e --arg u "$LOGIN" \
    '(.username == $u) and (.password | type == "string" and test("^[A-Za-z0-9]{32,}$"))' >/dev/null 2>&1 \
  || { SECRET_JSON=""; die "your secret does not hold this login's password; renew it with scripts/ops/person-login.sh renew $HANDLE"; }
PW=$(printf '%s' "$SECRET_JSON" | jq -r '.password')
SECRET_JSON=""

BASTION_ID=$(aws cloudformation describe-stacks --stack-name "$BASTION_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text 2>"$ERR") \
  || die "the ops host is not deployed ($(aws_code)); it is brought up with bash scripts/deploy-bastion.sh"
[[ -n "$BASTION_ID" && "$BASTION_ID" != "None" ]] \
  || die "the ops host is not deployed; it is brought up with bash scripts/deploy-bastion.sh"
DB_INSTANCE=$(aws cloudformation describe-stack-resources --stack-name "$DATABASE_STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].PhysicalResourceId | [0]" --output text 2>"$ERR") \
  || die "resolving the database instance failed ($(aws_code))"
[[ -n "$DB_INSTANCE" && "$DB_INSTANCE" != "None" ]] || die "could not find the database instance"
aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$DB_INSTANCE" \
    --query 'DBInstances[0].{host: Endpoint.Address, port: Endpoint.Port, dbname: DBName}' --output json \
    > "$WORKDIR/endpoint.json" 2>"$ERR" \
  || die "reading the database endpoint failed ($(aws_code))"
jq -e '(.host | type == "string" and length > 0) and (.port | type == "number") and (.dbname | type == "string" and length > 0)' \
    "$WORKDIR/endpoint.json" >/dev/null 2>&1 \
  || die "the database endpoint is incomplete"
DB_NAME=$(jq -r '.dbname' "$WORKDIR/endpoint.json")
jq --arg lp "$LOCAL_PORT" '{host: [.host], portNumber: [(.port | tostring)], localPortNumber: [$lp]}' \
    "$WORKDIR/endpoint.json" > "$WORKDIR/forward.json"

# ---------------------------------------------------------------------------
# The port forward. Its output names the session, which names you, so it goes
# to a file in the private directory and is only searched.
# ---------------------------------------------------------------------------
if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
  die "local port $LOCAL_PORT is in use; pass another with --local-port"
fi
aws ssm start-session --region "$REGION" --target "$BASTION_ID" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "file://$WORKDIR/forward.json" > "$WORKDIR/session.log" 2>&1 &
SESSION_PID=$!

ready=false
for _ in $(seq 1 60); do
  if grep -q 'Waiting for connections' "$WORKDIR/session.log" 2>/dev/null; then ready=true; break; fi
  kill -0 "$SESSION_PID" 2>/dev/null || break
  sleep 0.5
done
if ! $ready; then
  cp "$WORKDIR/session.log" "$ERR" 2>/dev/null || true
  die "the port forward did not open ($(aws_code)); the ops host must be running and you need Session Manager access to it"
fi

# ---------------------------------------------------------------------------
# psql. The connection comes from the environment, the password included:
# nothing about it is an argument.
# ---------------------------------------------------------------------------
run_psql() {
  PGHOST=127.0.0.1 PGPORT="$LOCAL_PORT" PGUSER="$LOGIN" PGDATABASE="$DB_NAME" PGPASSWORD="$PW" \
    PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGAPPNAME=person-psql psql "$@"
}

status=0
if $CHECK; then
  got=$(run_psql -X -q -At -F '|' -v ON_ERROR_STOP=1 -v VERBOSITY=terse \
          -c "SELECT current_user, current_setting('default_transaction_read_only'), current_setting('statement_timeout')" \
          2>"$ERR") || status=$?
  PW=""
  if (( status != 0 )); then
    if grep -q 'password authentication failed' "$ERR"; then die "the database refused your password; renew your login with scripts/ops/person-login.sh renew $HANDLE"
    elif grep -qE 'expired|valid until' "$ERR"; then die "your login has expired; renew it with scripts/ops/person-login.sh renew $HANDLE"
    else die "signing in failed"
    fi
  fi
  IFS='|' read -r who read_only timeout <<<"$got"
  [[ "$who" == "$LOGIN" ]] || die "signed in as another role"
  note "signed in as $LOGIN; read-only by default: $read_only; statement timeout: $timeout"
  exit 0
fi

if (( ${#PSQL_ARGS[@]} > 0 )); then
  run_psql "${PSQL_ARGS[@]}" || status=$?
else
  run_psql || status=$?
fi
PW=""
exit "$status"
