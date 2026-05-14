#!/usr/bin/env bash
#
# run-migrations.sh — Apply DB migrations against the Jale RDS via the
# ephemeral BastionStack. Usage:
#
#   1. Deploy the bastion: `npx cdk deploy JaleBastionStack` (from infra/)
#   2. Run this script:    `bash scripts/run-migrations.sh`
#   3. Destroy the bastion: `npx cdk destroy JaleBastionStack`
#
# What this does:
#   - Resolves the bastion instance ID from CloudFormation output
#   - Resolves the jale_admin DB secret ARN from CloudFormation
#   - Base64-encodes migrations 001→014
#   - `aws ssm send-command` runs a script ON THE BASTION that:
#       * Fetches jale_admin creds via IAM role
#       * Applies each migration as jale_admin (one transaction per file)
#       * Generates a random password for jale_whatsapp
#       * ALTERs the role password
#       * Creates/updates jale/whatsapp/db secret
#   - Polls command status, streams bastion stdout to operator
#
# Requirements on operator machine: aws CLI v2, jq, base64 (all present
# in AWS CloudShell by default; on Windows use Git Bash / WSL).
#
# No `psql` needed locally — all DB work happens on the bastion.

set -euo pipefail

BASTION_STACK="JaleBastionStack"
DATABASE_STACK="JaleDatabaseStack"
WA_DB_SECRET_NAME="jale/whatsapp/db"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"

# Migration files in execution order. Runs the full chain 001→014 against
# a fresh RDS — safe to re-run; every file wraps its own BEGIN/COMMIT and
# is idempotent via CREATE...IF NOT EXISTS or equivalent guards.
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
  "013_application_status_alignment.sql"
  "014_employer_profiles.sql"
)

echo ">> Using region: $REGION"

# ---------------------------------------------------------------------------
# Resolve bastion + DB-secret ARNs from CloudFormation.
# ---------------------------------------------------------------------------
echo ">> Resolving bastion instance ID..."
BASTION_ID=$(aws cloudformation describe-stacks \
  --stack-name "$BASTION_STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" \
  --output text)

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
  --output text | head -n 1)

if [[ -z "$DB_SECRET_ARN" ]]; then
  echo "!! Could not find DB secret in $DATABASE_STACK."
  exit 1
fi
echo "   db-secret: $DB_SECRET_ARN"

# ---------------------------------------------------------------------------
# Base64-encode each migration + prepare the remote script.
# ---------------------------------------------------------------------------
for f in "${MIGRATIONS[@]}"; do
  if [[ ! -f "$MIGRATION_DIR/$f" ]]; then
    echo "!! Migration file missing: $MIGRATION_DIR/$f"
    exit 1
  fi
done

# Encode all migrations into a single variable assignment block. Using
# single-line base64 (-w0 on GNU coreutils; on macOS/BSD, base64 has no
# -w flag and produces single-line by default — we tr -d '\n' to normalize).
declare -A MIGRATION_B64
for f in "${MIGRATIONS[@]}"; do
  MIGRATION_B64["$f"]=$(base64 "$MIGRATION_DIR/$f" | tr -d '\n')
done

