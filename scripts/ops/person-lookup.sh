#!/usr/bin/env bash
#
# person-lookup.sh: find a user's id from a contact value, without the value
# ever being part of a statement.
#
# Usage:
#   bash scripts/ops/person-lookup.sh <handle> <kind> [--local-port N]
#
#   <handle>   your handle (your personal database login)
#   <kind>     email | phone | whatsapp | cognito_sub
#
# It asks for the value at a hidden prompt (or reads one line from stdin when
# stdin is not a terminal), then runs jale_ops.find_user through
# scripts/ops/person-psql.sh. The value reaches psql on its stdin (\prompt)
# and the server as a bound parameter (\bind): it is never an argument, never
# in the statement text the audit log keeps, and never printed. The output is
# the user's id, or that no user matches.
#
# ---------------------------------------------------------------------------

set -euo pipefail
umask 077

die()  { echo "!! $*" >&2; exit 1; }
usage_error() { echo "!! $*" >&2; echo "   see: bash scripts/ops/person-lookup.sh --help" >&2; exit 2; }

# The handle rule jale_ops.provision_person enforces, in the C locale.
is_person_handle() { local LC_ALL=C; [[ "$1" =~ ^[a-z][a-z0-9]{1,15}$ ]]; }

HANDLE=""
KIND=""
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) awk 'NR > 1 && /^# ---/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    --local-port)
      [[ $# -ge 2 ]] || usage_error "--local-port needs a port number"
      FORWARD_ARGS=(--local-port "$2"); shift ;;
    -*) usage_error "unknown option" ;;
    *)
      if [[ -z "$HANDLE" ]]; then HANDLE="$1"
      elif [[ -z "$KIND" ]]; then KIND="$1"
      else usage_error "usage: person-lookup.sh <handle> <kind>"
      fi ;;
  esac
  shift
done

[[ -n "$HANDLE" && -n "$KIND" ]] || usage_error "usage: person-lookup.sh <handle> <email|phone|whatsapp|cognito_sub>"
is_person_handle "$HANDLE" \
  || usage_error "the handle must be 2 to 16 lower-case letters and digits, starting with a letter"
case "$KIND" in
  email|phone|whatsapp|cognito_sub) ;;
  *) usage_error "the kind must be email, phone, whatsapp or cognito_sub" ;;
esac

PERSON_PSQL="$(cd "$(dirname "$0")" && pwd)/person-psql.sh"
[[ -f "$PERSON_PSQL" ]] || die "scripts/ops/person-psql.sh is missing; run from a checkout of the repo"

# ---------------------------------------------------------------------------
# The value: hidden, held in memory, one line.
# ---------------------------------------------------------------------------
VALUE=""
if [[ -t 0 ]]; then
  read -r -s -p "$KIND to look up (hidden): " VALUE || true
  echo >&2
else
  IFS= read -r VALUE || [[ -n "$VALUE" ]] || true
fi
[[ -n "$VALUE" ]] || die "no value given"
(( ${#VALUE} <= 320 )) || { VALUE=""; die "the value is longer than 320 characters"; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# The script holds no value: \prompt reads it from psql's stdin into a psql
# variable, and \bind sends it as the second parameter.
cat > "$WORKDIR/lookup.sql" <<'LOOKUP'
\prompt lookup_value
SELECT jale_ops.find_user($1, $2) \bind :kind :lookup_value \g
LOOKUP

status=0
out=$(printf '%s\n' "$VALUE" | bash "$PERSON_PSQL" "$HANDLE" ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} -- \
        -X -q -At -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v "kind=$KIND" -f "$WORKDIR/lookup.sql" \
        2>"$WORKDIR/stderr") || status=$?
VALUE=""

if (( status != 0 )); then
  # person-psql.sh's own messages carry no value; psql's are reduced to a kind.
  grep -E '^!! ' "$WORKDIR/stderr" >&2 || true
  if grep -q 'users match' "$WORKDIR/stderr"; then die "more than one user matches; look the user up by another kind"
  elif grep -q 'needs 7 to 15 digits' "$WORKDIR/stderr"; then die "a phone or WhatsApp number needs 7 to 15 digits"
  elif grep -q 'the value must be 1 to 320 characters' "$WORKDIR/stderr"; then die "the value must be 1 to 320 characters"
  elif grep -q 'permission denied' "$WORKDIR/stderr"; then die "your login may not run the lookup"
  elif grep -q '^!! ' "$WORKDIR/stderr"; then exit "$status"
  else die "the lookup failed"
  fi
fi

# The only line psql prints is the id, or an empty line when none matches.
id=$(printf '%s\n' "$out" | tail -n 1)
if [[ -z "$id" ]]; then
  echo "no user matches"
elif [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "user id: $id"
else
  die "the lookup returned something other than a user id"
fi
