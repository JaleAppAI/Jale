#!/usr/bin/env bash
#
# person-login.sh: create, renew or remove your personal database login.
#
# Usage:
#   bash scripts/ops/person-login.sh create <handle> [--days N] [--yes]
#   bash scripts/ops/person-login.sh renew  <handle> [--days N] [--yes]
#   bash scripts/ops/person-login.sh remove <handle> [--yes]
#
#   <handle>   2 to 16 lower-case letters and digits, starting with a letter.
#              The login is jale_person_<handle>; its secret is
#              jale/person-<handle>/db.
#   --days N   How long the login can sign in: 1 to 90 days (default 30).
#   --yes      Skip the confirmation prompt.
#
# Run it yourself, on your own machine, with your own AWS identity. It needs
# the ops host (scripts/deploy-bastion.sh) and the ops-command log group.
#
#   create  Creates your secret with a resource policy that denies reading or
#           writing its value, and changing or removing the policy, to every
#           identity but yours, before any value is in it. Then it asks AWS
#           for a new password, stores it in the secret, computes the
#           password's SCRAM-SHA-256 verifier on this machine
#           (scripts/lib/scram-verifier.py) and sends only the verifier to
#           the ops host, where the master login runs
#           jale_ops.provision_person. After a failure, run it again unless
#           its message says otherwise.
#   renew   A new password and a new expiry for your existing login: the new
#           password goes into your secret first, then its verifier to
#           jale_ops.renew_person. After a failure, run it again unless its
#           message says otherwise.
#   remove  jale_ops.remove_person, then deletes the secret. Also for removing
#           someone else's login.
#
# The password never leaves this machine except into your own secret, through
# stdin. It is never an argument, never printed and never written to a file.
# Nothing about your identity is printed. Every command sent to the ops host
# has its output recorded in the ops-command log group; that output is
# statuses only.
#
# The verifier travels inside the command sent to the ops host, and the
# master's statement logging records the procedure call with it. A verifier
# is a salted, iterated hash of a 40-character random password, which is why
# it may travel that way and the password may not.
#
# Requirements: bash, aws CLI v2, jq, python3.
#
# ---------------------------------------------------------------------------

set -euo pipefail
umask 077

BASTION_STACK="JaleBastionStack"
DATABASE_STACK="JaleDatabaseStack"
OPS_COMMAND_LOG_GROUP="/jale/audit/ops-command"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
SENTINEL="__JALE_PERSON_LOGIN_OK__"
DEFAULT_DAYS=30
PASSWORD_LENGTH=40
# Waiting for the command on the ops host. The request sets neither of Run
# Command's timeouts, so its defaults apply: an hour to deliver the command
# and an hour to run it, after which it ends TimedOut. The wait polls every
# SSM_POLL_SECONDS, at most SSM_MAX_POLLS times: a little over those two
# hours, after which the command will not report back.
SSM_POLL_SECONDS=3
SSM_MAX_POLLS=2500
SCRAM_HELPER="$(cd "$(dirname "$0")/.." && pwd)/lib/scram-verifier.py"

die()  { echo "!! $*" >&2; exit 1; }
note() { echo ">> $*"; }
usage_error() { echo "!! $*" >&2; echo "   see: bash scripts/ops/person-login.sh --help" >&2; exit 2; }

# The handle rule jale_ops.provision_person enforces, in the C locale.
is_person_handle() { local LC_ALL=C; [[ "$1" =~ ^[a-z][a-z0-9]{1,15}$ ]]; }
person_login() { printf 'jale_person_%s' "$1"; }
person_secret_name() { printf 'jale/person-%s/db' "$1"; }

ACTION=""
HANDLE=""
DAYS=""
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) awk 'NR > 1 && /^# ---/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    --days)
      [[ $# -ge 2 ]] || usage_error "--days needs a number of days"
      DAYS="$2"; shift ;;
    --yes|-y) ASSUME_YES=true ;;
    create|renew|remove)
      [[ -z "$ACTION" ]] || usage_error "give one action"
      ACTION="$1" ;;
    -*) usage_error "unknown option" ;;
    *)
      [[ -n "$ACTION" && -z "$HANDLE" ]] || usage_error "usage: person-login.sh create|renew|remove <handle>"
      HANDLE="$1" ;;
  esac
  shift
done

[[ -n "$ACTION" && -n "$HANDLE" ]] || usage_error "usage: person-login.sh create|renew|remove <handle>"
is_person_handle "$HANDLE" \
  || usage_error "the handle must be 2 to 16 lower-case letters and digits, starting with a letter"
