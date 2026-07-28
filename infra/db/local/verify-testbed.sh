#!/usr/bin/env bash
#
# verify-testbed.sh — acceptance probes for the WhatsApp v2 PostgreSQL testbed.
#
# Tier A proves the chain applied under the production ownership model.
# Tier B proves the environment can host the 042 suites that Codex C3 and C9 own
# (whatsapp-onboarding-042.integration.test.ts and
# whatsapp-onboarding-concurrency.integration.test.ts). It does not duplicate them.
#
# Tier B reports N/A rather than failing when migration 042 is absent, so this is
# usable against a --ref none (001..041) database.

set -uo pipefail

container="jale-wa-v2-pg"
db="jale"
admin_user="jale_admin"
admin_pass="test-admin-pw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) container="$2"; shift 2 ;;
    --db) db="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

failures=0

q() {
  docker exec -i -e PGPASSWORD="$admin_pass" "$container" \
    psql -tA -U "$admin_user" -d "$db" -c "$1" 2>&1
}

# probe_denied <label> <user> <password> <sql> <expected error substring>
# For assertions whose whole point is that the statement is refused.
probe_denied() {
  local label="$1" user="$2" pass="$3" sql="$4" expected="$5" out
  out="$(docker exec -i -e PGPASSWORD="$pass" "$container" \
    psql -tA -U "$user" -d "$db" -c "$sql" 2>&1)"
  if grep -qF "$expected" <<<"$out"; then
    printf '   PASS  %s\n' "$label"
  else
    printf '   FAIL  %s\n         -> %s\n' "$label" "${out//$'\n'/ }"
    failures=$((failures + 1))
  fi
}

# probe <label> <sql returning a single boolean>
probe() {
  local label="$1" sql="$2" out
  out="$(q "$sql")"
  if [[ "$out" == "t" ]]; then
    printf '   PASS  %s\n' "$label"
  else
    printf '   FAIL  %s\n         -> %s\n' "$label" "${out//$'\n'/ }"
    failures=$((failures + 1))
  fi
}

echo "-- Tier A: production ownership model --"

probe "migration chain applied (users table present)" \
  "SELECT to_regclass('public.users') IS NOT NULL"

# The load-bearing attribute set. rolbypassrls = false is what makes FORCE ROW
# LEVEL SECURITY observable at all; a superuser bootstrap has it true.
probe "jale_admin is a plain non-superuser owner (no bypassrls, has createrole)" \
  "SELECT NOT rolsuper AND NOT rolcreatedb AND rolcreaterole AND NOT rolbypassrls
     FROM pg_roles WHERE rolname = 'jale_admin'"

probe "public schema is owned by jale_admin" \
  "SELECT nspowner = 'jale_admin'::regrole FROM pg_namespace WHERE nspname = 'public'"

# Checks SET-ROLE capability at runtime. pg_has_role(...,'USAGE') would test
# inheritance instead, which is a different thing and would pass for the wrong
# reason. 042 grants itself this membership WITH SET TRUE and must surrender it.
probe_denied "jale_admin cannot SET ROLE jale_twilio_callback" \
  "$admin_user" "$admin_pass" \
  "SET ROLE jale_twilio_callback" \
  'permission denied to set role "jale_twilio_callback"'

echo
echo "-- Tier B: migration 042 environment readiness --"

if [[ "$(q "SELECT to_regclass('public.worker_workflow_runs') IS NOT NULL")" != "t" ]]; then
  echo "   N/A   migration 042 not applied (re-run with --ref feat/wa-v2-integration)"
  echo
  [[ "$failures" -eq 0 ]] && echo ">> Tier A passed; Tier B skipped." || echo ">> $failures probe(s) FAILED."
  exit "$((failures > 0 ? 1 : 0))"
fi

# 1. All eight tables.
probe "all eight 042 tables exist" \
  "SELECT count(*) = 8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN
     ('worker_onboarding_state','worker_workflow_runs','worker_workflow_transitions',
      'worker_identity_challenges','worker_message_intents','worker_domain_outbox',
      'whatsapp_runtime_controls','worker_reset_audit')"

# 2. RLS both enabled and FORCED on all eight.
probe "RLS enabled and FORCED on all eight tables" \
  "SELECT count(*) = 8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
      AND c.relname IN
     ('worker_onboarding_state','worker_workflow_runs','worker_workflow_transitions',
      'worker_identity_challenges','worker_message_intents','worker_domain_outbox',
      'whatsapp_runtime_controls','worker_reset_audit')"

