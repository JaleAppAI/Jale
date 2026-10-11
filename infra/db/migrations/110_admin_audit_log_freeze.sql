-- ============================================================
-- 110_admin_audit_log_freeze.sql
-- Run manually AFTER 109_audit_storage.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, audit records, part 2 of 4. Removes free-text copies from the dashboard's action
-- records before they become append-only, and makes them an export stream.
--
-- (1) One transform, shared. jale_audit.scrub_legacy_metadata(metadata,
--     actor_role, action, target_type) returns the metadata a record keeps:
--       - the note is removed;
--       - the summary is replaced by a neutral one built from the role, the
--         action and the target type only;
--       - in the justification, value-shaped spans (phone numbers, email
--         addresses, links) become [removed];
--       - counts and flags are kept, under plain key names;
--       - any other text, list or object is dropped;
--       - metadata that is not a JSON object becomes the summary alone.
--     The one-time scrub below and the insert trigger both call it, so old
--     and new records can never differ. jale_audit.redact_value_spans is the
--     span rule on its own; the audit suites test it against the shared
--     sample table that the export scan uses.
--
-- (2) Ownership. The table moves to jale_audit_owner. The admin console
--     keeps its SELECT and INSERT and every policy stays; the previous
--     owner's rights pass to the new owner, as a re-own does. The owner gets
--     two policies of its own: read every record (for the export, the access
--     history and the dashboard tile), and delete one only under the
--     retention purge flag.
--
-- (3) Columns. xact (the writing transaction) and seq (an identity, numbered
--     in created_at order for the records already there) make the records
--     the export stream admin_actions_legacy: its windows, holds and purge.
--
-- (4) The one-time scrub, which prints counts only. A record without an
--     admin id gets the id of the one admin account whose email matches its
--     stored email, compared case-insensitively (jale_audit.legacy_admin_id);
--     no match, or several, leaves it empty.
--
-- (5) An insert trigger applies the same transform and the same admin id
--     rule to every new record, and stamps its xact. It never makes an insert
--     fail: when the transform cannot run, the record keeps empty metadata,
--     and when the lookup cannot run, the id stays empty. The export line
--     carries the stored id only, so a line never changes once written.
--
-- (6) The guard (109) is bound: no UPDATE, DELETE or TRUNCATE except the
--     retention purge.
--
-- DEPLOY ORDER: apply after 109 and BEFORE the release deploy. The deployed
-- console keeps inserting (its records are scrubbed on the way in) and
-- reading, and its /audit page still finds a summary on every record.
--
-- REPLAY. Refused with a clear message once admin_audit_log has xact.
-- ============================================================
BEGIN;

-- The re-own and the column changes take an ACCESS EXCLUSIVE lock on a small
-- table; never queue behind a stuck transaction.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'jale_audit' AND p.proname = 'reject_change') THEN
    RAISE EXCEPTION 'migration 110: apply the audit storage (109) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = 'public.admin_audit_log'::regclass AND a.attname = 'xact' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'migration 110: already applied (admin_audit_log.xact exists); it is not re-runnable';
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
       WHERE c.oid = 'public.admin_audit_log'::regclass) IS DISTINCT FROM current_user::TEXT THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log must be owned by the migration login';
  END IF;
END;
$$;

-- ── 1. Open the SET window; CREATE on public for the re-own ──
-- ALTER ... OWNER TO needs the new owner to hold CREATE on the schema, and
-- the identity sequence and the indexes below are created in it. Section 5
-- takes both back.
DO $$
BEGIN
  EXECUTE format('GRANT jale_audit_owner TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END;
$$;
GRANT CREATE ON SCHEMA public TO jale_audit_owner;

-- ── 2. The owner ────────────────────────────────────────────
ALTER TABLE public.admin_audit_log OWNER TO jale_audit_owner;

SET LOCAL ROLE jale_audit_owner;

-- ── 3. The shared transform ─────────────────────────────────
-- Value-shaped spans become [removed]: links (http or https), email
-- addresses (a domain with a dot and a letters-only TLD), and phone numbers
-- (+ and 10-15 digits; (ddd) ddd-dddd; ddd-ddd-dddd, ddd.ddd.dddd or
-- ddd ddd dddd between non-word characters). ISO dates, clock times, IP
-- addresses, UUIDs, request ids and long numbers do not match.
CREATE FUNCTION jale_audit.redact_value_spans(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   p_text,
                   'https?://[^[:space:]]*', '[removed]', 'gi'),
                 '[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?![A-Za-z0-9-])', '[removed]', 'g'),
               '\+[0-9]{10,15}(?![0-9])', '[removed]', 'g'),
             '\([0-9]{3}\) ?[0-9]{3}-[0-9]{4}(?![[:alnum:]_])', '[removed]', 'g'),
           '(?<![[:alnum:]_])([0-9]{3}-[0-9]{3}-[0-9]{4}|[0-9]{3}\.[0-9]{3}\.[0-9]{4}|[0-9]{3} [0-9]{3} [0-9]{4})(?![[:alnum:]_])',
           '[removed]', 'g')