if [[ "$ACTION" == remove ]]; then
  [[ -z "$DAYS" ]] || usage_error "--days does not apply to remove"
else
  DAYS="${DAYS:-$DEFAULT_DAYS}"
  [[ "$DAYS" =~ ^[1-9][0-9]?$ ]] && (( DAYS <= 90 )) || usage_error "--days must be 1 to 90"
fi

LOGIN=$(person_login "$HANDLE")
SECRET_NAME=$(person_secret_name "$HANDLE")

# ---------------------------------------------------------------------------
# Tools and the working directory.
# ---------------------------------------------------------------------------
command -v aws >/dev/null 2>&1 || die "the aws CLI v2 is required"
[[ "$(aws --version 2>&1)" == aws-cli/2.* ]] || die "the aws CLI v2 is required (found another version)"
command -v jq >/dev/null 2>&1 || die "jq is required"
if [[ "$ACTION" != remove ]]; then
  command -v python3 >/dev/null 2>&1 || die "python3 is required; it computes the SCRAM verifier on this machine"
  [[ -s "$SCRAM_HELPER" ]] || die "scripts/lib/scram-verifier.py is missing; run from a checkout of the repo"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
ERR="$WORKDIR/stderr"

# The AWS CLI's error text names accounts and resources; only its code is shown.
aws_code() {
  local code
  code=$(grep -oE 'An error occurred \([A-Za-z]+\)' "$ERR" 2>/dev/null | head -n 1 | grep -oE '\([A-Za-z]+\)' | tr -d '()') || code=""
  printf '%s' "${code:-no error code}"
}

# ---------------------------------------------------------------------------
# Who is running this. Never printed.
# ---------------------------------------------------------------------------
aws sts get-caller-identity --region "$REGION" --output json > "$WORKDIR/identity.json" 2>"$ERR" \
  || die "reading your AWS identity failed ($(aws_code)); sign in to AWS first"
CALLER_ID=$(jq -r '.UserId // empty' "$WORKDIR/identity.json")
# An IAM user (AIDA...) or a role session (AROA...:<session name>). The
# secret's policy names exactly this id, so a role session's name must stay
# the same from one sign-in to the next: IAM Identity Center uses your user
# name; a generated name would lock you out of your own secret next time.
if [[ ! "$CALLER_ID" =~ ^(AIDA[A-Z0-9]{8,}|AROA[A-Z0-9]{8,}:[A-Za-z0-9_+=,.@-]{2,64})$ ]]; then
  die "run this as an IAM user or an IAM Identity Center role session, not as the root user or a federated token"
fi
if [[ "$CALLER_ID" =~ :(botocore-session-[0-9]+|aws-go-sdk-[0-9]+)$ ]]; then
  die "your role session has a generated name, which changes at every sign-in; use a session with a fixed name (IAM Identity Center sets your user name)"
fi

# The secret's resource policy: nobody but you reads or writes its value.
# Identity policies elsewhere in the account would otherwise allow it, so this
# is an explicit deny for every other identity, keyed on your user id. It also
# denies them removing, replacing or copying the policy itself, which would
# otherwise undo the rest. Deleting the secret stays open: anyone may remove
# another person's login.
jq -n --arg me "$CALLER_ID" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "OnlyItsOwnerUsesTheValue",
    Effect: "Deny",
    Principal: "*",
    Action: [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:UpdateSecretVersionStage",
      "secretsmanager:RotateSecret",
      "secretsmanager:PutResourcePolicy",
      "secretsmanager:DeleteResourcePolicy",
      "secretsmanager:ReplicateSecretToRegions"
    ],
    Resource: "*",
    Condition: {StringNotEquals: {"aws:userid": $me}}
  }]
}' > "$WORKDIR/policy.json"

# True for a policy that denies every identity but this caller the value
# actions and the policy actions, whatever form AWS returns it in (a single
# value or a list).
POLICY_IS_MINE='
  def list: if type == "array" then . else [.] end;
  ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret",
   "secretsmanager:UpdateSecretVersionStage", "secretsmanager:RotateSecret",
   "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy",
   "secretsmanager:ReplicateSecretToRegions"] as $actions
  | [ .Statement | list | .[]
      | select(.Effect == "Deny")
      | select(.Principal == "*" or ((.Principal | type) == "object" and (.Principal.AWS | list) == ["*"]))
      | select(((.Action | list) as $a | $actions - $a | length) == 0)
      | select((.Resource | list) == ["*"])
      | select(.Condition | keys == ["StringNotEquals"])
      | select(.Condition.StringNotEquals | to_entries | length == 1)
      | select(.Condition.StringNotEquals | to_entries[0] | (.key | ascii_downcase) == "aws:userid" and (.value | list) == [$me]) ]
  | length >= 1'

