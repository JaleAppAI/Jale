#!/usr/bin/env bash
# Scoped production upgrade for the schema delta after migration 034.
# Safe default: verification only. Pass --apply explicitly to execute.

set -euo pipefail

REGION='us-east-2'
EXPECTED_ACCOUNT_ID=''
APPLY=0
BASTION_STACK='JaleBastionStack'
DATABASE_STACK='JaleDatabaseStack'
MAX_POLLS=192
DELIVERY_TIMEOUT_SECONDS=60
REMOTE_EXECUTION_TIMEOUT_SECONDS=840

usage() {
  cat <<'EOF'
Usage:
  scripts/run-production-upgrade-020b-040.sh --expected-account-id ACCOUNT_ID [--apply]

The default mode verifies migration state without applying SQL. This tool is
pinned to us-east-2 and permits only migrations 020b and 035-040.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-account-id)
      [[ $# -ge 2 ]] || { echo 'Missing value for --expected-account-id' >&2; exit 2; }
      EXPECTED_ACCOUNT_ID="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$EXPECTED_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || {
  echo '--expected-account-id must be a 12-digit AWS account ID' >&2
  exit 2
}

for tool in aws jq tar gzip base64; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required tool not found: $tool" >&2
    exit 127
  }
done

actual_account_id=$(aws sts get-caller-identity --query Account --output text)
[[ "$actual_account_id" == "$EXPECTED_ACCOUNT_ID" ]] || {
  echo "EXPECTED_ACCOUNT_MISMATCH: expected $EXPECTED_ACCOUNT_ID, got $actual_account_id" >&2
  exit 10
}
[[ "$REGION" == 'us-east-2' ]] || {
  echo "UNSUPPORTED_REGION: production upgrade is pinned to us-east-2 (got $REGION)" >&2
  exit 11
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
migration_dir=$(cd -- "$script_dir/../infra/db/migrations" && pwd)
MIGRATION_FILES=(
  '020b_rls_relationship_recursion_prevention.sql'
  '035_job_delete_grants.sql'
  '036_billing_job_limit_enforcement.sql'
  '037_email_outbox.sql'
  '038_rls_relationship_recursion_repair.sql'
  '039_whatsapp_support_cases.sql'
  '040_whatsapp_delivery_status.sql'
)

for file in "${MIGRATION_FILES[@]}"; do
  [[ -f "$migration_dir/$file" ]] || {
    echo "MIGRATION_FILE_MISSING: $migration_dir/$file" >&2
    exit 12
  }
done

echo ">> Account: $actual_account_id"
echo ">> Region:  $REGION"
if [[ "$APPLY" == '1' ]]; then
  echo '>> Mode: APPLY (missing reviewed migrations will be executed)'
else
  echo '>> Mode: VERIFY-ONLY (No migrations were applied)'
fi

bastion_id=$(aws cloudformation describe-stacks \
  --stack-name "$BASTION_STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue | [0]" \
  --output text)
[[ -n "$bastion_id" && "$bastion_id" != 'None' ]] || {
  echo "BASTION_NOT_READY: deploy $BASTION_STACK before running this tool" >&2
  exit 13
}

db_secret_arn=$(aws cloudformation describe-stack-resources \
  --stack-name "$DATABASE_STACK" \
  --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')].PhysicalResourceId | [0]" \
  --output text)
[[ "$db_secret_arn" == arn:aws:secretsmanager:us-east-2:"$EXPECTED_ACCOUNT_ID":secret:* ]] || {
  echo 'DB_SECRET_NOT_FOUND: unable to resolve the jale_admin database secret' >&2
  exit 14
}

local_work_dir=$(mktemp -d '/tmp/jale-prod-upgrade-local-XXXXXX')
cleanup_local() {
  rm -rf -- "$local_work_dir"
}
trap cleanup_local EXIT

bundle_path="$local_work_dir/migrations.tgz"
tar -czf "$bundle_path" -C "$migration_dir" "${MIGRATION_FILES[@]}"
bundle_base64=$(base64 < "$bundle_path" | tr -d '\n')

remote_script=$(cat <<EOF
#!/usr/bin/env bash
set -euo pipefail
REGION='$REGION'
DB_SECRET_ARN='$db_secret_arn'
APPLY='$APPLY'
MIGRATION_ARCHIVE_B64='$bundle_base64'
EOF
)
remote_script+=$(cat <<'EOF'

work_dir=$(mktemp -d '/tmp/jale-prod-upgrade-XXXXXX')
cleanup() {
  unset PGPASSWORD
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

printf '%s' "$MIGRATION_ARCHIVE_B64" | base64 -d > "$work_dir/migrations.tgz"
unset MIGRATION_ARCHIVE_B64
tar -xzf "$work_dir/migrations.tgz" -C "$work_dir"
rm -f -- "$work_dir/migrations.tgz"

secret_json=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --region "$REGION" --query SecretString --output text)
db_host=$(jq -r .host <<<"$secret_json")
db_port=$(jq -r .port <<<"$secret_json")
db_name=$(jq -r '.dbname // "jale"' <<<"$secret_json")
db_user=$(jq -r .username <<<"$secret_json")
export PGPASSWORD
PGPASSWORD=$(jq -r .password <<<"$secret_json")
unset secret_json
PG_CMD=(psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -v ON_ERROR_STOP=1 -X)

sql_truth() {
  local expression="$1"
  "${PG_CMD[@]}" -Atqc "SELECT CASE WHEN (${expression}) THEN '1' ELSE '0' END"
}

baseline_ok=$(sql_truth "
  to_regclass('public.billing_plans') IS NOT NULL
  AND to_regclass('public.billing_operations') IS NOT NULL
  AND to_regclass('public.admin_cases') IS NOT NULL
  AND to_regclass('public.whatsapp_outbox') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_billing')
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_whatsapp')")
if [[ "$baseline_ok" != '1' ]]; then
  echo 'UNSUPPORTED_BASELINE: expected a consistent production schema through migration 034'
  exit 20
fi

state_for_file() {
  local file="$1"
  local present complete
  case "$file" in
    020b_*|038_*)
      present="EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_rls_relationship_reader') OR to_regprocedure('jale_internal.employer_has_applicant_relationship(text,uuid)') IS NOT NULL"
      complete="EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jale_rls_relationship_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) AND (SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname='jale_rls_relationship_reader' OR member.rolname='jale_rls_relationship_reader')=1 AND EXISTS (SELECT 1 FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member JOIN pg_roles grantor ON grantor.oid=membership.grantor WHERE granted.rolname='jale_rls_relationship_reader' AND member.rolname='jale_admin' AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option AND grantor.rolsuper) AND has_column_privilege('jale_rls_relationship_reader','jobs','id','SELECT') AND has_column_privilege('jale_rls_relationship_reader','jobs','employer_id','SELECT') AND has_column_privilege('jale_rls_relationship_reader','job_applications','worker_id','SELECT') AND has_column_privilege('jale_rls_relationship_reader','job_applications','job_id','SELECT') AND NOT has_column_privilege('jale_rls_relationship_reader','jobs','title','SELECT') AND NOT has_column_privilege('jale_rls_relationship_reader','job_applications','status','SELECT') AND NOT has_table_privilege('jale_rls_relationship_reader','jobs','UPDATE') AND NOT has_table_privilege('jale_rls_relationship_reader','job_applications','UPDATE') AND EXISTS (SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace JOIN pg_roles owner ON owner.oid=function.proowner WHERE namespace.nspname='jale_internal' AND function.proname='employer_has_applicant_relationship' AND function.proargtypes='25 2950'::oidvector AND owner.rolname='jale_rls_relationship_reader' AND function.prosecdef AND function.provolatile='s' AND function.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]) AND EXISTS (SELECT 1 FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid=namespace.nspowner WHERE namespace.nspname='jale_internal' AND owner.rolname='jale_rls_relationship_reader') AND NOT EXISTS (SELECT 1 FROM pg_namespace namespace,LATERAL aclexplode(COALESCE(namespace.nspacl,acldefault('n',namespace.nspowner))) acl WHERE namespace.nspname='jale_internal' AND acl.grantee=0 AND acl.privilege_type IN ('USAGE','CREATE')) AND NOT EXISTS (SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace,LATERAL aclexplode(COALESCE(function.proacl,acldefault('f',function.proowner))) acl WHERE namespace.nspname='jale_internal' AND function.proname='employer_has_applicant_relationship' AND function.proargtypes='25 2950'::oidvector AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AND has_schema_privilege('jale_admin','jale_internal','USAGE') AND NOT has_schema_privilege('jale_admin','jale_internal','CREATE') AND has_function_privilege('jale_admin','jale_internal.employer_has_applicant_relationship(text,uuid)','EXECUTE') AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('jobs_employer_select','jobs_employer_insert','jobs_employer_update','applications_worker_select','applications_worker_insert','applications_employer_select','applications_employer_update','jobs_worker_read_active') AND roles=ARRAY['jale_admin']::name[])=8 AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='users' AND policyname='users_employer_applicant_read' AND roles=ARRAY['jale_admin']::name[]) AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('job_applications_relationship_reader','jobs_relationship_reader') AND roles=ARRAY['jale_rls_relationship_reader']::name[])=2"
      ;;
    035_*)
      present="EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname IN ('jobs_employer_delete','worker_documents_employer_delete','job_conversations_employer_delete'))"
      complete="(SELECT count(*) FROM pg_policies WHERE schemaname='public' AND ((tablename='jobs' AND policyname='jobs_employer_delete') OR (tablename='worker_documents' AND policyname='worker_documents_employer_delete') OR (tablename='job_conversations' AND policyname='job_conversations_employer_delete')) AND cmd='DELETE')=3 AND has_table_privilege('jale_admin','public.jobs','DELETE') AND has_table_privilege('jale_admin','public.job_conversations','DELETE') AND has_table_privilege('jale_admin','public.document_upload_tokens','DELETE')"
      ;;
    036_*)
      present="EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jale_billing_job_enforcer') OR EXISTS (SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace WHERE namespace.nspname='jale_billing_internal' AND function.proname='billing_pause_over_limit_jobs' AND function.proargtypes='2950 23'::oidvector)"
      complete="EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jale_billing_job_enforcer' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) AND (SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname='jale_billing_job_enforcer' OR member.rolname='jale_billing_job_enforcer')=1 AND EXISTS (SELECT 1 FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member JOIN pg_roles grantor ON grantor.oid=membership.grantor WHERE granted.rolname='jale_billing_job_enforcer' AND member.rolname='jale_admin' AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option AND grantor.rolsuper) AND EXISTS (SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace JOIN pg_roles function_owner ON function_owner.oid=function.proowner JOIN pg_roles schema_owner ON schema_owner.oid=namespace.nspowner WHERE namespace.nspname='jale_billing_internal' AND function.proname='billing_pause_over_limit_jobs' AND function.proargtypes='2950 23'::oidvector AND function_owner.rolname='jale_billing_job_enforcer' AND schema_owner.rolname='jale_billing_job_enforcer' AND function.prosecdef AND function.provolatile='v' AND function.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND has_function_privilege('jale_billing',function.oid,'EXECUTE') AND NOT has_function_privilege('jale_admin',function.oid,'EXECUTE')) AND has_schema_privilege('jale_billing','jale_billing_internal','USAGE') AND NOT has_schema_privilege('jale_billing','jale_billing_internal','CREATE') AND NOT has_schema_privilege('jale_admin','jale_billing_internal','USAGE') AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('users_billing_job_enforcer_select','users_billing_job_enforcer_lock','jobs_billing_job_enforcer_select','jobs_billing_job_enforcer_update') AND roles=ARRAY['jale_billing_job_enforcer']::name[])=4 AND NOT has_table_privilege('jale_billing','users','SELECT,UPDATE') AND NOT has_table_privilege('jale_billing','jobs','SELECT,UPDATE')"
      ;;
    037_*)
      present="to_regclass('public.email_outbox') IS NOT NULL"
      complete="to_regclass('public.email_outbox') IS NOT NULL AND to_regclass('public.email_outbox_idempotency_unique') IS NOT NULL AND to_regclass('public.email_outbox_sweeper_idx') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_class table_class JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace JOIN pg_roles owner ON owner.oid=table_class.relowner WHERE namespace.nspname='public' AND table_class.relname='email_outbox' AND owner.rolname='jale_admin' AND table_class.relrowsecurity AND table_class.relforcerowsecurity) AND has_table_privilege('jale_billing','public.email_outbox','SELECT,INSERT') AND NOT has_table_privilege('jale_billing','public.email_outbox','UPDATE,DELETE') AND has_table_privilege('jale_admin','public.email_outbox','SELECT,UPDATE') AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='email_outbox' AND policyname IN ('email_outbox_billing_select','email_outbox_billing_insert','email_outbox_admin_select','email_outbox_admin_update'))=4"
      ;;
    039_*)
      present="to_regprocedure('public.create_admin_support_case(uuid,uuid,text,text)') IS NOT NULL"
      complete="EXISTS (SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace JOIN pg_roles owner ON owner.oid=function.proowner WHERE namespace.nspname='public' AND function.proname='create_admin_support_case' AND function.proargtypes='2950 2950 25 25'::oidvector AND owner.rolname='jale_admin' AND function.prosecdef AND function.provolatile='v' AND function.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND has_function_privilege('jale_whatsapp',function.oid,'EXECUTE') AND NOT has_function_privilege('public',function.oid,'EXECUTE'))"
      ;;
    040_*)
      present="EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_outbox' AND column_name IN ('twilio_delivery_status','twilio_error_code','twilio_error_message','twilio_status_updated_at','next_attempt_at')) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jale_twilio_callback')"
      # COMPLETE_040_BEGIN
      complete=$(cat <<'SQL'
(SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='whatsapp_outbox'
    AND column_name IN ('twilio_delivery_status','twilio_error_code',
      'twilio_error_message','twilio_status_updated_at','next_attempt_at'))=5
AND to_regclass('public.idx_whatsapp_outbox_twilio_message_sid') IS NOT NULL
AND to_regclass('public.idx_whatsapp_outbox_job_alert_pending') IS NOT NULL
AND (SELECT count(*) FROM pg_constraint
  WHERE conname IN ('whatsapp_outbox_twilio_delivery_status_check',
    'whatsapp_outbox_twilio_error_code_check',
    'whatsapp_outbox_twilio_error_message_check',
    'whatsapp_outbox_origin_check'))=4
AND EXISTS (SELECT 1 FROM pg_roles
  WHERE rolname='jale_twilio_callback'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
    AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication
    AND NOT rolbypassrls)
AND (SELECT count(*) FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_roles member ON member.oid=membership.member
  WHERE granted.rolname='jale_twilio_callback'
     OR member.rolname='jale_twilio_callback')=1
AND EXISTS (SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_roles member ON member.oid=membership.member
  JOIN pg_roles grantor ON grantor.oid=membership.grantor
  WHERE granted.rolname='jale_twilio_callback'
    AND member.rolname=current_user
    AND membership.admin_option
    AND NOT membership.inherit_option
    AND NOT membership.set_option
    AND grantor.rolsuper)
AND EXISTS (SELECT 1 FROM pg_namespace namespace
  JOIN pg_roles owner ON owner.oid=namespace.nspowner
  WHERE namespace.nspname='jale_twilio_callback'
    AND owner.rolname='jale_twilio_callback'
    AND NOT has_schema_privilege('public',namespace.oid,'USAGE'))
AND NOT has_schema_privilege('jale_twilio_callback','public','CREATE')
AND (SELECT count(*) FROM pg_proc function
  JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
  JOIN pg_roles owner ON owner.oid=function.proowner
  WHERE namespace.nspname='public'
    AND function.proname IN ('record_twilio_status',
      'record_whatsapp_delivery_status','record_admin_whatsapp_delivery')
    AND owner.rolname='jale_twilio_callback'
    AND function.prosecdef
    AND function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])=3
