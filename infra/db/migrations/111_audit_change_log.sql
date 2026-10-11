-- ============================================================
-- 111_audit_change_log.sql
-- Run manually AFTER 110_admin_audit_log_freeze.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, audit records, part 3 of 4. Change records for the sensitive tables: every statement
-- that writes a covered column leaves one row in jale_audit.changes, written
-- by the database itself.
--
-- (1) jale_audit.capture_change() is one generic statement-level trigger
--     function, a definer owned by jale_audit_owner with a pinned
--     search_path. Each covered table passes four arguments: the uuid key
--     kept in record_ids ('' when a row has no single id), the primary-key
--     columns that pair a row's old and new versions, the subject columns
--     kept in subject_user_ids, and the covered columns. A record holds:
--       - the table, the operation and the number of rows whose covered
--         columns changed;
--       - the covered columns that changed (IS DISTINCT FROM on their text
--         form), in the file's order: for an insert, those that hold a
--         value; for a delete, those that held one; for an update, those
--         that differ between a row's old and new versions, where a row
--         whose primary key changed is compared with no row;
--       - the keys and subjects of those rows (from both versions of an
--         updated row), NULL when there are more than 100;
--       - the login (session_user), never the function owner;
--       - the audit context: the five transaction-local app.audit_*
--         settings, recorded as 'set' when they are valid, 'unset' when all
--         are empty, and 'invalid' (with no field kept) otherwise.
--     No record is written when no covered column changed, so an update of
--     other columns, an upsert that changed nothing and an empty statement
--     leave none. A truncate leaves one record naming every covered column,
--     with row count 0 and no ids. Reading the context never raises, so a
--     missing or malformed context never fails a write.
--
-- (2) The triggers. Four per covered table: AFTER INSERT, UPDATE and DELETE
--     per statement with transition tables, and AFTER TRUNCATE. The block
--     between the GENERATED markers is rendered from
--     infra/db/access/audit-change-log.json, which also lists every column
--     left out with its reason; the migrations suite checks that the two
--     agree. The migration login is given EXECUTE on the function only for
--     as long as it takes to create them.
--
-- DEPLOY ORDER: apply after 110 and BEFORE the release deploy. The deployed
-- code keeps working unchanged: it sets no context yet, so its writes are
-- recorded under their login alone, as 'unset'.
--
-- REPLAY. Refused with a clear message once jale_audit.capture_change
-- exists.
-- ============================================================
BEGIN;

-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on each covered table;
-- never queue behind a stuck transaction. A timed-out apply writes no ledger
-- row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF pg_catalog.to_regclass('jale_audit.changes') IS NULL THEN
    RAISE EXCEPTION 'migration 111: apply the audit storage (109) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'jale_audit' AND p.proname = 'capture_change') THEN
    RAISE EXCEPTION 'migration 111: already applied (jale_audit.capture_change exists); it is not re-runnable';
  END IF;
  -- Section 2 grants the migration login EXECUTE by its session name.
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 111: connect as the migration login itself, without SET ROLE';
  END IF;
END;
$$;

