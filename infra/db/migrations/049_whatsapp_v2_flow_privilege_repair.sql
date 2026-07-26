-- 049_whatsapp_v2_flow_privilege_repair.sql
--
-- Repair the column-level privileges required by the canonical WhatsApp v2
-- legal-consent and trust-answer SQL. Keep both tables least-privilege: this
-- migration does not grant table-wide SELECT/INSERT/UPDATE or change RLS.

BEGIN;

GRANT SELECT (privacy_accepted_at)
  ON public.users TO jale_whatsapp;

GRANT SELECT (rubric_version, scoring_model_id)
  ON public.worker_trust_assessments TO jale_whatsapp;
GRANT INSERT (rubric_version, scoring_model_id)
  ON public.worker_trust_assessments TO jale_whatsapp;
GRANT UPDATE (answers, rubric_version, scoring_model_id)
  ON public.worker_trust_assessments TO jale_whatsapp;

DO $migration$
DECLARE
  requirement record;
BEGIN
  FOR requirement IN
    SELECT * FROM (VALUES
      ('public.users', 'privacy_accepted_at', 'SELECT'),
      ('public.worker_trust_assessments', 'rubric_version', 'SELECT'),
      ('public.worker_trust_assessments', 'scoring_model_id', 'SELECT'),
      ('public.worker_trust_assessments', 'rubric_version', 'INSERT'),
      ('public.worker_trust_assessments', 'scoring_model_id', 'INSERT'),
      ('public.worker_trust_assessments', 'answers', 'UPDATE'),
      ('public.worker_trust_assessments', 'rubric_version', 'UPDATE'),
      ('public.worker_trust_assessments', 'scoring_model_id', 'UPDATE')
    ) AS required(table_name, column_name, privilege_name)
  LOOP
    IF NOT has_column_privilege(
      'jale_whatsapp',
      requirement.table_name,
      requirement.column_name,
      requirement.privilege_name
    ) THEN
      RAISE EXCEPTION 'jale_whatsapp missing %.% % privilege',
        requirement.table_name, requirement.column_name, requirement.privilege_name;
    END IF;
  END LOOP;

  IF has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has broad SELECT on users';
  END IF;

  IF has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'SELECT')
     OR has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'INSERT')
     OR has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'UPDATE') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has broad trust-assessment privileges';
  END IF;

  IF (SELECT count(*)
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN ('users', 'worker_trust_assessments')
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity) <> 2 THEN
    RAISE EXCEPTION 'users and worker_trust_assessments must keep enabled and forced RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'worker_trust_assessments'
       AND policyname = 'wta_whatsapp_pending_rows'
       AND roles = ARRAY['jale_whatsapp']::name[]
       AND with_check = '(status = ''pending''::text)'
  ) THEN
    RAISE EXCEPTION 'wta_whatsapp_pending_rows policy invariant failed';
  END IF;
END;
$migration$;

COMMIT;