AND NOT EXISTS (SELECT 1 FROM pg_proc function
  JOIN pg_namespace namespace ON namespace.oid=function.pronamespace,
  LATERAL aclexplode(COALESCE(function.proacl,
    acldefault('f',function.proowner))) acl
  WHERE namespace.nspname='public'
    AND function.proname IN ('record_twilio_status',
      'record_whatsapp_delivery_status','record_admin_whatsapp_delivery')
    AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
AND (SELECT count(*) FROM pg_proc function
  JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
  WHERE namespace.nspname='public'
    AND function.proname IN ('record_twilio_status',
      'record_whatsapp_delivery_status','record_admin_whatsapp_delivery')
    AND has_function_privilege('jale_whatsapp',function.oid,'EXECUTE'))=3
AND EXISTS (SELECT 1 FROM pg_proc function
  JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
  JOIN pg_roles owner ON owner.oid=function.proowner
  WHERE namespace.nspname='jale_twilio_callback'
    AND function.proname='record_twilio_delivery_status'
    AND function.proargtypes='25 25 25 25'::oidvector
    AND owner.rolname='jale_twilio_callback'
    AND function.prosecdef
    AND function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    AND NOT has_function_privilege('public',function.oid,'EXECUTE')
    AND has_function_privilege('jale_whatsapp',function.oid,'EXECUTE'))
AND NOT EXISTS (SELECT 1 FROM pg_proc function
  JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
  WHERE namespace.nspname='jale_twilio_callback'
    AND function.proname IN ('record_whatsapp_delivery_status',
      'record_twilio_status','record_admin_whatsapp_delivery')
    AND (NOT function.prosecdef
      OR NOT function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']))
AND (SELECT count(*) FROM pg_policies
  WHERE schemaname='public'
    AND policyname IN ('whatsapp_outbox_twilio_callback_select',
      'whatsapp_outbox_twilio_callback_update',
      'admin_cases_twilio_callback_select',
      'admin_cases_twilio_callback_update',
      'admin_case_events_twilio_callback_insert',
      'job_messages_twilio_callback_select',
      'job_messages_twilio_callback_update')
    AND roles=ARRAY['jale_twilio_callback']::name[])=7
AND NOT has_table_privilege('jale_twilio_callback',
  'public.job_conversation_messages','SELECT')
AND has_column_privilege('jale_twilio_callback',
  'public.job_conversation_messages','twilio_message_sid','SELECT')
AND to_regprocedure(
  'public.record_twilio_delivery_status(text,text,text,text)') IS NULL
SQL
)
      # COMPLETE_040_END
      ;;
    *)
      echo "UNAPPROVED_MIGRATION: $file" >&2
      return 21
      ;;
  esac

  local any_state complete_state
  any_state=$(sql_truth "$present")
  complete_state=$(sql_truth "$complete")
  if [[ "$complete_state" == '1' ]]; then
    echo complete
  elif [[ "$any_state" == '1' ]]; then
    echo partial
  else
    echo absent
  fi
}