-- ── 1. Open the SET window ──────────────────────────────────
DO $$
BEGIN
  EXECUTE format('GRANT jale_audit_owner TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END;
$$;

SET LOCAL ROLE jale_audit_owner;

-- ── 2. capture_change() ─────────────────────────────────────
CREATE FUNCTION jale_audit.capture_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_op       TEXT := lower(TG_OP);
  v_key      TEXT;
  v_match    TEXT[];
  v_subject  TEXT[];
  v_columns  TEXT[];
  v_diffs    TEXT[] := '{}';
  v_ids      TEXT[] := '{}';
  v_subjects TEXT[] := '{}';
  v_from     TEXT;
  v_counted  TEXT;
  v_sql      TEXT;
  v_flags    BOOLEAN[];
  v_fields   TEXT[];
  v_count    INTEGER;
  v_record_ids UUID[];
  v_subject_ids UUID[];
  v_kind     TEXT;
  v_actor    TEXT;
  v_actor_id UUID;
  v_channel  TEXT;
  v_surface  TEXT;
  v_request  TEXT;
  v_status   TEXT;
  col        TEXT;
BEGIN
  IF TG_LEVEL <> 'STATEMENT' OR TG_WHEN <> 'AFTER' OR TG_NARGS <> 4 THEN
    RAISE EXCEPTION 'capture_change: bound to %.% with the wrong timing or arguments', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '39P01';
  END IF;
  v_key     := NULLIF(TG_ARGV[0], '');
  v_match   := string_to_array(TG_ARGV[1], ',');
  v_subject := string_to_array(TG_ARGV[2], ',');
  v_columns := string_to_array(TG_ARGV[3], ',');

  IF v_op = 'truncate' THEN
    -- The statement reports no rows: every covered column, count 0, no ids.
    v_fields := v_columns;
    v_count := 0;
  ELSE
    -- One expression per covered column, true when the row changed it.
    FOREACH col IN ARRAY v_columns LOOP
      v_diffs := v_diffs || CASE v_op
        WHEN 'insert' THEN format('(n.%I IS NOT NULL)', col)
        WHEN 'delete' THEN format('(o.%I IS NOT NULL)', col)
        ELSE format('(o.%1$I::text IS DISTINCT FROM n.%1$I::text)', col)
      END;
    END LOOP;
    IF v_key IS NOT NULL THEN
      v_ids := CASE v_op WHEN 'insert' THEN ARRAY[format('n.%I', v_key)]
                         WHEN 'delete' THEN ARRAY[format('o.%I', v_key)]
                         ELSE ARRAY[format('o.%I', v_key), format('n.%I', v_key)] END;
    END IF;
    FOREACH col IN ARRAY v_subject LOOP
      v_subjects := v_subjects || CASE v_op WHEN 'insert' THEN ARRAY[format('n.%I', col)]
                                            WHEN 'delete' THEN ARRAY[format('o.%I', col)]
                                            ELSE ARRAY[format('o.%I', col), format('n.%I', col)] END;
    END LOOP;
    IF v_op = 'insert' THEN
      v_from := 'new_rows n';
      v_counted := 'true';
    ELSIF v_op = 'delete' THEN
      v_from := 'old_rows o';
      v_counted := 'true';
    ELSE
      -- Old and new versions pair on the primary key; a row whose key
      -- changed pairs with nothing, and only its new version is counted.
      v_from := 'old_rows o FULL JOIN new_rows n ON '
        || (SELECT string_agg(format('o.%1$I = n.%1$I', m), ' AND ' ORDER BY i)
              FROM unnest(v_match) WITH ORDINALITY AS u(m, i));
      v_counted := format('(n.%I IS NOT NULL)', v_match[1]);
    END IF;

    v_sql := format(
      'WITH r AS (SELECT %1$s AS counted, ARRAY[%2$s]::uuid[] AS ids, ARRAY[%3$s]::uuid[] AS subjects, ARRAY[%4$s] AS diffs FROM %5$s),'
      ' changed AS (SELECT * FROM r WHERE true = ANY (r.diffs))'
      ' SELECT ARRAY(SELECT bool_or(c.diffs[i]) FROM changed c, generate_series(1, %6$s) i GROUP BY i ORDER BY i),'
      ' (SELECT count(*) FROM changed WHERE counted)::int,'
      ' ARRAY(SELECT DISTINCT v FROM changed, unnest(changed.ids) v WHERE v IS NOT NULL ORDER BY v LIMIT 101),'
      ' ARRAY(SELECT DISTINCT v FROM changed, unnest(changed.subjects) v WHERE v IS NOT NULL ORDER BY v LIMIT 101)',
      v_counted, array_to_string(v_ids, ', '), array_to_string(v_subjects, ', '), array_to_string(v_diffs, ', '),
      v_from, cardinality(v_columns));
    EXECUTE v_sql INTO v_flags, v_count, v_record_ids, v_subject_ids;

    v_fields := ARRAY(SELECT v_columns[i] FROM generate_subscripts(v_columns, 1) AS i
                       WHERE v_flags[i] IS TRUE ORDER BY i);
    IF cardinality(v_fields) = 0 THEN
      RETURN NULL;
    END IF;
    IF v_key IS NULL THEN
      v_record_ids := '{}';
    ELSIF cardinality(v_record_ids) > 100 THEN
      v_record_ids := NULL;
    END IF;
    IF cardinality(v_subject) = 0 THEN
      v_subject_ids := '{}';
    ELSIF cardinality(v_subject_ids) > 100 THEN
      v_subject_ids := NULL;
    END IF;
  END IF;

  -- The audit context: exactly the rule jale_audit.changes checks.
  BEGIN
    v_kind    := NULLIF(current_setting('app.audit_actor_kind', true), '');
    v_actor   := NULLIF(current_setting('app.audit_actor_id', true), '');
    v_channel := NULLIF(current_setting('app.audit_channel', true), '');
    v_surface := NULLIF(current_setting('app.audit_surface', true), '');
    v_request := NULLIF(current_setting('app.audit_request_id', true), '');
    IF v_kind IS NULL AND v_actor IS NULL AND v_channel IS NULL AND v_surface IS NULL AND v_request IS NULL THEN
      v_status := 'unset';
    ELSIF v_kind IN ('worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous')
          AND (v_actor IS NOT NULL) = (v_kind IN ('worker', 'employer', 'admin'))
          AND (v_actor IS NULL
               OR v_actor ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$')
          AND v_channel IN ('web', 'whatsapp', 'admin')
          AND char_length(v_surface) <= 100
          AND v_surface ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'
          AND (v_request IS NULL OR v_request ~ '^[A-Za-z0-9-]{1,64}$') THEN
      v_status := 'set';
      v_actor_id := v_actor::UUID;
    ELSE
      v_status := 'invalid';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_status := 'invalid';
  END;
  IF v_status IS DISTINCT FROM 'set' THEN
    v_status := COALESCE(v_status, 'invalid');
    v_kind := NULL; v_actor_id := NULL; v_channel := NULL; v_surface := NULL; v_request := NULL;
  END IF;

  INSERT INTO jale_audit.changes (
    table_name, operation, row_count, record_ids, subject_user_ids, changed_fields,
    actor_kind, actor_id, channel, surface, request_id, context_status
  ) VALUES (
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_op, v_count,
    CASE WHEN v_op = 'truncate' THEN NULL ELSE v_record_ids END,
    CASE WHEN v_op = 'truncate' THEN NULL ELSE v_subject_ids END,
    v_fields, v_kind, v_actor_id, v_channel, v_surface, v_request, v_status
  );
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.capture_change() FROM PUBLIC;

-- CREATE TRIGGER needs EXECUTE on the function; the migration login holds it
-- until the triggers exist (section 4 takes it back).
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION jale_audit.capture_change() TO %I', session_user);
END;
$$;

RESET ROLE;

-- ── 3. The triggers ─────────────────────────────────────────
-- BEGIN GENERATED: change-record triggers (infra/db/access/audit-change-log.json)
CREATE TRIGGER admin_cases_audit_change_insert AFTER INSERT ON public.admin_cases
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id,employer_id', 'case_type,status,priority,user_id,conversation_id,job_id,employer_id,assigned_admin_id,summary,details');
CREATE TRIGGER admin_cases_audit_change_update AFTER UPDATE ON public.admin_cases
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id,employer_id', 'case_type,status,priority,user_id,conversation_id,job_id,employer_id,assigned_admin_id,summary,details');
CREATE TRIGGER admin_cases_audit_change_delete AFTER DELETE ON public.admin_cases
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id,employer_id', 'case_type,status,priority,user_id,conversation_id,job_id,employer_id,assigned_admin_id,summary,details');
CREATE TRIGGER admin_cases_audit_change_truncate AFTER TRUNCATE ON public.admin_cases
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id,employer_id', 'case_type,status,priority,user_id,conversation_id,job_id,employer_id,assigned_admin_id,summary,details');
CREATE TRIGGER admin_users_audit_change_insert AFTER INSERT ON public.admin_users
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', '', 'cognito_sub,admin_email,role,active');
CREATE TRIGGER admin_users_audit_change_update AFTER UPDATE ON public.admin_users
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', '', 'cognito_sub,admin_email,role,active');
CREATE TRIGGER admin_users_audit_change_delete AFTER DELETE ON public.admin_users
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', '', 'cognito_sub,admin_email,role,active');
CREATE TRIGGER admin_users_audit_change_truncate AFTER TRUNCATE ON public.admin_users
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', '', 'cognito_sub,admin_email,role,active');
CREATE TRIGGER billing_customers_audit_change_insert AFTER INSERT ON public.billing_customers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'provider,provider_customer_id,organization_id');
CREATE TRIGGER billing_customers_audit_change_update AFTER UPDATE ON public.billing_customers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'provider,provider_customer_id,organization_id');
CREATE TRIGGER billing_customers_audit_change_delete AFTER DELETE ON public.billing_customers
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'provider,provider_customer_id,organization_id');
CREATE TRIGGER billing_customers_audit_change_truncate AFTER TRUNCATE ON public.billing_customers
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'provider,provider_customer_id,organization_id');
CREATE TRIGGER document_upload_tokens_audit_change_insert AFTER INSERT ON public.document_upload_tokens
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'token_hash', 'worker_id', 'token_hash,job_id,used');
CREATE TRIGGER document_upload_tokens_audit_change_update AFTER UPDATE ON public.document_upload_tokens
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'token_hash', 'worker_id', 'token_hash,job_id,used');
CREATE TRIGGER document_upload_tokens_audit_change_delete AFTER DELETE ON public.document_upload_tokens
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'token_hash', 'worker_id', 'token_hash,job_id,used');
CREATE TRIGGER document_upload_tokens_audit_change_truncate AFTER TRUNCATE ON public.document_upload_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'token_hash', 'worker_id', 'token_hash,job_id,used');
CREATE TRIGGER employer_profiles_audit_change_insert AFTER INSERT ON public.employer_profiles
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'company_name,contact_name,phone,city,service_area,hiring_trades,typical_job_types,company_size,company_description');
CREATE TRIGGER employer_profiles_audit_change_update AFTER UPDATE ON public.employer_profiles
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'company_name,contact_name,phone,city,service_area,hiring_trades,typical_job_types,company_size,company_description');
CREATE TRIGGER employer_profiles_audit_change_delete AFTER DELETE ON public.employer_profiles
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'company_name,contact_name,phone,city,service_area,hiring_trades,typical_job_types,company_size,company_description');
CREATE TRIGGER employer_profiles_audit_change_truncate AFTER TRUNCATE ON public.employer_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'company_name,contact_name,phone,city,service_area,hiring_trades,typical_job_types,company_size,company_description');
CREATE TRIGGER job_applications_audit_change_insert AFTER INSERT ON public.job_applications
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'application_answers,prompt_answers');
CREATE TRIGGER job_applications_audit_change_update AFTER UPDATE ON public.job_applications
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'application_answers,prompt_answers');
CREATE TRIGGER job_applications_audit_change_delete AFTER DELETE ON public.job_applications
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'application_answers,prompt_answers');
CREATE TRIGGER job_applications_audit_change_truncate AFTER TRUNCATE ON public.job_applications
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'application_answers,prompt_answers');
CREATE TRIGGER subscriptions_audit_change_insert AFTER INSERT ON public.subscriptions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,provider_subscription_id,organization_id');
CREATE TRIGGER subscriptions_audit_change_update AFTER UPDATE ON public.subscriptions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,provider_subscription_id,organization_id');
CREATE TRIGGER subscriptions_audit_change_delete AFTER DELETE ON public.subscriptions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,provider_subscription_id,organization_id');
CREATE TRIGGER subscriptions_audit_change_truncate AFTER TRUNCATE ON public.subscriptions
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,provider_subscription_id,organization_id');
CREATE TRIGGER users_audit_change_insert AFTER INSERT ON public.users
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'id', 'cognito_sub,user_type,email,phone,full_name,whatsapp_number');
CREATE TRIGGER users_audit_change_update AFTER UPDATE ON public.users
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'id', 'cognito_sub,user_type,email,phone,full_name,whatsapp_number');
CREATE TRIGGER users_audit_change_delete AFTER DELETE ON public.users
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'id', 'cognito_sub,user_type,email,phone,full_name,whatsapp_number');
CREATE TRIGGER users_audit_change_truncate AFTER TRUNCATE ON public.users
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'id', 'cognito_sub,user_type,email,phone,full_name,whatsapp_number');
CREATE TRIGGER worker_application_defaults_audit_change_insert AFTER INSERT ON public.worker_application_defaults
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('worker_id', 'worker_id', 'worker_id', 'answers');
CREATE TRIGGER worker_application_defaults_audit_change_update AFTER UPDATE ON public.worker_application_defaults
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('worker_id', 'worker_id', 'worker_id', 'answers');
CREATE TRIGGER worker_application_defaults_audit_change_delete AFTER DELETE ON public.worker_application_defaults
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('worker_id', 'worker_id', 'worker_id', 'answers');
CREATE TRIGGER worker_application_defaults_audit_change_truncate AFTER TRUNCATE ON public.worker_application_defaults
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('worker_id', 'worker_id', 'worker_id', 'answers');
CREATE TRIGGER worker_documents_audit_change_insert AFTER INSERT ON public.worker_documents
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'job_id,doc_type,s3_key,file_name,file_size,mime_type,s3_version_id,cert_name');
CREATE TRIGGER worker_documents_audit_change_update AFTER UPDATE ON public.worker_documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'job_id,doc_type,s3_key,file_name,file_size,mime_type,s3_version_id,cert_name');
CREATE TRIGGER worker_documents_audit_change_delete AFTER DELETE ON public.worker_documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'job_id,doc_type,s3_key,file_name,file_size,mime_type,s3_version_id,cert_name');
CREATE TRIGGER worker_documents_audit_change_truncate AFTER TRUNCATE ON public.worker_documents
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'job_id,doc_type,s3_key,file_name,file_size,mime_type,s3_version_id,cert_name');
CREATE TRIGGER worker_post_media_audit_change_insert AFTER INSERT ON public.worker_post_media
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'post_id,s3_key,s3_version_id,sort_order,content_type,file_size,moderation_status');
CREATE TRIGGER worker_post_media_audit_change_update AFTER UPDATE ON public.worker_post_media
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'post_id,s3_key,s3_version_id,sort_order,content_type,file_size,moderation_status');
CREATE TRIGGER worker_post_media_audit_change_delete AFTER DELETE ON public.worker_post_media
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'post_id,s3_key,s3_version_id,sort_order,content_type,file_size,moderation_status');
CREATE TRIGGER worker_post_media_audit_change_truncate AFTER TRUNCATE ON public.worker_post_media
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'post_id,s3_key,s3_version_id,sort_order,content_type,file_size,moderation_status');
CREATE TRIGGER worker_posts_audit_change_insert AFTER INSERT ON public.worker_posts
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'worker_id,caption,source,status');
CREATE TRIGGER worker_posts_audit_change_update AFTER UPDATE ON public.worker_posts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'worker_id,caption,source,status');
CREATE TRIGGER worker_posts_audit_change_delete AFTER DELETE ON public.worker_posts
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'worker_id,caption,source,status');
CREATE TRIGGER worker_posts_audit_change_truncate AFTER TRUNCATE ON public.worker_posts
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'worker_id', 'worker_id,caption,source,status');
CREATE TRIGGER worker_preferred_cities_audit_change_insert AFTER INSERT ON public.worker_preferred_cities
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'user_id,city_key', 'user_id', 'city_key,city,state,latitude,longitude');
CREATE TRIGGER worker_preferred_cities_audit_change_update AFTER UPDATE ON public.worker_preferred_cities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'user_id,city_key', 'user_id', 'city_key,city,state,latitude,longitude');
CREATE TRIGGER worker_preferred_cities_audit_change_delete AFTER DELETE ON public.worker_preferred_cities
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'user_id,city_key', 'user_id', 'city_key,city,state,latitude,longitude');
CREATE TRIGGER worker_preferred_cities_audit_change_truncate AFTER TRUNCATE ON public.worker_preferred_cities
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'user_id,city_key', 'user_id', 'city_key,city,state,latitude,longitude');
CREATE TRIGGER worker_profile_media_audit_change_insert AFTER INSERT ON public.worker_profile_media
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,media_type,s3_key,twilio_media_sid,content_type');
CREATE TRIGGER worker_profile_media_audit_change_update AFTER UPDATE ON public.worker_profile_media
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,media_type,s3_key,twilio_media_sid,content_type');
CREATE TRIGGER worker_profile_media_audit_change_delete AFTER DELETE ON public.worker_profile_media
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,media_type,s3_key,twilio_media_sid,content_type');
CREATE TRIGGER worker_profile_media_audit_change_truncate AFTER TRUNCATE ON public.worker_profile_media
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('id', 'id', 'user_id', 'user_id,media_type,s3_key,twilio_media_sid,content_type');
CREATE TRIGGER worker_profiles_audit_change_insert AFTER INSERT ON public.worker_profiles
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'full_name,phone,availability,years_experience,location,bio,latitude,longitude,location_source,location_confidence,experience_months,certifications');
CREATE TRIGGER worker_profiles_audit_change_update AFTER UPDATE ON public.worker_profiles
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'full_name,phone,availability,years_experience,location,bio,latitude,longitude,location_source,location_confidence,experience_months,certifications');
CREATE TRIGGER worker_profiles_audit_change_delete AFTER DELETE ON public.worker_profiles
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'full_name,phone,availability,years_experience,location,bio,latitude,longitude,location_source,location_confidence,experience_months,certifications');
CREATE TRIGGER worker_profiles_audit_change_truncate AFTER TRUNCATE ON public.worker_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('user_id', 'user_id', 'user_id', 'full_name,phone,availability,years_experience,location,bio,latitude,longitude,location_source,location_confidence,experience_months,certifications');
CREATE TRIGGER worker_skills_audit_change_insert AFTER INSERT ON public.worker_skills
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'worker_id,skill', 'worker_id', 'skill');
CREATE TRIGGER worker_skills_audit_change_update AFTER UPDATE ON public.worker_skills
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'worker_id,skill', 'worker_id', 'skill');
CREATE TRIGGER worker_skills_audit_change_delete AFTER DELETE ON public.worker_skills
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'worker_id,skill', 'worker_id', 'skill');
CREATE TRIGGER worker_skills_audit_change_truncate AFTER TRUNCATE ON public.worker_skills
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change('', 'worker_id,skill', 'worker_id', 'skill');
-- END GENERATED: change-record triggers