$fn$;
REVOKE ALL ON FUNCTION jale_audit.redact_value_spans(text) FROM PUBLIC;

-- '<role> requested <action> for <target type>.', each part reduced to a
-- lower-case code.
CREATE FUNCTION jale_audit.legacy_summary(p_actor_role TEXT, p_action TEXT, p_target_type TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT format('%s requested %s for %s.',
    COALESCE(NULLIF(left(regexp_replace(lower(p_actor_role), '[^a-z0-9_]+', '_', 'g'), 64), ''), 'unknown'),
    COALESCE(NULLIF(left(regexp_replace(lower(p_action), '[^a-z0-9_]+', '_', 'g'), 64), ''), 'unknown'),
    COALESCE(NULLIF(left(regexp_replace(lower(p_target_type), '[^a-z0-9_]+', '_', 'g'), 64), ''), 'unknown'))
$fn$;
REVOKE ALL ON FUNCTION jale_audit.legacy_summary(text, text, text) FROM PUBLIC;

CREATE FUNCTION jale_audit.scrub_legacy_metadata(p_metadata JSONB, p_actor_role TEXT, p_action TEXT, p_target_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_summary TEXT := jale_audit.legacy_summary(p_actor_role, p_action, p_target_type);
  v_result JSONB := '{}'::JSONB;
  v_key TEXT;
  v_value JSONB;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RETURN jsonb_build_object('summary', v_summary);
  END IF;
  FOR v_key, v_value IN SELECT m.key, m.value FROM jsonb_each(p_metadata) m LOOP
    IF v_key IN ('note', 'summary') THEN
      CONTINUE;
    ELSIF v_key = 'justification' THEN
      IF jsonb_typeof(v_value) = 'string' THEN
        v_result := v_result || jsonb_build_object('justification', jale_audit.redact_value_spans(v_value #>> '{}'));
      END IF;
    ELSIF v_key ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$' AND jsonb_typeof(v_value) IN ('number', 'boolean', 'null') THEN
      v_result := v_result || jsonb_build_object(v_key, v_value);
    END IF;
  END LOOP;
  RETURN v_result || jsonb_build_object('summary', v_summary);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.scrub_legacy_metadata(jsonb, text, text, text) FROM PUBLIC;

-- The admin a record names, from its stored email: the id of the one admin
-- account whose email matches case-insensitively, or NULL when none or
-- several do. The one-time fill and the insert trigger both call it.
CREATE FUNCTION jale_audit.legacy_admin_id(p_email TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END
    FROM public.admin_users u
   WHERE lower(u.admin_email) = lower(p_email)
$fn$;
REVOKE ALL ON FUNCTION jale_audit.legacy_admin_id(text) FROM PUBLIC;

-- ── 4. Columns, the one-time scrub, numbering ───────────────
ALTER TABLE public.admin_audit_log
  ADD COLUMN xact XID8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD COLUMN seq BIGINT;

-- The owner reads and rewrites every record once, before the guard exists.
ALTER TABLE public.admin_audit_log NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_rows BIGINT;
  v_notes BIGINT;
  v_summaries BIGINT;
  v_spans BIGINT;
  v_dropped BIGINT;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE jsonb_typeof(l.metadata) = 'object' AND l.metadata ? 'note'),
         count(*) FILTER (WHERE jsonb_typeof(l.metadata) = 'object' AND l.metadata ? 'summary'),
         count(*) FILTER (WHERE jsonb_typeof(l.metadata -> 'justification') = 'string'
                            AND jale_audit.redact_value_spans(l.metadata ->> 'justification')
                                <> l.metadata ->> 'justification'),
         count(*) FILTER (WHERE jsonb_typeof(l.metadata) IS DISTINCT FROM 'object'
                             OR NOT (jale_audit.scrub_legacy_metadata(l.metadata, l.actor_role, l.action, l.target_type)
                                     ?& ARRAY(SELECT k FROM jsonb_object_keys(l.metadata - 'summary' - 'note') k)))
    INTO v_rows, v_notes, v_summaries, v_spans, v_dropped
    FROM public.admin_audit_log l;
  RAISE NOTICE 'migration 110: % dashboard action records; % notes removed; % summaries replaced; % justifications with value-shaped spans; % with other free text dropped',
    v_rows, v_notes, v_summaries, v_spans, v_dropped;
END;
$$;

UPDATE public.admin_audit_log l
   SET metadata = jale_audit.scrub_legacy_metadata(l.metadata, l.actor_role, l.action, l.target_type),
       seq = o.n
  FROM (SELECT x.id, row_number() OVER (ORDER BY x.created_at, x.id) AS n FROM public.admin_audit_log x) o
 WHERE o.id = l.id;

-- Records without an admin id get it from a unique email match. Counts only.
DO $$
DECLARE
  v_filled BIGINT;
  v_left BIGINT;
BEGIN
  UPDATE public.admin_audit_log l
     SET actor_admin_id = jale_audit.legacy_admin_id(l.actor_email)
   WHERE l.actor_admin_id IS NULL
     AND jale_audit.legacy_admin_id(l.actor_email) IS NOT NULL;
  GET DIAGNOSTICS v_filled = ROW_COUNT;
  SELECT count(*) INTO v_left FROM public.admin_audit_log l WHERE l.actor_admin_id IS NULL;
  RAISE NOTICE 'migration 110: % admin ids filled from a unique email match; % records left without an admin id',
    v_filled, v_left;
END;
$$;

-- New records continue after the highest number (still read without row
-- security, so every record counts).
ALTER TABLE public.admin_audit_log
  ALTER COLUMN seq SET NOT NULL,
  ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.admin_audit_log', 'seq'),
                         COALESCE((SELECT max(l.seq) FROM public.admin_audit_log l), 0) + 1, false);
CREATE UNIQUE INDEX admin_audit_log_seq_key ON public.admin_audit_log (seq);
CREATE INDEX admin_audit_log_xact_idx ON public.admin_audit_log (xact);
ALTER TABLE public.admin_audit_log FORCE ROW LEVEL SECURITY;

-- ── 5. The owner's policies, the export line, the triggers ──
CREATE POLICY admin_audit_log_audit_owner_read ON public.admin_audit_log
  FOR SELECT TO jale_audit_owner USING (true);
CREATE POLICY admin_audit_log_audit_owner_purge ON public.admin_audit_log
  FOR DELETE TO jale_audit_owner USING (current_setting('jale_audit.purge', true) = 'on');

-- The canonical export line of one record (109 describes the format). It
-- names the admin by the stored id only and carries no email address, so a
-- line never changes after it is written.
CREATE FUNCTION jale_audit.legacy_line(l public.admin_audit_log)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT json_build_object(
    'seq', l.seq,
    'id', l.id,
    'xact', l.xact::TEXT,
    'created_at', jale_audit.utc_text(l.created_at),
    'actor_admin_id', l.actor_admin_id,
    'actor_role', l.actor_role,
    'action', l.action,
    'target_type', l.target_type,
    'target_id', l.target_id,
    'before_state', l.before_state,
    'after_state', l.after_state,
    'pii_reveal', l.pii_reveal,
    'metadata', l.metadata
  )::TEXT
$fn$;
REVOKE ALL ON FUNCTION jale_audit.legacy_line(public.admin_audit_log) FROM PUBLIC;

-- Scrubs each new record on the way in, fills a missing admin id from a
-- unique email match, and stamps the writing transaction. A definer, so the
-- transform and the lookup run as their owner whoever inserts. It never makes
-- an insert fail.
CREATE FUNCTION jale_audit.scrub_legacy_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  BEGIN
    NEW.metadata := jale_audit.scrub_legacy_metadata(NEW.metadata, NEW.actor_role, NEW.action, NEW.target_type);
  EXCEPTION WHEN OTHERS THEN
    NEW.metadata := '{}'::JSONB;
  END;
  IF NEW.actor_admin_id IS NULL AND NEW.actor_email IS NOT NULL THEN
    BEGIN
      NEW.actor_admin_id := jale_audit.legacy_admin_id(NEW.actor_email);
    EXCEPTION WHEN OTHERS THEN
      NEW.actor_admin_id := NULL;
    END;
  END IF;
  NEW.xact := pg_current_xact_id();
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.scrub_legacy_row() FROM PUBLIC;

CREATE TRIGGER admin_audit_log_scrub BEFORE INSERT ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION jale_audit.scrub_legacy_row();
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON public.admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();

-- Every record now carries the transform's output (read as the owner,
-- through its own policy).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.admin_audit_log l
              WHERE l.metadata IS DISTINCT FROM
                    jale_audit.scrub_legacy_metadata(l.metadata, l.actor_role, l.action, l.target_type)) THEN
    RAISE EXCEPTION 'migration 110: a dashboard action record kept free text';
  END IF;
END;
$$;

RESET ROLE;

-- ── 6. Close the window ─────────────────────────────────────
REVOKE CREATE ON SCHEMA public FROM jale_audit_owner;
DO $$
BEGIN
  EXECUTE format('GRANT jale_audit_owner TO %I WITH SET FALSE, INHERIT FALSE', current_user);
  EXECUTE format('REVOKE jale_audit_owner FROM %I GRANTED BY %I', current_user, current_user);
END;
$$;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  v_table OID := 'public.admin_audit_log'::regclass;
  offender TEXT;
  spec RECORD;
  fn_oid OID;
  info RECORD;
BEGIN
  IF (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = v_table) <> 'jale_audit_owner'
     OR NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_table) THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log must be owned by jale_audit_owner, with row security forced';
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
       WHERE c.oid = pg_catalog.pg_get_serial_sequence('public.admin_audit_log', 'seq')::regclass) <> 'jale_audit_owner' THEN
    RAISE EXCEPTION 'migration 110: the seq identity must belong to jale_audit_owner';
  END IF;

  -- Exactly SELECT and INSERT for the console; nothing for anyone else but
  -- the owner.
  SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ', '
                    ORDER BY pg_catalog.pg_get_userbyid(a.grantee), a.privilege_type)
    INTO offender
    FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.oid = v_table AND a.grantee <> c.relowner;
  IF offender IS DISTINCT FROM 'jale_admin_console:INSERT, jale_admin_console:SELECT' THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log grants are % instead of SELECT and INSERT for the console', offender;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att WHERE att.attrelid = v_table AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log must carry no column grants';
  END IF;

  SELECT string_agg(p.polname, ', ' ORDER BY p.polname) INTO offender
    FROM pg_catalog.pg_policy p WHERE p.polrelid = v_table;
  IF offender IS DISTINCT FROM
     'admin_audit_log_audit_owner_purge, admin_audit_log_audit_owner_read, admin_audit_log_insert, admin_audit_log_select' THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log policies are %', offender;
  END IF;

  SELECT string_agg(t.tgname || ':' || t.tgenabled::TEXT, ', ' ORDER BY t.tgname) INTO offender
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid = v_table AND NOT t.tgisinternal;
  IF offender IS DISTINCT FROM 'admin_audit_log_append_only:O, admin_audit_log_no_truncate:O, admin_audit_log_scrub:O' THEN
    RAISE EXCEPTION 'migration 110: admin_audit_log triggers are %', offender;
  END IF;

  IF pg_catalog.has_schema_privilege('jale_audit_owner', 'public', 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                 WHERE am.roleid = 'jale_audit_owner'::regrole AND (am.set_option OR am.inherit_option)) THEN
    RAISE EXCEPTION 'migration 110: the ownership window is still open';
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_audit.redact_value_spans(text)', false),
      ('jale_audit.legacy_summary(text, text, text)', false),
      ('jale_audit.scrub_legacy_metadata(jsonb, text, text, text)', false),
      ('jale_audit.legacy_admin_id(text)', false),
      ('jale_audit.legacy_line(admin_audit_log)', false),
      ('jale_audit.scrub_legacy_row()', true)
    ) AS t(signature, definer)
  LOOP
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' = spec.signature;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer, p.proconfig AS config,
           EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS shared
      INTO info
      FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM 'jale_audit_owner' OR info.definer IS DISTINCT FROM spec.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR info.shared THEN
      RAISE EXCEPTION 'migration 110: % has the wrong owner, security, search_path or grants', spec.signature;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