MIGRATION_FILES=(
  '020b_rls_relationship_recursion_prevention.sql'
  '035_job_delete_grants.sql'
  '036_billing_job_limit_enforcement.sql'
  '037_email_outbox.sql'
  '038_rls_relationship_recursion_repair.sql'
  '039_whatsapp_support_cases.sql'
  '040_whatsapp_delivery_status.sql'
)

missing=0
for file in "${MIGRATION_FILES[@]}"; do
  [[ -f "$work_dir/$file" ]] || { echo "MIGRATION_FILE_MISSING: $file"; exit 24; }
  state=$(state_for_file "$file")
  case "$state" in
    complete)
      echo "VERIFIED: $file"
      ;;
    partial)
      echo "PARTIAL_STATE: $file has some but not all reviewed invariants"
      exit 22
      ;;
    absent)
      if [[ "$APPLY" != '1' ]]; then
        echo "PENDING: $file"
        missing=$((missing + 1))
        continue
      fi
      echo "APPLY: $file"
      "${PG_CMD[@]}" -f "$work_dir/$file"
      if [[ "$(state_for_file "$file")" != 'complete' ]]; then
        echo "POSTFLIGHT_FAILED: $file"
        exit 23
      fi
      echo "APPLIED_AND_VERIFIED: $file"
      ;;
  esac