# Sets SECRET_STATE: missing | deleting | mine | unprotected-empty | other.
secret_state() {
  local versions policy
  if ! aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" --output json \
         > "$WORKDIR/describe.json" 2>"$ERR"; then
    if grep -q 'ResourceNotFoundException' "$ERR"; then SECRET_STATE=missing; return 0; fi
    die "checking your secret failed ($(aws_code)); nothing was changed"
  fi
  if jq -e '.DeletedDate != null' "$WORKDIR/describe.json" >/dev/null; then
    SECRET_STATE=deleting; return 0
  fi
  policy=$(aws secretsmanager get-resource-policy --region "$REGION" --secret-id "$SECRET_NAME" \
             --query ResourcePolicy --output text 2>"$ERR") \
    || die "reading your secret's policy failed ($(aws_code)); nothing was changed"
  if [[ -z "$policy" || "$policy" == "None" ]]; then
    versions=$(jq '(.VersionIdsToStages // {}) | length' "$WORKDIR/describe.json")
    if [[ "$versions" == 0 ]]; then SECRET_STATE=unprotected-empty; else SECRET_STATE=other; fi
    return 0
  fi
  if printf '%s' "$policy" | jq -e --arg me "$CALLER_ID" "$POLICY_IS_MINE" >/dev/null 2>&1; then
    SECRET_STATE=mine
  else
    SECRET_STATE=other
  fi
}

# Applies the policy and reads it back.
protect_secret() {
  aws secretsmanager put-resource-policy --region "$REGION" --secret-id "$SECRET_NAME" \
      --resource-policy "file://$WORKDIR/policy.json" --block-public-policy >/dev/null 2>"$ERR" \
    || die "setting your secret's policy failed ($(aws_code)); it holds no password yet. Re-run $ACTION."
  secret_state
  [[ "$SECRET_STATE" == mine ]] \
    || die "your secret's policy did not read back as limited to you; it holds no password yet. Re-run $ACTION."
}

