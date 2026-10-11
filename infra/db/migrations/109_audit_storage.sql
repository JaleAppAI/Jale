-- ============================================================
-- 109_audit_storage.sql
-- Run manually AFTER 108_problem_reports_functions.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, audit records, part 1 of 4:
--   109  append-only audit storage: the owner roles and schemas, the
--        access-event and change-record tables, the guard, the export
--        bookkeeping and functions, and the access history functions (this
--        file);
--   110  removes free-text copies from the dashboard's action records
--        before they become append-only;
--   111  the change-record triggers on the sensitive tables;
--   112  the operator read functions and the personal-login procedures.
--
-- (1) Owners. jale_audit_owner owns schema jale_audit, its tables and its
--     functions; jale_ops_owner owns schema jale_ops and the operator
--     functions. Both are NOLOGIN, NOINHERIT roles that belong to nothing and
--     hold no CREATE on public (082's helper-role block, as 104 transcribes
--     it). jale_admin keeps only the creator's ADMIN-only membership in each:
--     this file opens a SET window to create objects as each owner, and
--     closes it again before it commits.
--
-- (2) The export login. jale_job_audit_export is the archive export job's
--     login, created as 104 creates its job logins: no password, member of
--     nothing, CONNECTION LIMIT 2, CONNECT on this database, USAGE on
--     jale_audit and EXECUTE on the export functions only.
--
-- (3) Storage. jale_audit.events holds access, attempt, session and action
--     events; jale_audit.changes holds one change record per statement on a
--     sensitive table (111 binds the triggers that write it). A record holds
--     identifiers, codes, field names, counts and times only; the one
--     free-text field is an admin's reason for a contact reveal. No role but
--     the owner holds any privilege on an audit table, none has row
--     security, and none has a foreign key: every read and write goes
--     through a function the owner runs, and a foreign-key action would
--     rewrite rows.
--
-- (4) jale_audit.record_event(jsonb) is the one way to add an event. It
--     validates every key against the code lists and rejects anything else
--     with SQLSTATE 22023, naming the key and never the value. It inserts one
--     row and returns its seq. db_login, db_pid, xact and occurred_at always
--     come from the column defaults. EXECUTE: jale_api, jale_whatsapp and
--     jale_admin_console. The small helpers it uses are executable by the
--     owner only.
--
-- (5) The guard. jale_audit.reject_change() refuses every UPDATE, DELETE and
--     TRUNCATE on the audit tables (SQLSTATE 55000), except three narrow
--     paths, each opened by a transaction-local flag that one owner-run
--     function sets around its own statement: the retention purge, the
--     redaction of a held reason, and the export watermark.
--
-- (6) Export. Three streams (events, changes, and the dashboard's frozen
--     action records) are archived in windows chosen by snapshot xmin, so a
--     late commit is never missed. export_rows builds canonical JSON lines;
--     export_commit recomputes a window and records it only when the count,
--     the seq range and the chained digest match; compare_window recomputes a
--     committed window; purge_expired deletes rows past 13 months that are
--     archived. Rows the export job holds back for review stay out of their
--     window; release_hold and redact_and_release (a supervised operation,
--     EXECUTE for jale_admin only) release them into a release batch.
--
-- (7) The access history view: history_search returns the records for one
--     filter and records its own read event in the caller's transaction;
--     reveal_count is the dashboard tile's aggregate. EXECUTE: the admin
--     console. The owner reads admin_users (id, admin_email) through one
--     policy of its own, to show admin email addresses.
--
-- infra/db/access/AUDIT.md documents every signature, code and setting
-- name.
--
-- DEPLOY ORDER: apply after 104-106 and BEFORE the release deploy. The
-- deployed code never calls jale_audit, so it keeps working unchanged.
--
-- REPLAY. Refused with a clear message once jale_audit.events exists. Roles
-- are cluster-wide, so an existing owner role is adopted only when its
-- attributes and memberships are exactly what this file creates.
-- ============================================================
BEGIN;

-- Creating roles, schemas and tables takes only short catalog locks, but
-- never queue behind a stuck transaction: a timed-out apply writes no ledger
-- row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles
       WHERE rolname IN ('jale_api', 'jale_whatsapp', 'jale_admin_console', 'jale_ops_readonly')) <> 4 THEN
    RAISE EXCEPTION 'migration 109: apply the least-privilege logins (104) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'jale_audit' AND c.relname = 'events') THEN
    RAISE EXCEPTION 'migration 109: already applied (jale_audit.events exists); it is not re-runnable';
  END IF;
END;
$$;

-- ── 1. Owner roles ──────────────────────────────────────────
DO $$
DECLARE
  role_name TEXT;
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['jale_audit_owner', 'jale_ops_owner'] LOOP
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', role_name);
      SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = role_name;
    END IF;

    IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
       OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
      RAISE EXCEPTION 'migration 109: existing role % has unsafe attributes', role_name;
    END IF;

    -- An owner belongs to nothing, and its only member is the creator's
    -- ADMIN-only row.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = helper.oid
          OR (am.roleid = helper.oid
              AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
    ) THEN
      RAISE EXCEPTION 'migration 109: existing role % has unsafe memberships', role_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = helper.oid
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', role_name, current_user);
    END IF;
  END LOOP;
END;
$$;

-- ── 1b. The export job's login ──────────────────────────────
-- Created as 104 creates its job logins: no password (credential preparation
-- sets a SCRAM verifier later), member of nothing, CONNECTION LIMIT 2. It
-- reaches jale_audit only, and there only the export functions.
DO $$
DECLARE
  existing pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_audit_export';
  IF NOT FOUND THEN
    CREATE ROLE jale_job_audit_export LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
      CONNECTION LIMIT 2;
  ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolcreatedb OR existing.rolcreaterole
     OR existing.rolreplication OR existing.rolbypassrls OR existing.rolinherit OR existing.rolconnlimit <> 2 THEN
    RAISE EXCEPTION 'migration 109: existing login jale_job_audit_export has unexpected attributes; refusing to adopt it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_audit_export')
  ) THEN
    RAISE EXCEPTION 'migration 109: login jale_job_audit_export must not be a member of any role';
  END IF;
  -- The only membership IN the login is the creator's ADMIN-only row.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_audit_export')
       AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option)
  ) THEN
    RAISE EXCEPTION 'migration 109: role jale_job_audit_export has unsafe memberships';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_audit_export')
       AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND am.admin_option
  ) THEN
    EXECUTE format('GRANT jale_job_audit_export TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', current_user);
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO jale_job_audit_export', current_database());
END;
$$;

-- Like every runtime login, it ends a session left idle inside an open
-- transaction for a minute.
ALTER ROLE jale_job_audit_export SET idle_in_transaction_session_timeout = '60s';