done

if [[ "$APPLY" != '1' ]]; then
  echo "VERIFY-ONLY: ${missing} reviewed migration state(s) pending. No migrations were applied."
else
  echo 'POSTFLIGHT_OK: production schema satisfies 020b and 035-040 invariants'
fi
EOF
)

params_path="$local_work_dir/parameters.json"
jq -n \
  --arg command "$remote_script" \
  --arg execution_timeout "$REMOTE_EXECUTION_TIMEOUT_SECONDS" \
  '{commands: [$command], executionTimeout: [$execution_timeout]}' > "$params_path"
comment='Jale production DB upgrade verification only'
if [[ "$APPLY" == '1' ]]; then
  comment='Jale scoped production DB upgrade 020b/035-040'
fi

command_id=$(aws ssm send-command \
  --region "$REGION" \
  --document-name 'AWS-RunShellScript' \
  --instance-ids "$bastion_id" \
  --comment "$comment" \
  --timeout-seconds "$DELIVERY_TIMEOUT_SECONDS" \
  --parameters "file://$params_path" \
  --query 'Command.CommandId' \
  --output text)
[[ -n "$command_id" && "$command_id" != 'None' ]] || {
  echo 'SSM_COMMAND_SUBMIT_FAILED' >&2
  exit 15
}