# Remote script executed by the bastion via SSM.
# Notes:
#   - Exits on any error (set -e).
#   - jq parses the RDS master secret shape: {host, port, username, password, dbname, ...}
#   - Password for jale_whatsapp is generated with openssl, URL-safe chars only.
#   - Secret create-or-update: `describe-secret` returns non-zero if absent;
#     we check and branch to create vs put.
REMOTE_SCRIPT=$(cat <<REMOTE_EOF
#!/bin/bash
set -euo pipefail

REGION="$REGION"
DB_SECRET_ARN="$DB_SECRET_ARN"
WA_DB_SECRET_NAME="$WA_DB_SECRET_NAME"

echo ">> Fetching jale_admin creds from \$DB_SECRET_ARN"
DB_SECRET_JSON=\$(aws secretsmanager get-secret-value \
  --secret-id "\$DB_SECRET_ARN" \
  --region "\$REGION" \
  --query SecretString --output text)
DB_HOST=\$(echo "\$DB_SECRET_JSON" | jq -r .host)
DB_PORT=\$(echo "\$DB_SECRET_JSON" | jq -r .port)
DB_NAME=\$(echo "\$DB_SECRET_JSON" | jq -r '.dbname // "jale"')
DB_USER=\$(echo "\$DB_SECRET_JSON" | jq -r .username)
DB_PASS=\$(echo "\$DB_SECRET_JSON" | jq -r .password)

export PGPASSWORD="\$DB_PASS"
PG_CMD=(psql -h "\$DB_HOST" -p "\$DB_PORT" -U "\$DB_USER" -d "\$DB_NAME" -v ON_ERROR_STOP=1)

echo ">> Applying migrations..."
MIGRATION_FILES=($(printf '"%s" ' "${MIGRATIONS[@]}"))
declare -A MIGRATION_B64_REMOTE
$(for f in "${MIGRATIONS[@]}"; do
    echo "MIGRATION_B64_REMOTE[\"$f\"]='${MIGRATION_B64[$f]}'"
  done)

for f in "\${MIGRATION_FILES[@]}"; do
  echo "   → \$f"
  TMP="/tmp/mig-\${f}"
  echo "\${MIGRATION_B64_REMOTE[\$f]}" | base64 -d > "\$TMP"
  "\${PG_CMD[@]}" -f "\$TMP"
  rm -f "\$TMP"
done

echo ">> Migrations applied cleanly."

echo ">> Generating jale_whatsapp password + setting ALTER ROLE..."
# 32 bytes base64 → strip =+/ → first 24 chars. URL-safe, no quoting issues
# in SQL or JSON.
WA_PW=\$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-24)
"\${PG_CMD[@]}" -c "ALTER ROLE jale_whatsapp WITH PASSWORD '\$WA_PW';"

echo ">> Seeding jale/whatsapp/db secret..."
SECRET_STRING=\$(jq -n \
  --arg host "\$DB_HOST" \
  --arg port "\$DB_PORT" \
  --arg dbname "\$DB_NAME" \
  --arg username "jale_whatsapp" \
  --arg password "\$WA_PW" \
  '{host: \$host, port: (\$port | tonumber), dbname: \$dbname, username: \$username, password: \$password}')

if aws secretsmanager describe-secret \
     --secret-id "\$WA_DB_SECRET_NAME" \
     --region "\$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "\$WA_DB_SECRET_NAME" \
    --region "\$REGION" \
    --secret-string "\$SECRET_STRING" >/dev/null
  echo "   updated existing secret"
else
  aws secretsmanager create-secret \
    --name "\$WA_DB_SECRET_NAME" \
    --region "\$REGION" \
    --description "jale_whatsapp role credentials for WhatsApp Lambdas" \
    --secret-string "\$SECRET_STRING" >/dev/null
  echo "   created new secret"
fi

unset PGPASSWORD WA_PW SECRET_STRING DB_PASS
echo ">> Done."
REMOTE_EOF
)

# ---------------------------------------------------------------------------
# Send the command, wait for it to finish, stream stdout.
# ---------------------------------------------------------------------------
echo ">> Sending command to bastion via SSM..."
CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$BASTION_ID" \
  --comment "Jale DB migrations + jale_whatsapp password seed" \
  --parameters "commands=$(jq -Rn --arg s "$REMOTE_SCRIPT" '[$s]')" \
  --query "Command.CommandId" \
  --output text)

echo "   CommandId: $CMD_ID"
echo ">> Waiting for command to complete..."

while true; do
  STATUS=$(aws ssm list-command-invocations \
    --region "$REGION" \
    --command-id "$CMD_ID" \
    --details \
    --query "CommandInvocations[0].Status" \
    --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in
    Success)
      echo ">> Command succeeded."
      break
      ;;
    Failed|Cancelled|TimedOut)
      echo "!! Command ended with status: $STATUS"
      aws ssm list-command-invocations \
        --region "$REGION" \
        --command-id "$CMD_ID" \
        --details \
        --query "CommandInvocations[0].CommandPlugins[0].{Status:Status,Out:Output}" \
        --output json
      exit 1
      ;;
    *)
      sleep 5
      ;;
  esac
done

echo ">> Final bastion stdout:"
aws ssm list-command-invocations \
  --region "$REGION" \
  --command-id "$CMD_ID" \
  --details \
  --query "CommandInvocations[0].CommandPlugins[0].Output" \
  --output text

echo
echo ">> All done. Next:"
echo "   cd infra && npx cdk destroy JaleBastionStack    # cost hygiene"
echo "   cd infra && npx cdk deploy JaleAuthStack JaleApiStack JaleLegalStack JaleWhatsAppStack"