-- ── 2. Open the SET window (082's sequence) ─────────────────
-- CREATE SCHEMA ... AUTHORIZATION and SET ROLE both need the SET option.
-- Section 6 turns it off again and removes the self-granted row.
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['jale_audit_owner', 'jale_ops_owner'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', role_name, current_user);
  END LOOP;
END;
$$;

-- ── 3. Schemas ──────────────────────────────────────────────
CREATE SCHEMA jale_audit AUTHORIZATION jale_audit_owner;
CREATE SCHEMA jale_ops AUTHORIZATION jale_ops_owner;

-- ── 4. jale_ops: closed until 112 adds the operator functions ─
SET LOCAL ROLE jale_ops_owner;
REVOKE ALL ON SCHEMA jale_ops FROM PUBLIC;
-- Functions this owner creates start closed to PUBLIC (104's rule for
-- jale_admin, applied to the owner that creates them).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;

-- ── 5. jale_audit: storage and the event function ───────────
SET LOCAL ROLE jale_audit_owner;
REVOKE ALL ON SCHEMA jale_audit FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Access, attempt, session and action events. The CHECKs repeat
-- record_event's rules, so even a row written some other way could not hold
-- a value the code lists do not allow.
CREATE TABLE jale_audit.events (
  seq              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  xact             XID8        NOT NULL DEFAULT pg_current_xact_id(),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  kind             TEXT        NOT NULL,
  outcome          TEXT        NOT NULL,
  actor_kind       TEXT        NOT NULL,
  actor_id         UUID,
  actor_role       TEXT,
  actor_session    UUID,
  channel          TEXT        NOT NULL,
  surface          TEXT        NOT NULL,
  categories       TEXT[]      NOT NULL,
  subject_user_ids UUID[]      NOT NULL DEFAULT '{}',
  record_type      TEXT,
  record_ids       UUID[]      NOT NULL DEFAULT '{}',
  result_count     INTEGER     NOT NULL,
  field_names      TEXT[]      NOT NULL DEFAULT '{}',
  purpose_kind     TEXT,
  purpose_id       UUID,
  reason           TEXT,
  link_expires_at  TIMESTAMPTZ,
  part             SMALLINT    NOT NULL DEFAULT 1,
  parts            SMALLINT    NOT NULL DEFAULT 1,
  request_id       TEXT,
  db_login         NAME        NOT NULL DEFAULT session_user,
  db_pid           INTEGER     NOT NULL DEFAULT pg_backend_pid(),
  CONSTRAINT events_kind_outcome_check CHECK (
       (kind = 'read'    AND outcome = 'allowed')
    OR (kind = 'attempt' AND outcome IN ('denied', 'not_found', 'failed'))
    OR (kind = 'session' AND outcome IN ('signed_in', 'sign_in_rejected', 'signed_out', 'expired', 'revoked'))
    OR (kind = 'action'  AND outcome = 'done')
  ),
  CONSTRAINT events_actor_check CHECK (
    actor_kind IN ('worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous')
    AND (actor_id IS NOT NULL) = (actor_kind IN ('worker', 'employer', 'admin'))
    AND (CASE WHEN actor_kind = 'admin'
              THEN actor_role IS NOT NULL AND actor_role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')
              ELSE actor_role IS NULL AND actor_session IS NULL END)
  ),
  CONSTRAINT events_channel_check CHECK (channel IN ('web', 'whatsapp', 'admin')),
  CONSTRAINT events_surface_check CHECK (
    char_length(surface) <= 100 AND surface ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'
  ),
  CONSTRAINT events_categories_check CHECK (
    cardinality(categories) BETWEEN 1 AND 8
    AND array_position(categories, NULL) IS NULL
    AND categories <@ ARRAY[
      'application_answers', 'contact_details', 'documents', 'trust_assessments', 'conversations',
      'profile', 'posts', 'saved_application_details', 'cases', 'verifications', 'analytics',
      'billing', 'audit_history', 'problem_reports', 'admin_access'
    ]::TEXT[]
  ),
  CONSTRAINT events_subjects_check CHECK (
    cardinality(subject_user_ids) <= 500 AND array_position(subject_user_ids, NULL) IS NULL
  ),
  CONSTRAINT events_records_check CHECK (
    cardinality(record_ids) <= 500 AND array_position(record_ids, NULL) IS NULL
    AND (record_type IS NULL OR record_type IN (
      'job_application', 'worker_document', 'worker_post', 'job_conversation', 'admin_case',
      'identity_challenge', 'user', 'problem_report', 'admin_user'
    ))
    AND (cardinality(record_ids) = 0 OR record_type IS NOT NULL)
  ),
  CONSTRAINT events_result_count_check CHECK (result_count >= 0),
  CONSTRAINT events_field_names_check CHECK (
    cardinality(field_names) <= 100
    AND array_position(field_names, NULL) IS NULL
    AND array_to_string(field_names, ',') ~ '^([a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*)?$'
  ),
  CONSTRAINT events_purpose_check CHECK (
    (purpose_kind IS NULL OR purpose_kind IN ('job', 'case', 'verification', 'reveal', 'self', 'audit_review'))
    AND (purpose_id IS NOT NULL) = COALESCE(purpose_kind IN ('job', 'case'), false)
  ),
  CONSTRAINT events_reason_check CHECK (
    reason IS NULL
    OR (actor_kind = 'admin' AND purpose_kind = 'reveal' AND char_length(reason) BETWEEN 1 AND 500)
  ),
  CONSTRAINT events_part_check CHECK (part >= 1 AND parts >= 1 AND part <= parts),
  CONSTRAINT events_request_id_check CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9-]{1,64}$')
);

CREATE INDEX events_xact_idx ON jale_audit.events (xact);
CREATE INDEX events_occurred_at_idx ON jale_audit.events (occurred_at);
CREATE INDEX events_actor_idx ON jale_audit.events (actor_id, occurred_at);
CREATE INDEX events_subjects_idx ON jale_audit.events USING gin (subject_user_ids);
CREATE INDEX events_records_idx ON jale_audit.events USING gin (record_ids);

-- One change record per statement per sensitive table. record_ids and
-- subject_user_ids are NULL when a statement touched more than 100.
CREATE TABLE jale_audit.changes (
  seq              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  xact             XID8        NOT NULL DEFAULT pg_current_xact_id(),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  table_name       TEXT        NOT NULL,
  operation        TEXT        NOT NULL,
  row_count        INTEGER     NOT NULL,
  record_ids       UUID[],
  subject_user_ids UUID[],
  changed_fields   TEXT[]      NOT NULL,
  actor_kind       TEXT,
  actor_id         UUID,
  channel          TEXT,
  surface          TEXT,
  request_id       TEXT,
  context_status   TEXT        NOT NULL,
  db_login         NAME        NOT NULL DEFAULT session_user,
  db_pid           INTEGER     NOT NULL DEFAULT pg_backend_pid(),
  CONSTRAINT changes_table_name_check CHECK (table_name ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  CONSTRAINT changes_operation_check CHECK (operation IN ('insert', 'update', 'delete', 'truncate')),
  CONSTRAINT changes_row_count_check CHECK (row_count >= 0),
  CONSTRAINT changes_ids_check CHECK (
    (record_ids IS NULL OR (cardinality(record_ids) <= 100 AND array_position(record_ids, NULL) IS NULL))
    AND (subject_user_ids IS NULL
         OR (cardinality(subject_user_ids) <= 100 AND array_position(subject_user_ids, NULL) IS NULL))
  ),
  CONSTRAINT changes_fields_check CHECK (
    cardinality(changed_fields) BETWEEN 1 AND 200
    AND array_position(changed_fields, NULL) IS NULL
    AND array_to_string(changed_fields, ',') ~ '^[a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*$'
  ),
  CONSTRAINT changes_context_check CHECK (
    CASE WHEN context_status = 'set' THEN
           actor_kind IN ('worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous')
           AND (actor_id IS NOT NULL) = (actor_kind IN ('worker', 'employer', 'admin'))
           AND channel IN ('web', 'whatsapp', 'admin')
           AND char_length(surface) <= 100
           AND surface ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'
           AND (request_id IS NULL OR request_id ~ '^[A-Za-z0-9-]{1,64}$')
         WHEN context_status IN ('unset', 'invalid') THEN
           actor_kind IS NULL AND actor_id IS NULL AND channel IS NULL AND surface IS NULL AND request_id IS NULL
         ELSE false END
  )
);

CREATE INDEX changes_xact_idx ON jale_audit.changes (xact);
CREATE INDEX changes_occurred_at_idx ON jale_audit.changes (occurred_at);
CREATE INDEX changes_actor_idx ON jale_audit.changes (actor_id, occurred_at);
CREATE INDEX changes_subjects_idx ON jale_audit.changes USING gin (subject_user_ids);
CREATE INDEX changes_records_idx ON jale_audit.changes USING gin (record_ids);

-- The dashboard tile counts contact reveals over recent days.
CREATE INDEX events_reveals_idx ON jale_audit.events (occurred_at) WHERE purpose_kind = 'reveal';

-- ── Export bookkeeping ──────────────────────────────────────
-- Three streams leave the database for the archive: events, changes, and the
-- dashboard's frozen action records (admin_actions_legacy; 110 adds the
-- columns they need). A stream's watermark is an xid8: every row whose xact
-- is below it is in a committed window.
CREATE TABLE jale_audit.export_state (
  stream     TEXT        PRIMARY KEY,
  watermark  XID8        NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT export_state_stream_check CHECK (stream IN ('events', 'changes', 'admin_actions_legacy'))
);
INSERT INTO jale_audit.export_state (stream) VALUES ('events'), ('changes'), ('admin_actions_legacy');

-- One row per committed window, and per release batch (held rows exported
-- once they are released). digest = sha256(prev_digest || sha256(object
-- bytes)), chained over the stream's batches that wrote an object.
CREATE TABLE jale_audit.export_batches (
  seq          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream       TEXT        NOT NULL,
  batch_kind   TEXT        NOT NULL,
  from_xact    XID8,
  to_xact      XID8,
  row_count    INTEGER     NOT NULL,
  seq_min      BIGINT,
  seq_max      BIGINT,
  prev_digest  BYTEA,
  digest       BYTEA,
  object_key   TEXT        UNIQUE,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  db_login     NAME        NOT NULL DEFAULT session_user,
  CONSTRAINT export_batches_stream_check CHECK (stream IN ('events', 'changes', 'admin_actions_legacy')),
  CONSTRAINT export_batches_kind_check CHECK (
       (batch_kind = 'window' AND from_xact IS NOT NULL AND to_xact IS NOT NULL AND from_xact < to_xact)
    OR (batch_kind = 'release' AND from_xact IS NULL AND to_xact IS NULL AND row_count > 0)
  ),
  CONSTRAINT export_batches_rows_check CHECK (
    row_count >= 0
    AND (row_count = 0) = (seq_min IS NULL)
    AND (seq_min IS NULL) = (seq_max IS NULL)
    AND (seq_min IS NULL OR seq_min <= seq_max)
    AND (row_count = 0) = (digest IS NULL)
    AND (digest IS NULL) = (object_key IS NULL)
    AND (digest IS NULL OR octet_length(digest) = 32)
    AND (prev_digest IS NULL OR (digest IS NOT NULL AND octet_length(prev_digest) = 32))
  ),
  CONSTRAINT export_batches_object_key_check CHECK (
    object_key IS NULL
    OR (char_length(object_key) <= 512
        AND object_key ~ '^db/(events|changes|admin_actions_legacy)/([A-Za-z0-9=_-][A-Za-z0-9=._-]*/)*[A-Za-z0-9=_-][A-Za-z0-9=._-]*\.jsonl\.gz$'
        AND split_part(object_key, '/', 2) = stream)
  )
);
CREATE INDEX export_batches_stream_idx ON jale_audit.export_batches (stream, seq);

-- The review trail of each row the export job held back: held at its
-- window's commit, released by a supervised operation, then exported in a
-- release batch. Each step is a new row, at most one of each per row.
CREATE TABLE jale_audit.export_holds (
  seq         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream      TEXT        NOT NULL,
  row_seq     BIGINT      NOT NULL,
  action      TEXT        NOT NULL,
  batch_seq   BIGINT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  db_login    NAME        NOT NULL DEFAULT session_user,
  CONSTRAINT export_holds_stream_check CHECK (stream IN ('events', 'changes', 'admin_actions_legacy')),
  CONSTRAINT export_holds_action_check CHECK (
    action IN ('hold', 'release', 'export') AND (batch_seq IS NULL) = (action = 'release')
  ),
  CONSTRAINT export_holds_once UNIQUE (stream, row_seq, action)
);
CREATE INDEX export_holds_batch_idx ON jale_audit.export_holds (batch_seq) WHERE batch_seq IS NOT NULL;

-- ── json_* helpers: one rule each, shared by the jale_audit functions ──
-- Each returns NULL (or an empty array) for an absent key or a JSON null,
-- and raises 22023 '<context>: invalid <key>' for anything else it cannot
-- accept. The message names the key, never the value.
CREATE FUNCTION jale_audit.json_text(p_doc JSONB, p_key TEXT, p_context TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v JSONB := p_doc -> p_key;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  RETURN v #>> '{}';
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_text(jsonb, text, text) FROM PUBLIC;

CREATE FUNCTION jale_audit.json_uuid(p_doc JSONB, p_key TEXT, p_context TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v TEXT := jale_audit.json_text(p_doc, p_key, p_context);
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  RETURN v::UUID;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_uuid(jsonb, text, text) FROM PUBLIC;

CREATE FUNCTION jale_audit.json_uuid_list(p_doc JSONB, p_key TEXT, p_max INTEGER, p_context TEXT)
RETURNS UUID[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v JSONB := p_doc -> p_key;
  item JSONB;
  result UUID[] := '{}';
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN result;
  END IF;
  -- Nested, not OR'd: PostgreSQL does not promise to evaluate OR operands in
  -- order, and jsonb_array_length raises on a non-array.
  IF jsonb_typeof(v) <> 'array' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v) > p_max THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT jsonb_array_elements(v) LOOP
    IF jsonb_typeof(item) <> 'string'
       OR (item #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
    END IF;
    result := result || (item #>> '{}')::UUID;
  END LOOP;
  RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_uuid_list(jsonb, text, integer, text) FROM PUBLIC;

-- p_pattern is an anchored regular expression every element must match.
CREATE FUNCTION jale_audit.json_text_list(p_doc JSONB, p_key TEXT, p_max INTEGER, p_pattern TEXT, p_context TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v JSONB := p_doc -> p_key;
  item JSONB;
  result TEXT[] := '{}';
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN result;
  END IF;
  -- Nested, not OR'd: PostgreSQL does not promise to evaluate OR operands in
  -- order, and jsonb_array_length raises on a non-array.
  IF jsonb_typeof(v) <> 'array' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v) > p_max THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT jsonb_array_elements(v) LOOP
    IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ p_pattern THEN
      RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
    END IF;
    result := result || (item #>> '{}');
  END LOOP;
  RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_text_list(jsonb, text, integer, text, text) FROM PUBLIC;

-- A JSON number with no fraction or exponent, between p_min and p_max.
CREATE FUNCTION jale_audit.json_integer(p_doc JSONB, p_key TEXT, p_min BIGINT, p_max BIGINT, p_context TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v JSONB := p_doc -> p_key;
  t TEXT;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  END IF;
  t := v #>> '{}';
  -- Each test only runs once the one before it passed, so the cast never
  -- sees a fraction or an exponent.
  IF jsonb_typeof(v) <> 'number' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  IF t !~ '^-?[0-9]{1,18}$' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  IF t::BIGINT NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  RETURN t::BIGINT;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_integer(jsonb, text, bigint, bigint, text) FROM PUBLIC;

-- An ISO-8601 instant with an explicit zone (Z or an offset), as
-- Date.prototype.toISOString() writes it.
CREATE FUNCTION jale_audit.json_timestamptz(p_doc JSONB, p_key TEXT, p_context TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v TEXT := jale_audit.json_text(p_doc, p_key, p_context);
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END IF;
  BEGIN
    RETURN v::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '%: invalid %', p_context, p_key USING ERRCODE = '22023';
  END;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.json_timestamptz(jsonb, text, text) FROM PUBLIC;

-- ── record_event ────────────────────────────────────────────
CREATE FUNCTION jale_audit.record_event(p_event JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_context CONSTANT TEXT := 'record_event';
  c_keys CONSTANT TEXT[] := ARRAY[
    'kind', 'outcome', 'actor_kind', 'actor_id', 'actor_role', 'actor_session', 'channel', 'surface',
    'categories', 'subject_user_ids', 'record_type', 'record_ids', 'result_count', 'field_names',
    'purpose_kind', 'purpose_id', 'reason', 'link_expires_at', 'part', 'parts', 'request_id'
  ];
  c_categories CONSTANT TEXT := '^(application_answers|contact_details|documents|trust_assessments|conversations'
    '|profile|posts|saved_application_details|cases|verifications|analytics|billing|audit_history|problem_reports'
    '|admin_access)$';
  v_key TEXT;
  v_kind TEXT;
  v_outcome TEXT;
  v_actor_kind TEXT;
  v_actor_id UUID;
  v_actor_role TEXT;
  v_actor_session UUID;
  v_channel TEXT;
  v_surface TEXT;
  v_categories TEXT[];
  v_subjects UUID[];
  v_record_type TEXT;
  v_records UUID[];
  v_result_count INTEGER;
  v_field_names TEXT[];
  v_purpose_kind TEXT;
  v_purpose_id UUID;
  v_reason TEXT;
  v_link_expires_at TIMESTAMPTZ;
  v_part SMALLINT;
  v_parts SMALLINT;
  v_request_id TEXT;
  v_seq BIGINT;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object' THEN
    RAISE EXCEPTION 'record_event: the event must be a JSON object' USING ERRCODE = '22023';
  END IF;
  -- seq, event_id, xact, occurred_at, db_login and db_pid are not in the
  -- list: the defaults are the only source of those columns.
  FOR v_key IN SELECT jsonb_object_keys(p_event) LOOP
    IF NOT v_key = ANY (c_keys) THEN
      RAISE EXCEPTION 'record_event: unknown key' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_kind := jale_audit.json_text(p_event, 'kind', c_context);
  IF v_kind IS NULL OR v_kind NOT IN ('read', 'attempt', 'session', 'action') THEN
    RAISE EXCEPTION 'record_event: invalid kind' USING ERRCODE = '22023';
  END IF;

  v_outcome := jale_audit.json_text(p_event, 'outcome', c_context);
  IF v_outcome IS NULL OR NOT (
       (v_kind = 'read'    AND v_outcome = 'allowed')
    OR (v_kind = 'attempt' AND v_outcome IN ('denied', 'not_found', 'failed'))
    OR (v_kind = 'session' AND v_outcome IN ('signed_in', 'sign_in_rejected', 'signed_out', 'expired', 'revoked'))
    OR (v_kind = 'action'  AND v_outcome = 'done')
  ) THEN
    RAISE EXCEPTION 'record_event: invalid outcome' USING ERRCODE = '22023';
  END IF;

  v_actor_kind := jale_audit.json_text(p_event, 'actor_kind', c_context);
  IF v_actor_kind IS NULL
     OR v_actor_kind NOT IN ('worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous') THEN
    RAISE EXCEPTION 'record_event: invalid actor_kind' USING ERRCODE = '22023';
  END IF;

  -- The actor comes from the verified sign-in: a users.id for workers and
  -- employers, an admin_users.id for admins, and nothing for the rest.
  v_actor_id := jale_audit.json_uuid(p_event, 'actor_id', c_context);
  IF (v_actor_id IS NOT NULL) <> (v_actor_kind IN ('worker', 'employer', 'admin')) THEN
    RAISE EXCEPTION 'record_event: invalid actor_id' USING ERRCODE = '22023';
  END IF;

  v_actor_role := jale_audit.json_text(p_event, 'actor_role', c_context);
  IF (v_actor_kind = 'admin' AND (v_actor_role IS NULL
                                  OR v_actor_role NOT IN ('admin_readonly', 'admin_ops', 'admin_superadmin')))
     OR (v_actor_kind <> 'admin' AND v_actor_role IS NOT NULL) THEN
    RAISE EXCEPTION 'record_event: invalid actor_role' USING ERRCODE = '22023';
  END IF;

  v_actor_session := jale_audit.json_uuid(p_event, 'actor_session', c_context);
  IF v_actor_session IS NOT NULL AND v_actor_kind <> 'admin' THEN
    RAISE EXCEPTION 'record_event: invalid actor_session' USING ERRCODE = '22023';
  END IF;

  v_channel := jale_audit.json_text(p_event, 'channel', c_context);
  IF v_channel IS NULL OR v_channel NOT IN ('web', 'whatsapp', 'admin') THEN
    RAISE EXCEPTION 'record_event: invalid channel' USING ERRCODE = '22023';
  END IF;

  v_surface := jale_audit.json_text(p_event, 'surface', c_context);
  IF v_surface IS NULL OR char_length(v_surface) > 100
     OR v_surface !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$' THEN
    RAISE EXCEPTION 'record_event: invalid surface' USING ERRCODE = '22023';
  END IF;

  v_categories := jale_audit.json_text_list(p_event, 'categories', 8, c_categories, c_context);
  IF cardinality(v_categories) = 0 THEN
    RAISE EXCEPTION 'record_event: invalid categories' USING ERRCODE = '22023';
  END IF;

  v_subjects := jale_audit.json_uuid_list(p_event, 'subject_user_ids', 500, c_context);

  v_record_type := jale_audit.json_text(p_event, 'record_type', c_context);
  IF v_record_type IS NOT NULL AND v_record_type NOT IN (
    'job_application', 'worker_document', 'worker_post', 'job_conversation', 'admin_case',
    'identity_challenge', 'user', 'problem_report', 'admin_user'
  ) THEN
    RAISE EXCEPTION 'record_event: invalid record_type' USING ERRCODE = '22023';
  END IF;

  v_records := jale_audit.json_uuid_list(p_event, 'record_ids', 500, c_context);
  IF cardinality(v_records) > 0 AND v_record_type IS NULL THEN
    RAISE EXCEPTION 'record_event: invalid record_type' USING ERRCODE = '22023';
  END IF;

  v_result_count := jale_audit.json_integer(p_event, 'result_count', 0, 2147483647, c_context);
  IF v_result_count IS NULL THEN
    RAISE EXCEPTION 'record_event: invalid result_count' USING ERRCODE = '22023';
  END IF;

  v_field_names := jale_audit.json_text_list(p_event, 'field_names', 100, '^[a-z][a-z0-9_]{0,62}$', c_context);

  v_purpose_kind := jale_audit.json_text(p_event, 'purpose_kind', c_context);
  IF v_purpose_kind IS NOT NULL
     AND v_purpose_kind NOT IN ('job', 'case', 'verification', 'reveal', 'self', 'audit_review') THEN
    RAISE EXCEPTION 'record_event: invalid purpose_kind' USING ERRCODE = '22023';
  END IF;

  -- A job or case purpose names its job or case; no other purpose has an id.
  v_purpose_id := jale_audit.json_uuid(p_event, 'purpose_id', c_context);
  IF (v_purpose_id IS NOT NULL) <> COALESCE(v_purpose_kind IN ('job', 'case'), false) THEN
    RAISE EXCEPTION 'record_event: invalid purpose_id' USING ERRCODE = '22023';
  END IF;

  -- The only free text: an admin's reason for a contact reveal.
  v_reason := jale_audit.json_text(p_event, 'reason', c_context);
  IF v_reason IS NOT NULL
     AND (v_actor_kind <> 'admin' OR v_purpose_kind IS DISTINCT FROM 'reveal'
          OR char_length(v_reason) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'record_event: invalid reason' USING ERRCODE = '22023';
  END IF;

  v_link_expires_at := jale_audit.json_timestamptz(p_event, 'link_expires_at', c_context);

  v_part := COALESCE(jale_audit.json_integer(p_event, 'part', 1, 32767, c_context), 1);
  v_parts := COALESCE(jale_audit.json_integer(p_event, 'parts', 1, 32767, c_context), 1);
  IF v_part > v_parts THEN
    RAISE EXCEPTION 'record_event: invalid part' USING ERRCODE = '22023';
  END IF;

  v_request_id := jale_audit.json_text(p_event, 'request_id', c_context);
  IF v_request_id IS NOT NULL AND v_request_id !~ '^[A-Za-z0-9-]{1,64}$' THEN
    RAISE EXCEPTION 'record_event: invalid request_id' USING ERRCODE = '22023';
  END IF;

  INSERT INTO jale_audit.events (
    kind, outcome, actor_kind, actor_id, actor_role, actor_session, channel, surface, categories,
    subject_user_ids, record_type, record_ids, result_count, field_names, purpose_kind, purpose_id,
    reason, link_expires_at, part, parts, request_id
  ) VALUES (
    v_kind, v_outcome, v_actor_kind, v_actor_id, v_actor_role, v_actor_session, v_channel, v_surface,
    v_categories, v_subjects, v_record_type, v_records, v_result_count, v_field_names, v_purpose_kind,
    v_purpose_id, v_reason, v_link_expires_at, v_part, v_parts, v_request_id
  )
  RETURNING seq INTO v_seq;

  RETURN v_seq;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.record_event(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.record_event(jsonb) TO jale_api, jale_whatsapp, jale_admin_console;

-- ── The guard ───────────────────────────────────────────────
-- Bound to every jale_audit table here and to public.admin_audit_log in 110:
-- BEFORE UPDATE OR DELETE for each row, and BEFORE TRUNCATE. It refuses
-- every change (SQLSTATE 55000) except three narrow paths, each opened by a
-- transaction-local flag that one owner-run function sets around its own
-- statement:
--   jale_audit.purge   delete a row past 13 months, below its stream's
--                      watermark, and not held unless already exported;
--   jale_audit.redact  replace an event's reason with '[redacted]', with
--                      every other column unchanged;
--   jale_audit.export  move a stream's watermark forward in export_state.
-- TRUNCATE is always refused. Columns are read through to_jsonb, because one
-- trigger function serves tables with different columns.
CREATE FUNCTION jale_audit.reject_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_table TEXT := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_stream TEXT;
  v_old JSONB;
  v_new JSONB;
  v_seq BIGINT;
  v_at TIMESTAMPTZ;
  v_watermark XID8;
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' AND current_setting('jale_audit.purge', true) = 'on' THEN
    v_stream := CASE v_table
                  WHEN 'jale_audit.events' THEN 'events'
                  WHEN 'jale_audit.changes' THEN 'changes'
                  WHEN 'public.admin_audit_log' THEN 'admin_actions_legacy'
                END;
    IF v_stream IS NOT NULL THEN
      v_old := to_jsonb(OLD);
      v_seq := (v_old ->> 'seq')::BIGINT;
      v_at := (v_old ->> CASE WHEN v_stream = 'admin_actions_legacy' THEN 'created_at' ELSE 'occurred_at' END)::TIMESTAMPTZ;
      SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = v_stream;
      IF v_seq IS NOT NULL
         AND v_at < now() - INTERVAL '13 months'
         AND (v_old ->> 'xact')::XID8 < v_watermark
         AND (NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                           WHERE h.stream = v_stream AND h.row_seq = v_seq AND h.action = 'hold')
              OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                          WHERE h.stream = v_stream AND h.row_seq = v_seq AND h.action = 'export')) THEN
        RETURN OLD;
      END IF;
    END IF;
  ELSIF TG_LEVEL = 'ROW' AND TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    IF v_table = 'jale_audit.events' AND current_setting('jale_audit.redact', true) = 'on'
       AND v_old ->> 'reason' IS NOT NULL
       AND v_new ->> 'reason' = '[redacted]'
       AND (v_new - 'reason') = (v_old - 'reason') THEN
      RETURN NEW;
    END IF;
    IF v_table = 'jale_audit.export_state' AND current_setting('jale_audit.export', true) = 'on'
       AND v_new ->> 'stream' = v_old ->> 'stream'
       AND (v_new ->> 'watermark')::XID8 >= (v_old ->> 'watermark')::XID8 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% on % is refused: audit records are append-only', TG_OP, v_table USING ERRCODE = '55000';
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.reject_change() FROM PUBLIC;

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON jale_audit.events
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON jale_audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER changes_append_only BEFORE UPDATE OR DELETE ON jale_audit.changes
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER changes_no_truncate BEFORE TRUNCATE ON jale_audit.changes
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_state_append_only BEFORE UPDATE OR DELETE ON jale_audit.export_state
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_state_no_truncate BEFORE TRUNCATE ON jale_audit.export_state
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_batches_append_only BEFORE UPDATE OR DELETE ON jale_audit.export_batches
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_batches_no_truncate BEFORE TRUNCATE ON jale_audit.export_batches
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_holds_append_only BEFORE UPDATE OR DELETE ON jale_audit.export_holds
  FOR EACH ROW EXECUTE FUNCTION jale_audit.reject_change();
CREATE TRIGGER export_holds_no_truncate BEFORE TRUNCATE ON jale_audit.export_holds
  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.reject_change();

-- ── Canonical lines ─────────────────────────────────────────
-- One JSON object per row: json_build_object (not jsonb) so the keys keep
-- this order; times as UTC 'YYYY-MM-DDTHH24:MI:SS.US' plus 'Z', whatever the
-- session's TimeZone or DateStyle; xact as a string. An object's bytes are
-- its lines in seq order, each in UTF-8 and followed by "\n", so recomputing
-- a window from the rows gives the same bytes and the same digest.
CREATE FUNCTION jale_audit.utc_text(p_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$fn$;
REVOKE ALL ON FUNCTION jale_audit.utc_text(timestamptz) FROM PUBLIC;

CREATE FUNCTION jale_audit.event_line(e jale_audit.events)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT json_build_object(
    'seq', e.seq,
    'event_id', e.event_id,
    'xact', e.xact::TEXT,
    'occurred_at', jale_audit.utc_text(e.occurred_at),
    'kind', e.kind,
    'outcome', e.outcome,
    'actor_kind', e.actor_kind,
    'actor_id', e.actor_id,
    'actor_role', e.actor_role,
    'actor_session', e.actor_session,
    'channel', e.channel,
    'surface', e.surface,
    'categories', e.categories,
    'subject_user_ids', e.subject_user_ids,
    'record_type', e.record_type,
    'record_ids', e.record_ids,
    'result_count', e.result_count,
    'field_names', e.field_names,
    'purpose_kind', e.purpose_kind,
    'purpose_id', e.purpose_id,
    'reason', e.reason,
    'link_expires_at', jale_audit.utc_text(e.link_expires_at),
    'part', e.part,
    'parts', e.parts,
    'request_id', e.request_id,
    'db_login', e.db_login::TEXT,
    'db_pid', e.db_pid
  )::TEXT
$fn$;
REVOKE ALL ON FUNCTION jale_audit.event_line(jale_audit.events) FROM PUBLIC;

CREATE FUNCTION jale_audit.change_line(c jale_audit.changes)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT json_build_object(
    'seq', c.seq,
    'event_id', c.event_id,
    'xact', c.xact::TEXT,
    'occurred_at', jale_audit.utc_text(c.occurred_at),
    'table_name', c.table_name,
    'operation', c.operation,
    'row_count', c.row_count,
    'record_ids', c.record_ids,
    'subject_user_ids', c.subject_user_ids,
    'changed_fields', c.changed_fields,
    'actor_kind', c.actor_kind,
    'actor_id', c.actor_id,
    'channel', c.channel,
    'surface', c.surface,
    'request_id', c.request_id,
    'context_status', c.context_status,
    'db_login', c.db_login::TEXT,
    'db_pid', c.db_pid
  )::TEXT
$fn$;
REVOKE ALL ON FUNCTION jale_audit.change_line(jale_audit.changes) FROM PUBLIC;

-- Refuses a stream name outside the three.
CREATE FUNCTION jale_audit.require_stream(p_stream TEXT, p_context TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_stream IS NULL OR p_stream NOT IN ('events', 'changes', 'admin_actions_legacy') THEN
    RAISE EXCEPTION '%: invalid p_stream', p_context USING ERRCODE = '22023';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.require_stream(text, text) FROM PUBLIC;

-- The lines of one stream's rows with xact in [p_from, p_to), after
-- p_after_seq, in seq order. The legacy stream's line function and columns
-- come with 110.
CREATE FUNCTION jale_audit.window_rows(p_stream TEXT, p_from XID8, p_to XID8, p_after_seq BIGINT, p_limit INTEGER)
RETURNS TABLE (seq BIGINT, line TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_stream = 'events' THEN
    RETURN QUERY
      SELECT e.seq, jale_audit.event_line(e) FROM jale_audit.events e
       WHERE e.xact >= p_from AND e.xact < p_to AND e.seq > p_after_seq
       ORDER BY e.seq LIMIT p_limit;
  ELSIF p_stream = 'changes' THEN
    RETURN QUERY
      SELECT c.seq, jale_audit.change_line(c) FROM jale_audit.changes c
       WHERE c.xact >= p_from AND c.xact < p_to AND c.seq > p_after_seq
       ORDER BY c.seq LIMIT p_limit;
  ELSIF p_stream = 'admin_actions_legacy' THEN
    RETURN QUERY
      SELECT l.seq, jale_audit.legacy_line(l) FROM public.admin_audit_log l
       WHERE l.xact >= p_from AND l.xact < p_to AND l.seq > p_after_seq
       ORDER BY l.seq LIMIT p_limit;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.window_rows(text, xid8, xid8, bigint, integer) FROM PUBLIC;

-- The lines of the listed rows of one stream, in seq order.
CREATE FUNCTION jale_audit.listed_rows(p_stream TEXT, p_seqs BIGINT[])
RETURNS TABLE (seq BIGINT, line TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_stream = 'events' THEN
    RETURN QUERY
      SELECT e.seq, jale_audit.event_line(e) FROM jale_audit.events e WHERE e.seq = ANY (p_seqs) ORDER BY e.seq;
  ELSIF p_stream = 'changes' THEN
    RETURN QUERY
      SELECT c.seq, jale_audit.change_line(c) FROM jale_audit.changes c WHERE c.seq = ANY (p_seqs) ORDER BY c.seq;
  ELSIF p_stream = 'admin_actions_legacy' THEN
    RETURN QUERY
      SELECT l.seq, jale_audit.legacy_line(l) FROM public.admin_audit_log l WHERE l.seq = ANY (p_seqs) ORDER BY l.seq;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.listed_rows(text, bigint[]) FROM PUBLIC;

-- The digest of the stream's last batch that wrote an object; NULL before the
-- first one.
CREATE FUNCTION jale_audit.last_digest(p_stream TEXT)
RETURNS BYTEA
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT b.digest FROM jale_audit.export_batches b
   WHERE b.stream = p_stream AND b.digest IS NOT NULL
   ORDER BY b.seq DESC LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION jale_audit.last_digest(text) FROM PUBLIC;

-- Refuses an export object key outside db/<stream>/.../*.jsonl.gz.
CREATE FUNCTION jale_audit.require_object_key(p_stream TEXT, p_object_key TEXT, p_context TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_object_key IS NULL OR char_length(p_object_key) > 512
     OR p_object_key !~ '^db/(events|changes|admin_actions_legacy)/([A-Za-z0-9=_-][A-Za-z0-9=._-]*/)*[A-Za-z0-9=_-][A-Za-z0-9=._-]*\.jsonl\.gz$'
     OR split_part(p_object_key, '/', 2) <> p_stream THEN
    RAISE EXCEPTION '%: invalid p_object_key', p_context USING ERRCODE = '22023';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.require_object_key(text, text, text) FROM PUBLIC;

-- ── Export functions (the export job's login only) ──────────
-- A window is [from_xact, to_xact): from is the stream's watermark, to is
-- the current snapshot's xmin. Every transaction below xmin has finished,
-- so each committed transaction's rows fall in exactly one window, however
-- late it commits; identity values are never used to choose a window.
CREATE FUNCTION jale_audit.export_window(p_stream TEXT)
RETURNS TABLE (from_xact XID8, to_xact XID8, prev_digest BYTEA)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_from XID8;
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'export_window');
  SELECT s.watermark INTO v_from FROM jale_audit.export_state s WHERE s.stream = p_stream;
  RETURN QUERY
    SELECT v_from, greatest(v_from, pg_snapshot_xmin(pg_current_snapshot())), jale_audit.last_digest(p_stream);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_window(text) FROM PUBLIC;

-- Checks a window's bounds: both set, from <= to, and to at or below the
-- current snapshot's xmin (a window may never reach into transactions that
-- can still commit).
CREATE FUNCTION jale_audit.require_window(p_from XID8, p_to XID8, p_context TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_from IS NULL THEN
    RAISE EXCEPTION '%: invalid p_from', p_context USING ERRCODE = '22023';
  END IF;
  IF p_to IS NULL OR p_to < p_from OR p_to > pg_snapshot_xmin(pg_current_snapshot()) THEN
    RAISE EXCEPTION '%: invalid p_to', p_context USING ERRCODE = '22023';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.require_window(xid8, xid8, text) FROM PUBLIC;

-- One page of a window's lines, in seq order, after p_after_seq.
CREATE FUNCTION jale_audit.export_rows(p_stream TEXT, p_from XID8, p_to XID8, p_after_seq BIGINT, p_limit INTEGER)
RETURNS TABLE (seq BIGINT, line TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'export_rows');
  PERFORM jale_audit.require_window(p_from, p_to, 'export_rows');
  IF p_after_seq IS NULL THEN
    RAISE EXCEPTION 'export_rows: invalid p_after_seq' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'export_rows: invalid p_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT r.seq, r.line FROM jale_audit.window_rows(p_stream, p_from, p_to, p_after_seq, p_limit) r;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_rows(text, xid8, xid8, bigint, integer) FROM PUBLIC;

-- Records a window the job has written (or, when every row was held or the
-- window was empty, has nothing to write for), records its holds, and moves
-- the watermark to p_to. It recomputes the window from the rows and refuses
-- anything it cannot reproduce: the count, the seq range, the digest, the
-- held rows (22023). A window that does not start at the watermark is
-- refused with 55000, so a replay or a concurrent run commits nothing. An
-- empty xid range (p_from = p_to) commits nothing and returns NULL.
CREATE FUNCTION jale_audit.export_commit(
  p_stream     TEXT,
  p_from       XID8,
  p_to         XID8,
  p_row_count  INTEGER,
  p_seq_min    BIGINT,
  p_seq_max    BIGINT,
  p_digest     BYTEA,
  p_object_key TEXT,
  p_held_seqs  BIGINT[]
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_context CONSTANT TEXT := 'export_commit';
  v_held BIGINT[] := COALESCE(p_held_seqs, '{}');
  v_watermark XID8;
  v_count INTEGER;
  v_min BIGINT;
  v_max BIGINT;
  v_hash BYTEA;
  v_held_found INTEGER;
  v_prev BYTEA;
  v_digest BYTEA;
  v_batch BIGINT;
BEGIN
  PERFORM jale_audit.require_stream(p_stream, c_context);
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'export_commit: invalid p_from' USING ERRCODE = '22023';
  END IF;
  -- One commit per stream at a time: the second waits here, then finds the
  -- watermark moved and is refused.
  SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = p_stream FOR UPDATE;
  IF p_from <> v_watermark THEN
    RAISE EXCEPTION 'export_commit: the window does not start at the watermark' USING ERRCODE = '55000';
  END IF;
  PERFORM jale_audit.require_window(p_from, p_to, c_context);
  IF cardinality(v_held) > 10000 OR array_position(v_held, NULL) IS NOT NULL
     OR cardinality(v_held) <> (SELECT count(DISTINCT h) FROM unnest(v_held) h) THEN
    RAISE EXCEPTION 'export_commit: invalid p_held_seqs' USING ERRCODE = '22023';
  END IF;

  IF p_to = p_from THEN
    IF cardinality(v_held) > 0 OR p_row_count IS DISTINCT FROM 0 OR p_seq_min IS NOT NULL OR p_seq_max IS NOT NULL
       OR p_digest IS NOT NULL OR p_object_key IS NOT NULL THEN
      RAISE EXCEPTION 'export_commit: invalid p_row_count' USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE NOT (r.seq = ANY (v_held))),
         min(r.seq) FILTER (WHERE NOT (r.seq = ANY (v_held))),
         max(r.seq) FILTER (WHERE NOT (r.seq = ANY (v_held))),
         sha256(convert_to(COALESCE(string_agg(r.line || E'\n', '' ORDER BY r.seq)
                                      FILTER (WHERE NOT (r.seq = ANY (v_held))), ''), 'UTF8')),
         count(*) FILTER (WHERE r.seq = ANY (v_held))
    INTO v_count, v_min, v_max, v_hash, v_held_found
    FROM jale_audit.window_rows(p_stream, p_from, p_to, 0, 2147483647) r;

  IF v_held_found <> cardinality(v_held) THEN
    RAISE EXCEPTION 'export_commit: invalid p_held_seqs' USING ERRCODE = '22023';
  END IF;
  IF p_row_count IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'export_commit: invalid p_row_count' USING ERRCODE = '22023';
  END IF;
  IF p_seq_min IS DISTINCT FROM v_min THEN
    RAISE EXCEPTION 'export_commit: invalid p_seq_min' USING ERRCODE = '22023';
  END IF;
  IF p_seq_max IS DISTINCT FROM v_max THEN
    RAISE EXCEPTION 'export_commit: invalid p_seq_max' USING ERRCODE = '22023';
  END IF;

  IF v_count = 0 THEN
    IF p_digest IS NOT NULL THEN
      RAISE EXCEPTION 'export_commit: invalid p_digest' USING ERRCODE = '22023';
    END IF;
    IF p_object_key IS NOT NULL THEN
      RAISE EXCEPTION 'export_commit: invalid p_object_key' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_prev := jale_audit.last_digest(p_stream);
    v_digest := sha256(COALESCE(v_prev, ''::BYTEA) || v_hash);
    IF p_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'export_commit: invalid p_digest' USING ERRCODE = '22023';
    END IF;
    PERFORM jale_audit.require_object_key(p_stream, p_object_key, c_context);
  END IF;

  INSERT INTO jale_audit.export_batches
    (stream, batch_kind, from_xact, to_xact, row_count, seq_min, seq_max, prev_digest, digest, object_key)
  VALUES
    (p_stream, 'window', p_from, p_to, v_count, v_min, v_max, v_prev, v_digest, p_object_key)
  RETURNING seq INTO v_batch;

  INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq)
  SELECT p_stream, h, 'hold', v_batch FROM unnest(v_held) h ORDER BY h;

  PERFORM set_config('jale_audit.export', 'on', true);
  UPDATE jale_audit.export_state s SET watermark = p_to, updated_at = clock_timestamp() WHERE s.stream = p_stream;
  PERFORM set_config('jale_audit.export', 'off', true);
  RETURN v_batch;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_commit(text, xid8, xid8, integer, bigint, bigint, bytea, text, bigint[]) FROM PUBLIC;

-- Released rows not yet exported, in seq order, for a release batch.
CREATE FUNCTION jale_audit.export_released(p_stream TEXT, p_limit INTEGER)
RETURNS TABLE (seq BIGINT, line TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'export_released');
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'export_released: invalid p_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.seq, r.line
      FROM jale_audit.listed_rows(p_stream, ARRAY(
             SELECT h.row_seq FROM jale_audit.export_holds h
              WHERE h.stream = p_stream AND h.action = 'release'
                AND NOT EXISTS (SELECT 1 FROM jale_audit.export_holds x
                                 WHERE x.stream = h.stream AND x.row_seq = h.row_seq AND x.action = 'export')
              ORDER BY h.row_seq LIMIT p_limit)) r;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_released(text, integer) FROM PUBLIC;

-- Records a release batch: the listed rows, each released and not yet
-- exported, written as one object. The digest chains after the stream's
-- last batch, as a window's does.
CREATE FUNCTION jale_audit.export_commit_release(p_stream TEXT, p_seqs BIGINT[], p_digest BYTEA, p_object_key TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_context CONSTANT TEXT := 'export_commit_release';
  v_count INTEGER;
  v_min BIGINT;
  v_max BIGINT;
  v_hash BYTEA;
  v_prev BYTEA;
  v_digest BYTEA;
  v_batch BIGINT;
BEGIN
  PERFORM jale_audit.require_stream(p_stream, c_context);
  -- Serializes with export_commit, so the digest chain has one order.
  PERFORM 1 FROM jale_audit.export_state s WHERE s.stream = p_stream FOR UPDATE;
  IF p_seqs IS NULL OR cardinality(p_seqs) NOT BETWEEN 1 AND 10000 OR array_position(p_seqs, NULL) IS NOT NULL
     OR cardinality(p_seqs) <> (SELECT count(DISTINCT s) FROM unnest(p_seqs) s) THEN
    RAISE EXCEPTION 'export_commit_release: invalid p_seqs' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_seqs) s
     WHERE NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                        WHERE h.stream = p_stream AND h.row_seq = s AND h.action = 'release')
        OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                    WHERE h.stream = p_stream AND h.row_seq = s AND h.action = 'export')
  ) THEN
    RAISE EXCEPTION 'export_commit_release: invalid p_seqs' USING ERRCODE = '22023';
  END IF;

  SELECT count(*), min(r.seq), max(r.seq),
         sha256(convert_to(COALESCE(string_agg(r.line || E'\n', '' ORDER BY r.seq), ''), 'UTF8'))
    INTO v_count, v_min, v_max, v_hash
    FROM jale_audit.listed_rows(p_stream, p_seqs) r;
  IF v_count <> cardinality(p_seqs) THEN
    RAISE EXCEPTION 'export_commit_release: invalid p_seqs' USING ERRCODE = '22023';
  END IF;

  v_prev := jale_audit.last_digest(p_stream);
  v_digest := sha256(COALESCE(v_prev, ''::BYTEA) || v_hash);
  IF p_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'export_commit_release: invalid p_digest' USING ERRCODE = '22023';
  END IF;
  PERFORM jale_audit.require_object_key(p_stream, p_object_key, c_context);

  INSERT INTO jale_audit.export_batches
    (stream, batch_kind, row_count, seq_min, seq_max, prev_digest, digest, object_key)
  VALUES
    (p_stream, 'release', v_count, v_min, v_max, v_prev, v_digest, p_object_key)
  RETURNING seq INTO v_batch;

  INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq)
  SELECT p_stream, s, 'export', v_batch FROM unnest(p_seqs) s ORDER BY s;
  RETURN v_batch;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_commit_release(text, bigint[], bytea, text) FROM PUBLIC;

-- Recomputes a window from the current rows: (row_count, sha256 of the
-- lines). It leaves out the rows held at that window's commit, and any
-- p_held_seqs (for a window the job wrote but did not commit), so a hold is
-- never a permanent mismatch.
CREATE FUNCTION jale_audit.compare_window(p_stream TEXT, p_from XID8, p_to XID8, p_held_seqs BIGINT[] DEFAULT NULL)
RETURNS TABLE (row_count INTEGER, lines_sha256 BYTEA)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_excluded BIGINT[];
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'compare_window');
  PERFORM jale_audit.require_window(p_from, p_to, 'compare_window');
  IF cardinality(p_held_seqs) > 10000 OR array_position(p_held_seqs, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'compare_window: invalid p_held_seqs' USING ERRCODE = '22023';
  END IF;
  v_excluded := COALESCE(p_held_seqs, '{}') || ARRAY(
    SELECT h.row_seq
      FROM jale_audit.export_holds h
      JOIN jale_audit.export_batches b ON b.seq = h.batch_seq
     WHERE h.stream = p_stream AND h.action = 'hold'
       AND b.stream = p_stream AND b.batch_kind = 'window' AND b.from_xact = p_from AND b.to_xact = p_to);
  RETURN QUERY
    SELECT count(*)::INTEGER,
           sha256(convert_to(COALESCE(string_agg(r.line || E'\n', '' ORDER BY r.seq), ''), 'UTF8'))
      FROM jale_audit.window_rows(p_stream, p_from, p_to, 0, 2147483647) r
     WHERE NOT (r.seq = ANY (v_excluded));
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.compare_window(text, xid8, xid8, bigint[]) FROM PUBLIC;

-- Deletes, per stream, up to p_batch rows that are past 13 months, below the
-- stream's watermark, and either never held or already exported after their
-- release. The guard checks every row again under the purge flag. Returns
-- the count deleted per stream.
CREATE FUNCTION jale_audit.purge_expired(p_batch INTEGER)
RETURNS TABLE (stream TEXT, deleted INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff TIMESTAMPTZ := now() - INTERVAL '13 months';
  v_watermark XID8;
  v_count INTEGER;
BEGIN
  IF p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'purge_expired: invalid p_batch' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('jale_audit.purge', 'on', true);

  SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = 'events';
  DELETE FROM jale_audit.events e
   WHERE e.seq IN (
     SELECT x.seq FROM jale_audit.events x
      WHERE x.occurred_at < v_cutoff AND x.xact < v_watermark
        AND (NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                          WHERE h.stream = 'events' AND h.row_seq = x.seq AND h.action = 'hold')
             OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                         WHERE h.stream = 'events' AND h.row_seq = x.seq AND h.action = 'export'))
      ORDER BY x.seq LIMIT p_batch);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  stream := 'events'; deleted := v_count; RETURN NEXT;

  SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = 'changes';
  DELETE FROM jale_audit.changes c
   WHERE c.seq IN (
     SELECT x.seq FROM jale_audit.changes x
      WHERE x.occurred_at < v_cutoff AND x.xact < v_watermark
        AND (NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                          WHERE h.stream = 'changes' AND h.row_seq = x.seq AND h.action = 'hold')
             OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                         WHERE h.stream = 'changes' AND h.row_seq = x.seq AND h.action = 'export'))
      ORDER BY x.seq LIMIT p_batch);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  stream := 'changes'; deleted := v_count; RETURN NEXT;

  SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = 'admin_actions_legacy';
  DELETE FROM public.admin_audit_log l
   WHERE l.seq IN (
     SELECT x.seq FROM public.admin_audit_log x
      WHERE x.created_at < v_cutoff AND x.xact < v_watermark
        AND (NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                          WHERE h.stream = 'admin_actions_legacy' AND h.row_seq = x.seq AND h.action = 'hold')
             OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                         WHERE h.stream = 'admin_actions_legacy' AND h.row_seq = x.seq AND h.action = 'export'))
      ORDER BY x.seq LIMIT p_batch);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  stream := 'admin_actions_legacy'; deleted := v_count; RETURN NEXT;

  PERFORM set_config('jale_audit.purge', 'off', true);
  RETURN;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.purge_expired(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  jale_audit.export_window(text),
  jale_audit.export_rows(text, xid8, xid8, bigint, integer),
  jale_audit.export_commit(text, xid8, xid8, integer, bigint, bigint, bytea, text, bigint[]),
  jale_audit.export_released(text, integer),
  jale_audit.export_commit_release(text, bigint[], bytea, text),
  jale_audit.compare_window(text, xid8, xid8, bigint[]),
  jale_audit.purge_expired(integer)
TO jale_job_audit_export;

-- How far a stream's export is behind: the rows at or above its watermark
-- that this snapshot sees (committed, not yet in a committed window), and the
-- oldest one's time. Rows committed behind an older open transaction count:
-- no window can reach them until it ends. 55000 when the stream has no export
-- state. The export job's login only.
CREATE FUNCTION jale_audit.export_backlog(p_stream TEXT)
RETURNS TABLE (pending_rows BIGINT, oldest_pending_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
#variable_conflict use_column
DECLARE v_watermark XID8;
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'export_backlog');
  SELECT s.watermark INTO v_watermark FROM jale_audit.export_state s WHERE s.stream = p_stream;
  IF v_watermark IS NULL THEN
    RAISE EXCEPTION 'export_backlog: no export state for stream' USING ERRCODE = '55000';
  END IF;
  IF p_stream = 'events' THEN
    RETURN QUERY SELECT count(*), min(e.occurred_at) FROM jale_audit.events e WHERE e.xact >= v_watermark;
  ELSIF p_stream = 'changes' THEN
    RETURN QUERY SELECT count(*), min(c.occurred_at) FROM jale_audit.changes c WHERE c.xact >= v_watermark;
  ELSE
    RETURN QUERY SELECT count(*), min(l.created_at) FROM public.admin_audit_log l WHERE l.xact >= v_watermark;
  END IF;
END; $fn$;
REVOKE ALL ON FUNCTION jale_audit.export_backlog(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.export_backlog(text) TO jale_job_audit_export;

-- ── Holds and redaction (supervised; jale_admin only) ───────
-- Releases a held row, so the next release batch exports it as it is.
CREATE FUNCTION jale_audit.release_hold(p_stream TEXT, p_seq BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hold BIGINT;
BEGIN
  PERFORM jale_audit.require_stream(p_stream, 'release_hold');
  IF p_seq IS NULL
     OR NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                     WHERE h.stream = p_stream AND h.row_seq = p_seq AND h.action = 'hold')
     OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                 WHERE h.stream = p_stream AND h.row_seq = p_seq AND h.action = 'release') THEN
    RAISE EXCEPTION 'release_hold: invalid p_seq' USING ERRCODE = '22023';
  END IF;
  INSERT INTO jale_audit.export_holds (stream, row_seq, action) VALUES (p_stream, p_seq, 'release')
  RETURNING seq INTO v_hold;
  RETURN v_hold;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.release_hold(text, bigint) FROM PUBLIC;

-- Replaces a held event's reason with '[redacted]', then releases it. Only
-- the events stream carries free text.
CREATE FUNCTION jale_audit.redact_and_release(p_stream TEXT, p_seq BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hold BIGINT;
BEGIN
  IF p_stream IS DISTINCT FROM 'events' THEN
    RAISE EXCEPTION 'redact_and_release: invalid p_stream' USING ERRCODE = '22023';
  END IF;
  IF p_seq IS NULL
     OR NOT EXISTS (SELECT 1 FROM jale_audit.export_holds h
                     WHERE h.stream = 'events' AND h.row_seq = p_seq AND h.action = 'hold')
     OR EXISTS (SELECT 1 FROM jale_audit.export_holds h
                 WHERE h.stream = 'events' AND h.row_seq = p_seq AND h.action = 'release') THEN
    RAISE EXCEPTION 'redact_and_release: invalid p_seq' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('jale_audit.redact', 'on', true);
  UPDATE jale_audit.events e SET reason = '[redacted]'
   WHERE e.seq = p_seq AND e.reason IS NOT NULL AND e.reason <> '[redacted]';
  PERFORM set_config('jale_audit.redact', 'off', true);
  INSERT INTO jale_audit.export_holds (stream, row_seq, action) VALUES ('events', p_seq, 'release')
  RETURNING seq INTO v_hold;
  RETURN v_hold;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.redact_and_release(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.release_hold(text, bigint), jale_audit.redact_and_release(text, bigint) TO jale_admin;

-- ── The access history view's functions ─────────────────────
-- history_search returns events, change records and the dashboard's frozen
-- action records (110) for one filter, newest first: occurred_at DESC, then
-- source, seq DESC, entry_id. A full page also carries every further row with
-- its last row's occurred_at, so a caller paging with p_before = that time
-- never skips a row. After computing the page it records its own read event
-- in the caller's transaction, so a call never returns its own event.
-- AUDIT.md documents every argument and column.
CREATE FUNCTION jale_audit.history_search(
  p_actor  JSONB,
  p_filter JSONB,
  p_limit  INTEGER,
  p_before TIMESTAMPTZ
)
RETURNS TABLE (
  source           TEXT,
  seq              BIGINT,
  entry_id         UUID,
  occurred_at      TIMESTAMPTZ,
  kind             TEXT,
  outcome          TEXT,
  actor_kind       TEXT,
  actor_id         UUID,
  actor_role       TEXT,
  actor_session    UUID,
  actor_email      TEXT,
  channel          TEXT,
  surface          TEXT,
  categories       TEXT[],
  subject_user_ids UUID[],
  record_type      TEXT,
  record_ids       UUID[],
  result_count     INTEGER,
  field_names      TEXT[],
  purpose_kind     TEXT,
  purpose_id       UUID,
  reason           TEXT,
  link_expires_at  TIMESTAMPTZ,
  part             SMALLINT,
  parts            SMALLINT,
  table_name       TEXT,
  operation        TEXT,
  row_count        INTEGER,
  changed_fields   TEXT[],
  context_status   TEXT,
  action           TEXT,
  target_type      TEXT,
  target_id        TEXT,
  summary          TEXT,
  pii_reveal       BOOLEAN,
  request_id       TEXT,
  db_login         TEXT,
  db_pid           INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_context CONSTANT TEXT := 'history_search';
  v_filter JSONB := COALESCE(p_filter, '{}'::JSONB);
  v_key TEXT;
  v_actor_id UUID;
  v_actor_role TEXT;
  v_actor_session UUID;
  v_request_id TEXT;
  f_subject UUID;
  f_actor UUID;
  f_record UUID;
  f_from TIMESTAMPTZ;
  f_to TIMESTAMPTZ;
  f_category TEXT;
  f_outcome TEXT;
  f_actor_email TEXT;
  -- Each source's predicates hold only the filters that are set, so every
  -- search is planned for its own filter (the subject and record filters
  -- use the GIN indexes). Values are always bound parameters:
  -- $1 subject, $2 actor, $3 record, $4 from, $5 to, $6 category,
  -- $7 outcome, $8 before, $9 the actor's email, $10 the limit.
  w_event TEXT := 'TRUE';
  w_change TEXT := 'TRUE';
  w_legacy TEXT := 'TRUE';
  v_count INTEGER;
BEGIN
  IF p_actor IS NULL OR jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION 'history_search: invalid p_actor' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_actor) LOOP
    IF NOT v_key = ANY (ARRAY['actor_id', 'actor_role', 'actor_session', 'request_id']) THEN
      RAISE EXCEPTION 'history_search: unknown key' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  v_actor_id := jale_audit.json_uuid(p_actor, 'actor_id', c_context);
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'history_search: invalid actor_id' USING ERRCODE = '22023';
  END IF;
  v_actor_role := jale_audit.json_text(p_actor, 'actor_role', c_context);
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin_readonly', 'admin_ops', 'admin_superadmin') THEN
    RAISE EXCEPTION 'history_search: invalid actor_role' USING ERRCODE = '22023';
  END IF;
  v_actor_session := jale_audit.json_uuid(p_actor, 'actor_session', c_context);
  v_request_id := jale_audit.json_text(p_actor, 'request_id', c_context);
  IF v_request_id IS NOT NULL AND v_request_id !~ '^[A-Za-z0-9-]{1,64}$' THEN
    RAISE EXCEPTION 'history_search: invalid request_id' USING ERRCODE = '22023';
  END IF;
  -- The access history is for the superadmin role only. The page checks the
  -- role first and records a refusal as an attempt.
  IF v_actor_role <> 'admin_superadmin' THEN
    RAISE EXCEPTION 'history_search: the access history is for superadmins only' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_filter) <> 'object' THEN
    RAISE EXCEPTION 'history_search: invalid p_filter' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_filter) LOOP
    IF NOT v_key = ANY (ARRAY['subject_user_id', 'actor_id', 'record_id', 'from', 'to', 'category', 'outcome']) THEN
      RAISE EXCEPTION 'history_search: unknown key' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  f_subject := jale_audit.json_uuid(v_filter, 'subject_user_id', c_context);
  f_actor := jale_audit.json_uuid(v_filter, 'actor_id', c_context);
  f_record := jale_audit.json_uuid(v_filter, 'record_id', c_context);
  f_from := jale_audit.json_timestamptz(v_filter, 'from', c_context);
  f_to := jale_audit.json_timestamptz(v_filter, 'to', c_context);
  f_category := jale_audit.json_text(v_filter, 'category', c_context);
  IF f_category IS NOT NULL AND NOT f_category = ANY (ARRAY[
    'application_answers', 'contact_details', 'documents', 'trust_assessments', 'conversations',
    'profile', 'posts', 'saved_application_details', 'cases', 'verifications', 'analytics',
    'billing', 'audit_history', 'problem_reports', 'admin_access'
  ]) THEN
    RAISE EXCEPTION 'history_search: invalid category' USING ERRCODE = '22023';
  END IF;
  f_outcome := jale_audit.json_text(v_filter, 'outcome', c_context);
  IF f_outcome IS NOT NULL AND NOT f_outcome = ANY (ARRAY[
    'allowed', 'denied', 'not_found', 'failed', 'signed_in', 'sign_in_rejected', 'signed_out', 'expired',
    'revoked', 'done'
  ]) THEN
    RAISE EXCEPTION 'history_search: invalid outcome' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'history_search: invalid p_limit' USING ERRCODE = '22023';
  END IF;

  IF p_before IS NOT NULL THEN
    w_event := w_event || ' AND e.occurred_at < $8';
    w_change := w_change || ' AND c.occurred_at < $8';
    w_legacy := w_legacy || ' AND l.created_at < $8';
  END IF;
  IF f_from IS NOT NULL THEN
    w_event := w_event || ' AND e.occurred_at >= $4';
    w_change := w_change || ' AND c.occurred_at >= $4';
    w_legacy := w_legacy || ' AND l.created_at >= $4';
  END IF;
  IF f_to IS NOT NULL THEN
    w_event := w_event || ' AND e.occurred_at < $5';
    w_change := w_change || ' AND c.occurred_at < $5';
    w_legacy := w_legacy || ' AND l.created_at < $5';
  END IF;
  IF f_subject IS NOT NULL THEN
    w_event := w_event || ' AND e.subject_user_ids @> ARRAY[$1]';
    w_change := w_change || ' AND c.subject_user_ids @> ARRAY[$1]';
    -- A legacy row names a target, never a subject.
    w_legacy := 'FALSE';
  END IF;
  IF f_actor IS NOT NULL THEN
    SELECT u.admin_email INTO f_actor_email FROM public.admin_users u WHERE u.id = f_actor;
    w_event := w_event || ' AND e.actor_id = $2';
    w_change := w_change || ' AND c.actor_id = $2';
    w_legacy := w_legacy || ' AND (l.actor_admin_id = $2 OR (l.actor_admin_id IS NULL AND lower(l.actor_email) = lower($9)))';
  END IF;
  IF f_record IS NOT NULL THEN
    w_event := w_event || ' AND e.record_ids @> ARRAY[$3]';
    w_change := w_change || ' AND c.record_ids @> ARRAY[$3]';
    w_legacy := w_legacy || ' AND lower(l.target_id) = $3::TEXT';
  END IF;
  -- Only events carry categories and outcomes.
  IF f_category IS NOT NULL THEN
    w_event := w_event || ' AND e.categories @> ARRAY[$6]';
    w_change := 'FALSE';
    w_legacy := 'FALSE';
  END IF;
  IF f_outcome IS NOT NULL THEN
    w_event := w_event || ' AND e.outcome = $7';
    w_change := 'FALSE';
    w_legacy := 'FALSE';
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH newest AS (
      (SELECT e.occurred_at AS at FROM jale_audit.events e WHERE %1$s ORDER BY e.occurred_at DESC LIMIT $10)
      UNION ALL
      (SELECT c.occurred_at FROM jale_audit.changes c WHERE %2$s ORDER BY c.occurred_at DESC LIMIT $10)
      UNION ALL
      (SELECT l.created_at FROM public.admin_audit_log l WHERE %3$s ORDER BY l.created_at DESC LIMIT $10)
    ),
    cutoff AS (
      SELECT COALESCE((SELECT n.at FROM newest n ORDER BY n.at DESC OFFSET $10 - 1 LIMIT 1),
                      '-infinity'::TIMESTAMPTZ) AS at
    )
    SELECT 'event'::TEXT, e.seq, e.event_id, e.occurred_at, e.kind, e.outcome, e.actor_kind, e.actor_id,
           e.actor_role, e.actor_session, u.admin_email, e.channel, e.surface, e.categories, e.subject_user_ids,
           e.record_type, e.record_ids, e.result_count, e.field_names, e.purpose_kind, e.purpose_id, e.reason,
           e.link_expires_at, e.part, e.parts,
           NULL::TEXT, NULL::TEXT, NULL::INTEGER, NULL::TEXT[], NULL::TEXT,
           NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN,
           e.request_id, e.db_login::TEXT, e.db_pid
      FROM jale_audit.events e
      LEFT JOIN public.admin_users u ON e.actor_kind = 'admin' AND u.id = e.actor_id
     WHERE %1$s AND e.occurred_at >= (SELECT cutoff.at FROM cutoff)
    UNION ALL
    SELECT 'change'::TEXT, c.seq, c.event_id, c.occurred_at, NULL::TEXT, NULL::TEXT, c.actor_kind, c.actor_id,
           NULL::TEXT, NULL::UUID, u.admin_email, c.channel, c.surface, NULL::TEXT[], c.subject_user_ids,
           NULL::TEXT, c.record_ids, NULL::INTEGER, NULL::TEXT[], NULL::TEXT, NULL::UUID, NULL::TEXT,
           NULL::TIMESTAMPTZ, NULL::SMALLINT, NULL::SMALLINT,
           c.table_name, c.operation, c.row_count, c.changed_fields, c.context_status,
           NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN,
           c.request_id, c.db_login::TEXT, c.db_pid
      FROM jale_audit.changes c
      LEFT JOIN public.admin_users u ON c.actor_kind = 'admin' AND u.id = c.actor_id
     WHERE %2$s AND c.occurred_at >= (SELECT cutoff.at FROM cutoff)
    UNION ALL
    SELECT 'legacy'::TEXT, l.seq, l.id, l.created_at, NULL::TEXT, NULL::TEXT,
           CASE WHEN l.actor_role = 'system' THEN 'platform' ELSE 'admin' END, l.actor_admin_id,
           l.actor_role, NULL::UUID, l.actor_email, NULL::TEXT, NULL::TEXT, NULL::TEXT[], NULL::UUID[],
           NULL::TEXT, NULL::UUID[], NULL::INTEGER, NULL::TEXT[], NULL::TEXT, NULL::UUID,
           CASE WHEN jsonb_typeof(l.metadata -> 'justification') = 'string' THEN l.metadata ->> 'justification' END,
           NULL::TIMESTAMPTZ, NULL::SMALLINT, NULL::SMALLINT,
           NULL::TEXT, NULL::TEXT, NULL::INTEGER, NULL::TEXT[], NULL::TEXT,
           l.action, l.target_type, l.target_id,
           CASE WHEN jsonb_typeof(l.metadata -> 'summary') = 'string' THEN l.metadata ->> 'summary' END,
           l.pii_reveal, NULL::TEXT, NULL::TEXT, NULL::INTEGER
      FROM public.admin_audit_log l
     WHERE %3$s AND l.created_at >= (SELECT cutoff.at FROM cutoff)
    ORDER BY 4 DESC, 1, 2 DESC, 3
  $q$, w_event, w_change, w_legacy)
  USING f_subject, f_actor, f_record, f_from, f_to, f_category, f_outcome, p_before, f_actor_email, p_limit;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM jale_audit.record_event(jsonb_build_object(
    'kind', 'read',
    'outcome', 'allowed',
    'actor_kind', 'admin',
    'actor_id', v_actor_id,
    'actor_role', v_actor_role,
    'actor_session', v_actor_session,
    'channel', 'admin',
    'surface', 'admin.access_history',
    'categories', jsonb_build_array('audit_history'),
    'subject_user_ids', CASE WHEN f_subject IS NULL THEN '[]'::JSONB ELSE jsonb_build_array(f_subject) END,
    'result_count', v_count,
    'purpose_kind', 'audit_review',
    'request_id', v_request_id
  ));
  RETURN;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.history_search(jsonb, jsonb, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.history_search(jsonb, jsonb, integer, timestamptz) TO jale_admin_console;

-- The dashboard tile: how many contact reveals in the last p_days days. A
-- reveal is a read event with purpose reveal, or a legacy row marked as one.
CREATE FUNCTION jale_audit.reveal_count(p_days INTEGER)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_since TIMESTAMPTZ;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 400 THEN
    RAISE EXCEPTION 'reveal_count: invalid p_days' USING ERRCODE = '22023';
  END IF;
  v_since := now() - make_interval(days => p_days);
  RETURN (SELECT count(*) FROM jale_audit.events e
           WHERE e.purpose_kind = 'reveal' AND e.kind = 'read' AND e.occurred_at >= v_since)
       + (SELECT count(*) FROM public.admin_audit_log l
           WHERE l.pii_reveal AND l.created_at >= v_since);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.reveal_count(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.reveal_count(integer) TO jale_admin_console;

-- The callers reach jale_audit; nothing else does.
GRANT USAGE ON SCHEMA jale_audit TO jale_api, jale_whatsapp, jale_admin_console, jale_job_audit_export, jale_admin;
RESET ROLE;

-- ── 5b. The admin email addresses history_search shows ──────
-- The owner reads two columns of admin_users, through one policy of its own.
GRANT SELECT (id, admin_email) ON public.admin_users TO jale_audit_owner;
CREATE POLICY admin_users_audit_owner_read ON public.admin_users
  FOR SELECT TO jale_audit_owner USING (true);

-- ── 6. Close the SET window ─────────────────────────────────
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['jale_audit_owner', 'jale_ops_owner'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', role_name, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', role_name, current_user, current_user);
  END LOOP;
END;
$$;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  r pg_catalog.pg_roles%ROWTYPE;
  offender TEXT;
  fn_oid OID;
  info RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES ('jale_audit_owner', 'jale_audit'), ('jale_ops_owner', 'jale_ops')) AS t(role_name, schema_name)
  LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = spec.role_name;
    IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'migration 109: existing role % has unsafe attributes', spec.role_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                   WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option)) THEN
      RAISE EXCEPTION 'migration 109: a role still holds SET or INHERIT on owner %', spec.role_name;
    END IF;
    IF pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'migration 109: owner % must not hold CREATE on public', spec.role_name;
    END IF;
    IF (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = spec.schema_name)
         IS DISTINCT FROM spec.role_name
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
          WHERE n.nspname = spec.schema_name AND a.grantee = 0
       ) THEN
      RAISE EXCEPTION 'migration 109: % must be owned by its owner role and closed to PUBLIC', spec.schema_name;
    END IF;
  END LOOP;

  -- jale_audit: USAGE for exactly its callers, CREATE for nobody else.
  SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ', '
                    ORDER BY pg_catalog.pg_get_userbyid(a.grantee))
    INTO offender
    FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'jale_audit' AND a.grantee <> n.nspowner
     AND NOT (a.privilege_type = 'USAGE'
              AND pg_catalog.pg_get_userbyid(a.grantee) IN (
                'jale_api', 'jale_whatsapp', 'jale_admin_console', 'jale_job_audit_export', 'jale_admin'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 109: jale_audit grants % beyond its callers', offender;
  END IF;

  -- The export login: exactly its attributes, a member of nothing, and only
  -- the creator's ADMIN-only row in it.
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_audit_export';
  IF NOT FOUND OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolinherit OR r.rolreplication OR r.rolbypassrls OR r.rolconnlimit <> 2
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                 WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option))
     OR NOT pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'migration 109: login jale_job_audit_export is not as created';
  END IF;

  -- Every jale_audit table carries the guard, enabled, before each row
  -- change and before TRUNCATE.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'jale_audit'::regnamespace AND c.relkind IN ('r', 'p')
     AND (SELECT count(*) FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
           JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
          WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND pn.nspname = 'jale_audit' AND p.proname = 'reject_change'
            AND ((t.tgtype & 1 = 1 AND t.tgtype & 2 = 2 AND t.tgtype & (4 | 8 | 16 | 32) = (8 | 16))
                 OR (t.tgtype & 1 = 0 AND t.tgtype & 2 = 2 AND t.tgtype & (4 | 8 | 16 | 32) = 32))) <> 2;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 109: % must carry the append-only guard', offender;
  END IF;

  -- No privilege on any jale_audit table or sequence for anyone but the
  -- owner; no row security; no foreign key.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'jale_audit'::regnamespace AND c.relkind IN ('r', 'p', 'S')
     AND (pg_catalog.pg_get_userbyid(c.relowner) <> 'jale_audit_owner'
          OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                      WHERE a.grantee <> c.relowner)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 109: a role other than the owner holds a privilege on %', offender;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'jale_audit'::regnamespace AND c.relkind IN ('r', 'p')
     AND (c.relrowsecurity OR c.relforcerowsecurity
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                      WHERE k.contype = 'f' AND (k.conrelid = c.oid OR k.confrelid = c.oid)));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 109: % must have no row security and no foreign key', offender;
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_audit.record_event(jsonb)', true, ARRAY['jale_api', 'jale_whatsapp', 'jale_admin_console']),
      ('jale_audit.history_search(jsonb, jsonb, integer, timestamp with time zone)', true, ARRAY['jale_admin_console']),
      ('jale_audit.reveal_count(integer)', true, ARRAY['jale_admin_console']),
      ('jale_audit.export_window(text)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.export_rows(text, xid8, xid8, bigint, integer)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.export_commit(text, xid8, xid8, integer, bigint, bigint, bytea, text, bigint[])', true,
       ARRAY['jale_job_audit_export']),
      ('jale_audit.export_released(text, integer)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.export_commit_release(text, bigint[], bytea, text)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.compare_window(text, xid8, xid8, bigint[])', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.purge_expired(integer)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.export_backlog(text)', true, ARRAY['jale_job_audit_export']),
      ('jale_audit.release_hold(text, bigint)', true, ARRAY['jale_admin']),
      ('jale_audit.redact_and_release(text, bigint)', true, ARRAY['jale_admin']),
      ('jale_audit.reject_change()', true, ARRAY[]::TEXT[]),
      ('jale_audit.json_text(jsonb, text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.json_uuid(jsonb, text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.json_uuid_list(jsonb, text, integer, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.json_text_list(jsonb, text, integer, text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.json_integer(jsonb, text, bigint, bigint, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.json_timestamptz(jsonb, text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.utc_text(timestamp with time zone)', false, ARRAY[]::TEXT[]),
      ('jale_audit.event_line(jale_audit.events)', false, ARRAY[]::TEXT[]),
      ('jale_audit.change_line(jale_audit.changes)', false, ARRAY[]::TEXT[]),
      ('jale_audit.require_stream(text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.require_window(xid8, xid8, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.require_object_key(text, text, text)', false, ARRAY[]::TEXT[]),
      ('jale_audit.window_rows(text, xid8, xid8, bigint, integer)', false, ARRAY[]::TEXT[]),
      ('jale_audit.listed_rows(text, bigint[])', false, ARRAY[]::TEXT[]),
      ('jale_audit.last_digest(text)', false, ARRAY[]::TEXT[])
    ) AS t(signature, definer, callers)
  LOOP
    -- A catalog lookup, not to_regprocedure, so the check does not depend on
    -- the session's USAGE on jale_audit.
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' = spec.signature;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer, p.proconfig AS config
      INTO info
      FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM 'jale_audit_owner'
       OR info.definer IS DISTINCT FROM spec.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'migration 109: % has the wrong owner, security or search_path', spec.signature;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR NOT (pg_catalog.pg_get_userbyid(a.grantee) = ANY (spec.callers)));
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 109: % is executable by a role outside its callers (%)', spec.signature, offender;
    END IF;
    FOREACH offender IN ARRAY spec.callers LOOP
      IF NOT pg_catalog.has_function_privilege(offender, fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 109: % is not executable by %', spec.signature, offender;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