# ---------------------------------------------------------------------------
# The ops host, the master secret, and the ops-command log group.
# ---------------------------------------------------------------------------
resolve_ops_host() {
  BASTION_ID=$(aws cloudformation describe-stacks --stack-name "$BASTION_STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text 2>"$ERR") \
    || die "the ops host is not deployed ($(aws_code)); deploy it with bash scripts/deploy-bastion.sh"
  [[ -n "$BASTION_ID" && "$BASTION_ID" != "None" ]] \
    || die "the ops host is not deployed; deploy it with bash scripts/deploy-bastion.sh"
  DB_SECRET_ARN=$(aws cloudformation describe-stack-resources --stack-name "$DATABASE_STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]" \
    --output text 2>"$ERR") \
    || die "resolving the master login's secret failed ($(aws_code))"
  [[ -n "$DB_SECRET_ARN" && "$DB_SECRET_ARN" != "None" ]] || die "could not find the master login's secret"

  # Every command sent to the ops host is recorded. There is no way around it.
  local groups
  groups=$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$OPS_COMMAND_LOG_GROUP" \
             --query "length(logGroups[?logGroupName=='$OPS_COMMAND_LOG_GROUP'])" --output text 2>"$ERR") \
    || die "checking the ops-command log group failed ($(aws_code)); nothing was sent"
  [[ "$groups" == 1 ]] \
    || die "the ops-command log group does not exist, so the command would not be recorded; nothing was sent"
}

# The next step after a command on the ops host whose outcome this run could
# not see, or that failed once the new password was stored. Create and renew
# store the new password before they send the procedure call. Running either
# again while that command may still run, or create again after a creation
# that did complete, leaves the secret on a password the login does not have;
# a renew puts the two back in step whenever the login exists.
next_step() {   # $1: until (that command may still be running) or first (it has ended)
  local check
  if [[ "$1" == until ]]; then
    check="Check the ops-command log until that command ('personal login: $ACTION') has ended."
  else
    check="Check the ops-command log for that command ('personal login: $ACTION') first."
  fi
  if [[ "$ACTION" == remove ]]; then
    printf '%s Then run: bash scripts/ops/person-login.sh remove %s.' "$check" "$HANDLE"
  else
    printf '%s Then, if the login exists or was just created, run: bash scripts/ops/person-login.sh renew %s. Run create only if the log shows that no login was created.' "$check" "$HANDLE"
  fi
}

# Sends $1 (a script file) to the ops host and sets RESULT from its
# PERSON_RESULT line. The request carries the ops-command output config, and
# is checked for it before it leaves.
run_on_ops_host() {
  local script_file="$1" comment="$2" request="$WORKDIR/request.json" out="$WORKDIR/out.txt" cmd_id status poll
  [[ -s "$script_file" ]] || die "refusing to send an empty command"
  jq -Rn --rawfile s "$script_file" --arg id "$BASTION_ID" --arg c "$comment" --arg group "$OPS_COMMAND_LOG_GROUP" \
    '{InstanceIds: [$id], DocumentName: "AWS-RunShellScript", Comment: $c, Parameters: {commands: [$s]},
      CloudWatchOutputConfig: {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}}' > "$request"
  jq -e '.Parameters.commands[0] | length > 0' "$request" >/dev/null || die "the command to send is empty"
  jq -e --arg group "$OPS_COMMAND_LOG_GROUP" \
     '.CloudWatchOutputConfig == {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}' "$request" >/dev/null \
    || die "the command does not carry the ops-command output config"

  cmd_id=$(aws ssm send-command --region "$REGION" --cli-input-json "file://$request" \
             --query "Command.CommandId" --output text 2>"$ERR") \
    || die "sending the command to the ops host failed ($(aws_code))"
  [[ -n "$cmd_id" && "$cmd_id" != "None" ]] || die "the ops host returned no command id"

  for (( poll = 1; ; poll++ )); do
    if status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$BASTION_ID" \
                  --query "Status" --output text 2>"$ERR"); then
      case "$status" in
        Success) break ;;
        Failed|Cancelled|TimedOut)
          aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$BASTION_ID" \
            --query "StandardOutputContent" --output text > "$out" 2>/dev/null || true
          RESULT=$(grep -m1 '^PERSON_RESULT=' "$out" | cut -d= -f2-) || RESULT=""
          [[ -n "$RESULT" ]] || RESULT="failed|the command on the ops host ended $status"
          return 0 ;;
      esac
    else
      # Right after the send the invocation may not be visible yet, and a
      # throttled read is worth another try. No other error goes away by
      # waiting.
      case "$(aws_code)" in
        InvocationDoesNotExist|ThrottlingException|Throttling|TooManyRequestsException|RequestLimitExceeded) ;;
        *) die "waiting for the command on the ops host failed ($(aws_code)); its outcome is unknown. $(next_step until)" ;;
      esac
    fi
    (( poll < SSM_MAX_POLLS )) \
      || die "the command on the ops host did not finish after $SSM_MAX_POLLS status reads (at least $(( (SSM_MAX_POLLS - 1) * SSM_POLL_SECONDS / 60 )) minutes); its outcome is unknown. $(next_step until)"
    sleep "$SSM_POLL_SECONDS"
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$BASTION_ID" \
    --query "StandardOutputContent" --output text > "$out" 2>"$ERR" \
    || die "reading the command's result failed ($(aws_code)); its outcome is unknown. $(next_step first)"
  grep -q "$SENTINEL" "$out" || die "the command on the ops host did not finish; its outcome is unknown. $(next_step first)"
  RESULT=$(grep -m1 '^PERSON_RESULT=' "$out" | cut -d= -f2-) || RESULT=""
  [[ -n "$RESULT" ]] || die "the command on the ops host reported no result; its outcome is unknown. $(next_step first)"
}