# 3. The four named constraints/indexes later tasks reference by name.
probe "four named constraints/indexes exist" \
  "SELECT count(*) = 4 FROM pg_class WHERE relname IN
     ('worker_workflow_one_active','worker_message_intent_dedupe',
      'worker_domain_outbox_event_key','worker_message_intents_release_sequence_unique')"

# 4. The reason this testbed exists: SECURITY DEFINER functions must be owned by
#    the plain jale_admin owner, with a catalog-only search_path and no PUBLIC
#    execute. Under a superuser bootstrap these would be owned by postgres.
probe "four SECURITY DEFINER functions owned by jale_admin, catalog search_path, no PUBLIC execute" \
  "SELECT count(*) = 4 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('load_worker_pre_auth','save_worker_pre_auth',
                        'bind_verified_identity_and_start_workflow','lease_worker_domain_events')
      AND p.proowner = 'jale_admin'::regrole
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
      AND NOT has_function_privilege('public', p.oid, 'EXECUTE')"

# 5. 042:496/649 grants itself jale_twilio_callback WITH SET TRUE, re-creates the
#    callback under SET LOCAL ROLE, then revokes. Proves the round-trip completed
#    under a non-superuser without changing the function's owner.
probe "twilio callback still owned by jale_twilio_callback and SECURITY DEFINER" \
  "SELECT p.proowner = 'jale_twilio_callback'::regrole AND p.prosecdef
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'jale_twilio_callback'
      AND p.proname = 'record_whatsapp_delivery_status'"

probe "temporary jale_twilio_callback SET membership was surrendered" \
  "SELECT bool_and(NOT m.set_option) FROM pg_auth_members m
    WHERE m.roleid = 'jale_twilio_callback'::regrole
      AND m.member = 'jale_admin'::regrole"

# 7. Column-scoped grants only on the 042 tables. Scoped deliberately: older
#    worker_* tables (worker_profiles, worker_documents, ...) carry legitimate
#    table-level grants from earlier migrations.
probe "no bare table-level grant to jale_whatsapp on any 042 table" \
  "SELECT count(*) = 0 FROM pg_class c, aclexplode(c.relacl) a
    WHERE a.grantee = 'jale_whatsapp'::regrole AND c.relname IN
     ('worker_onboarding_state','worker_workflow_runs','worker_workflow_transitions',
      'worker_identity_challenges','worker_message_intents','worker_domain_outbox',
      'whatsapp_runtime_controls','worker_reset_audit')"

# 8. Onboarding v2 is now hardwired (no runtime kill switch): migration 054
#    removes onboarding_v2_enabled, leaving voice_intake_enabled (051) and
#    deferred_delivery_enabled (042) as the only two rows, both seeded
#    disabled.
probe "voice_intake_enabled + deferred_delivery_enabled seeded and disabled; onboarding_v2_enabled absent" \
  "SELECT (SELECT count(*) FROM whatsapp_runtime_controls
            WHERE control_key IN ('voice_intake_enabled','deferred_delivery_enabled')
              AND NOT enabled AND NOT global_enabled) = 2
      AND NOT EXISTS (SELECT 1 FROM whatsapp_runtime_controls WHERE control_key = 'onboarding_v2_enabled')"

probe "jale_whatsapp has no write grant on whatsapp_runtime_controls" \
  "SELECT NOT has_table_privilege('jale_whatsapp','whatsapp_runtime_controls','INSERT')
      AND NOT has_table_privilege('jale_whatsapp','whatsapp_runtime_controls','UPDATE')
      AND NOT has_table_privilege('jale_whatsapp','whatsapp_runtime_controls','DELETE')"

# 9. The decisive probe. This is the exact statement a superuser bootstrap cannot
#    evaluate: as postgres (rolbypassrls = t) it returns a result set instead of
#    raising. Pre-auth rows are reachable only through the SECURITY DEFINER
#    functions, never by direct table access.
label="direct SELECT on worker_identity_challenges denied to jale_whatsapp"
out="$(docker exec -i -e PGPASSWORD=test-whatsapp-pw "$container" \
  psql -tA -U jale_whatsapp -d "$db" \
  -c "SELECT count(*) FROM worker_identity_challenges" 2>&1)"
if grep -q "permission denied for table worker_identity_challenges" <<<"$out"; then
  printf '   PASS  %s\n' "$label"
else
  printf '   FAIL  %s\n         -> %s\n' "$label" "${out//$'\n'/ }"
  failures=$((failures + 1))
fi

echo
if [[ "$failures" -eq 0 ]]; then
  echo ">> All probes passed."
else
  echo ">> $failures probe(s) FAILED."
fi
exit "$((failures > 0 ? 1 : 0))"
