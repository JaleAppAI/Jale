#!/usr/bin/env bash
#
# run-migrations.sh - Apply DB migrations through the bastion using an SSM
# port-forward tunnel, then run psql locally.
#
# This branch's bastion does NOT have NAT, so it cannot install psql on boot.
# The bastion is only used as a Session Manager tunnel target.

set -euo pipefail

BASTION_STACK="JaleBastionStack"
DATABASE_STACK="JaleDatabaseStack"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
LOCAL_PORT=5432
REMOTE_PORT=5432

MIGRATION_DIR="$(cd "$(dirname "$0")/../infra/db/migrations" && pwd)"
MIGRATIONS=(
  "001_initial_schema.sql"
  "002_rls_policies.sql"
  "003_jobs_and_applications.sql"
  "004_document_vault.sql"
  "005_worker_marketplace.sql"
)

cleanup() {
  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_port() {
  local host="$1"
  local port="$2"
  local deadline=$((SECONDS + 30))

  while (( SECONDS < deadline )); do
    if bash -c "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

echo ">> Using region: $REGION"

echo ">> Resolving bastion instance ID..."
BASTION_ID=$(aws cloudformation describe-stacks \
  --stack-name "$BASTION_STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" \
  --output text | tr -d '\r')

if [[ -z "$BASTION_ID" || "$BASTION_ID" == "None" ]]; then
  echo "!! Could not find BastionInstanceId output on $BASTION_STACK."
  echo "   Deploy the stack first: cd infra && npx cdk deploy $BASTION_STACK"
  exit 1
fi
echo "   bastion: $BASTION_ID"

echo ">> Resolving jale_admin DB secret ARN..."
DB_SECRET_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name "$DATABASE_STACK" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId" \
  --output text | head -n 1 | tr -d '\r')

if [[ -z "$DB_SECRET_ARN" || "$DB_SECRET_ARN" == "None" ]]; then
  echo "!! Could not find DB secret in $DATABASE_STACK."
  exit 1
fi
echo "   db-secret: $DB_SECRET_ARN"

echo ">> Reading database connection details..."
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$REGION" \
  --query SecretString \
  --output text)

DB_HOST=$(echo "$SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$SECRET_JSON" | jq -r .port)
DB_NAME=$(echo "$SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=$(echo "$SECRET_JSON" | jq -r .username)
DB_PASS=$(echo "$SECRET_JSON" | jq -r .password)

for f in "${MIGRATIONS[@]}"; do
  if [[ ! -f "$MIGRATION_DIR/$f" ]]; then
    echo "!! Migration file missing: $MIGRATION_DIR/$f"
    exit 1
  fi
done

if ! command -v psql >/dev/null 2>&1; then
  echo "!! psql was not found on this machine."
  echo "   Run this script from CloudShell or another host with psql installed."
  exit 1
fi

echo ">> Starting SSM tunnel through bastion..."
aws ssm start-session \
  --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"$REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}" \
  --region "$REGION" >/tmp/jale-bastion-tunnel.log 2>&1 &
TUNNEL_PID=$!

if ! wait_for_port 127.0.0.1 "$LOCAL_PORT"; then
  echo "!! Timed out waiting for the SSM tunnel on 127.0.0.1:$LOCAL_PORT."
  echo "   Tunnel log:"
  cat /tmp/jale-bastion-tunnel.log || true
  exit 1
fi

echo "   tunnel active: 127.0.0.1:$LOCAL_PORT -> $DB_HOST:$REMOTE_PORT"

export PGPASSWORD="$DB_PASS"
for f in "${MIGRATIONS[@]}"; do
  echo "   -> $f"
  psql -h 127.0.0.1 -p "$LOCAL_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$MIGRATION_DIR/$f"
done
unset PGPASSWORD

echo ">> Migrations applied cleanly."
echo
echo ">> All done. Next:"
echo "   npx cdk destroy JaleBastionStack    # cost hygiene"