# The ops host side: the master login runs one procedure call, given on
# psql's stdin. It prints one PERSON_RESULT line: a code and a time or count,
# never the login, the verifier, a host or psql's text.
emit_ops_payload() {   # $1 the procedure call
  cat <<PREAMBLE
#!/bin/bash
set -euo pipefail
REGION="$REGION"
DB_SECRET_ARN="$DB_SECRET_ARN"
PREAMBLE
  cat <<'OPS_PAYLOAD'
result() { printf 'PERSON_RESULT=%s\n' "$1"; }
command -v psql >/dev/null 2>&1 || { result "failed|the ops host is not ready (psql is not installed yet)"; exit 1; }
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text 2>"$ERR") || { result "failed|the ops host could not read the master login's secret"; exit 1; }
export PGPASSWORD=$(printf '%s' "$SECRET_JSON" | jq -r .password)
DB_HOST=$(printf '%s' "$SECRET_JSON" | jq -r .host)
DB_PORT=$(printf '%s' "$SECRET_JSON" | jq -r .port)
DB_NAME=$(printf '%s' "$SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(printf '%s' "$SECRET_JSON" | jq -r .username)
SECRET_JSON=""
if printf '%s\n' "$PERSON_CALL" | psql -X -q -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f - >/dev/null 2>"$ERR"; then
  until_at=$(grep -oE 'until [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$ERR" | head -n 1 | cut -d' ' -f2) || until_at=""
  sessions=$(grep -oE 'removed; [0-9]+ open sessions' "$ERR" | head -n 1 | grep -oE '[0-9]+') || sessions=""
  if [[ -n "$until_at" ]]; then result "done|$until_at"
  elif [[ -n "$sessions" ]]; then result "removed|$sessions"
  else result "done|"
  fi
elif grep -qE 'procedure jale_ops\.[a-z_]+\(.*\) does not exist|schema "jale_ops" does not exist' "$ERR"; then
  result "failed|the personal-login procedures are not in the database yet (apply the migrations first)"
elif grep -q 'already exists; renew or remove it' "$ERR"; then result "exists|"
elif grep -qE '(renew|remove)_person: jale_person_[a-z0-9]+ does not exist' "$ERR"; then result "missing|"
elif grep -qE 'membership shape|elevated attribute' "$ERR"; then result "failed|the login does not have the personal-login shape; remove it, then create it again"
elif grep -q 'the verifier must be' "$ERR"; then result "failed|the database refused the verifier"
elif grep -q 'permission denied' "$ERR"; then result "failed|permission denied"
elif grep -qE 'could not connect|Connection refused|timeout expired|could not translate host|password authentication failed' "$ERR"; then
  result "failed|the ops host could not sign in to the database"
else result "failed|the database refused the change"
fi
unset PGPASSWORD
OPS_PAYLOAD
  printf 'echo "%s"\n' "$SENTINEL"
}

# Writes the payload for one procedure call to $WORKDIR/ops.sh. The call is
# built from checked parts only: the handle (its rule), the verifier (its
# format) and the days (a number), so nothing in it needs quoting.
write_ops_payload() {   # $1 the procedure call
  {
    printf "PERSON_CALL=\$(cat <<'PERSON_CALL_SQL'\n%s\nPERSON_CALL_SQL\n)\n" "$1"
    emit_ops_payload
  } > "$WORKDIR/ops.sh"
}

# ---------------------------------------------------------------------------
# The password and its verifier.
# ---------------------------------------------------------------------------
new_password() {
  PW=$(aws secretsmanager get-random-password --region "$REGION" --password-length "$PASSWORD_LENGTH" \
         --exclude-punctuation --require-each-included-type --query RandomPassword --output text 2>"$ERR") \
    || { PW=""; die "asking AWS for a password failed ($(aws_code)); nothing was changed"; }
  [[ "$PW" =~ ^[A-Za-z0-9]{40}$ ]] || { PW=""; die "the generated password has an unexpected shape; nothing was changed"; }
  VERIFIER=$(printf '%s' "$PW" | python3 "$SCRAM_HELPER" 2>/dev/null) \
    || { PW=""; die "computing the verifier failed; nothing was changed"; }
  [[ "$VERIFIER" =~ ^SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$ ]] \
    || { PW=""; VERIFIER=""; die "the verifier has an unexpected shape; nothing was changed"; }
}

# Stores PW in your secret, on the CLI's stdin.
store_password() {
  printf '%s' "$PW" | jq -Rs --arg id "$SECRET_NAME" --arg u "$LOGIN" \
      '{SecretId: $id, SecretString: ({username: $u, password: .} | tojson)}' \
    | aws secretsmanager put-secret-value --region "$REGION" --cli-input-json file:///dev/stdin >/dev/null 2>"$ERR" \
    || { PW=""; VERIFIER=""; die "storing the new password in your secret failed ($(aws_code)); the database was not changed"; }
  PW=""
}

confirm() {
  $ASSUME_YES && return 0
  echo
  echo "$1"
  local reply
  read -r -p "Type 'yes' to continue: " reply
  [[ "$reply" == "yes" ]] || die "aborted"
}

# ---------------------------------------------------------------------------
# The actions.
# ---------------------------------------------------------------------------
case "$ACTION" in
  create|renew)
    secret_state
    if [[ "$SECRET_STATE" == deleting ]]; then
      die "the secret for handle $HANDLE is scheduled for deletion; restore it, or wait until it is gone, then re-run"
    fi
    if [[ "$ACTION" == renew && "$SECRET_STATE" == missing ]]; then
      die "you have no secret for handle $HANDLE; use create"
    fi
    if [[ "$SECRET_STATE" == other ]]; then
      die "the secret for handle $HANDLE is not limited to your identity; nothing was changed. If it is yours from another identity, renew it from there; otherwise ask whoever owns it."
    fi
    resolve_ops_host
    if [[ "$ACTION" == create ]]; then
      confirm "About to create the personal database login for handle $HANDLE, valid for $DAYS day(s)."
      if [[ "$SECRET_STATE" == missing ]]; then
        jq -n --arg name "$SECRET_NAME" --arg login "$LOGIN" '{
          Name: $name,
          Description: ("Personal database login " + $login + ", created by scripts/ops/person-login.sh"),
          Tags: [{Key: "project", Value: "jale"}, {Key: "db-login-kind", Value: "person"}]
        }' > "$WORKDIR/create.json"
        aws secretsmanager create-secret --region "$REGION" --cli-input-json "file://$WORKDIR/create.json" >/dev/null 2>"$ERR" \
          || die "creating your secret failed ($(aws_code)); nothing was changed"
        protect_secret
        note "secret created, limited to your identity"
      elif [[ "$SECRET_STATE" == unprotected-empty ]]; then
        protect_secret
        note "secret found without its policy and without a value; policy set"
      else
        note "secret exists and is limited to your identity"
      fi
      procedure="provision_person"
    else
      confirm "About to renew the personal database login for handle $HANDLE, for $DAYS day(s), with a new password."
      [[ "$SECRET_STATE" == mine ]] || protect_secret
      procedure="renew_person"
    fi

    new_password
    store_password
    note "new password stored in your secret"
    write_ops_payload "CALL jale_ops.${procedure}('${HANDLE}', '${VERIFIER}', ${DAYS});"
    VERIFIER=""
    run_on_ops_host "$WORKDIR/ops.sh" "personal login: $ACTION"
    rm -f "$WORKDIR/ops.sh" "$WORKDIR/request.json"
    case "$RESULT" in
      done\|*)
        until_at="${RESULT#done|}"
        note "$LOGIN can sign in until ${until_at:-the date the database set}"
        note "connect with: bash scripts/ops/person-psql.sh $HANDLE" ;;
      exists\|*)
        die "the login already exists in the database; your secret now holds a password it does not know. Run: bash scripts/ops/person-login.sh renew $HANDLE" ;;
      missing\|*)
        die "the login does not exist in the database; your secret now holds a password nothing uses. Run: bash scripts/ops/person-login.sh create $HANDLE" ;;
      failed\|*"personal-login shape"*)
        # A login renew may not change: the result names its own next step.
        die "${RESULT#*|}" ;;
      *)
        die "${RESULT#*|}; your secret holds a new password that the database may not know. $(next_step first)" ;;
    esac
    ;;

  remove)
    secret_state
    resolve_ops_host
    confirm "About to remove the personal database login for handle $HANDLE and delete its secret."
    write_ops_payload "CALL jale_ops.remove_person('${HANDLE}');"
    run_on_ops_host "$WORKDIR/ops.sh" "personal login: remove"
    case "$RESULT" in
      removed\|*) note "login removed (${RESULT#removed|} session(s) were open)" ;;
      done\|*)    note "login removed" ;;
      missing\|*) note "the login was not in the database" ;;
      *) die "${RESULT#*|}; the login and its secret were kept" ;;
    esac
    if [[ "$SECRET_STATE" == missing || "$SECRET_STATE" == deleting ]]; then
      note "no secret to delete"
    else
      aws secretsmanager delete-secret --region "$REGION" --secret-id "$SECRET_NAME" --force-delete-without-recovery \
          >/dev/null 2>"$ERR" \
        || die "deleting the secret failed ($(aws_code)); the login is already removed, so the password in it signs in nowhere"
      note "secret deleted"
    fi
    ;;
esac