-- ── 4. Close the window ─────────────────────────────────────
SET LOCAL ROLE jale_audit_owner;
DO $$
BEGIN
  EXECUTE format('REVOKE EXECUTE ON FUNCTION jale_audit.capture_change() FROM %I', session_user);
END;
$$;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT jale_audit_owner TO %I WITH SET FALSE, INHERIT FALSE', current_user);
  EXECUTE format('REVOKE jale_audit_owner FROM %I GRANTED BY %I', current_user, current_user);
END;
$$;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  info RECORD;
  offender TEXT;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer, p.proconfig AS config,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee <> p.proowner) AS shared
    INTO info
    FROM pg_catalog.pg_proc p WHERE p.oid = 'jale_audit.capture_change()'::regprocedure;
  IF info.owner_name IS DISTINCT FROM 'jale_audit_owner' OR info.definer IS DISTINCT FROM true
     OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR info.shared THEN
    RAISE EXCEPTION 'migration 111: capture_change has the wrong owner, security, search_path or grants';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
              WHERE am.roleid = 'jale_audit_owner'::regrole AND (am.set_option OR am.inherit_option)) THEN
    RAISE EXCEPTION 'migration 111: the ownership window is still open';
  END IF;

  -- Every change-record trigger: AFTER, per statement, enabled, with the
  -- transition tables its event needs; four per covered table, one per event.
  SELECT string_agg(t.tgrelid::regclass::TEXT || '.' || t.tgname, ', ' ORDER BY 1) INTO offender
    FROM pg_catalog.pg_trigger t
   WHERE t.tgfoid = 'jale_audit.capture_change()'::regprocedure
     AND NOT (t.tgenabled = 'O' AND t.tgnargs = 4
              AND ((t.tgtype = 4 AND t.tgoldtable IS NULL AND t.tgnewtable = 'new_rows')
                   OR (t.tgtype = 16 AND t.tgoldtable = 'old_rows' AND t.tgnewtable = 'new_rows')
                   OR (t.tgtype = 8 AND t.tgoldtable = 'old_rows' AND t.tgnewtable IS NULL)
                   OR (t.tgtype = 32 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 111: change-record triggers with the wrong shape: %', offender;
  END IF;
  SELECT string_agg(x.tbl, ', ' ORDER BY x.tbl) INTO offender
    FROM (SELECT t.tgrelid::regclass::TEXT AS tbl
            FROM pg_catalog.pg_trigger t
           WHERE t.tgfoid = 'jale_audit.capture_change()'::regprocedure
           GROUP BY t.tgrelid
          HAVING count(*) <> 4 OR count(DISTINCT t.tgtype) <> 4) x;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 111: tables without exactly one change-record trigger per event: %', offender;
  END IF;
  IF (SELECT count(DISTINCT t.tgrelid) FROM pg_catalog.pg_trigger t
       WHERE t.tgfoid = 'jale_audit.capture_change()'::regprocedure) <> 16 THEN
    RAISE EXCEPTION 'migration 111: change-record triggers are not on the 16 covered tables';
  END IF;
END;
$$;

COMMIT;