echo ">> SSM CommandId: $command_id"
command_succeeded=0
for ((poll = 1; poll <= MAX_POLLS; poll++)); do
  sleep 5
  status=$(aws ssm list-command-invocations \
    --region "$REGION" \
    --command-id "$command_id" \
    --details \
    --query 'CommandInvocations[0].Status' \
    --output text 2>/dev/null || true)
  case "$status" in
    Success)
      command_succeeded=1
      break
      ;;
    Failed|Cancelled|TimedOut|DeliveryTimedOut|ExecutionTimedOut|Undeliverable|Terminated)
      aws ssm list-command-invocations \
        --region "$REGION" \
        --command-id "$command_id" \
        --details \
        --query 'CommandInvocations[0].CommandPlugins[0].{Status:Status,Output:Output}' \
        --output json
      echo "SSM_COMMAND_FAILED: $status" >&2
      exit 16
      ;;
  esac
done
if [[ "$command_succeeded" != '1' ]]; then
  echo "SSM_COMMAND_POLL_TIMEOUT: command $command_id did not finish within $((MAX_POLLS * 5)) seconds" >&2
  exit 17
fi

aws ssm list-command-invocations \
  --region "$REGION" \
  --command-id "$command_id" \
  --details \
  --query 'CommandInvocations[0].CommandPlugins[0].Output' \
  --output text
if [[ "$APPLY" == '1' ]]; then
  echo '>> APPLY and postflight verification complete.'
else
  echo '>> VERIFY-ONLY complete. No migrations were applied.'
fi
