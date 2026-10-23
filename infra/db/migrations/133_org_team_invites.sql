-- ============================================================
-- 133_org_team_invites.sql
-- Run manually AFTER 132_job_limit_increase.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 3 milestone A, part 1: team invites
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Invites and sign-up").
--
-- (1) THE CAPABILITY OWNER. A new NOLOGIN owner, jale_cap_org_team
--     (107/125/128's pattern), owns every function below. It holds USAGE on
--     jale_cap (its definers call its own internal helper by name) and
--     CREATE (to own them); jale_billing gets USAGE on jale_cap for the
--     mail purge.
-- (2) THE INVITE DEFINERS, each SECURITY DEFINER with a pinned search_path
--     and exactly one caller:
--       org_team_invite_create / _resend / _revoke / _queue_email (jale_api,
--         the company's active owner): every one first takes the company
--         lock through org_team_locked_owner_org(), 128's organizations row
--         FOR NO KEY UPDATE, with the owner re-checked after the lock;
--       org_team_invite_lookup (jale_api_public): the invite page's read,
--         by token hash, no lock and no caller;
--       org_team_invite_accept (jale_api, by token) and
--       org_team_invite_accept_email (jale_api, by the confirmed email, for
--         post-confirmation): lock the invite's company, re-read the invite
--         (accept by its token too, so a token a resend rotated while the
--         accept waited fails), and make the caller an active foreman;
--       org_team_invite_mail_purge (jale_billing's scheduled job): deletes
--         sent invite mail a day old, on 108's terms.
--     Outcomes are codes, never exceptions; a malformed argument raises
--     22023 and a missing caller context 42501. Seats held are the active
--     foremen plus the live pending invites (billing-suspended foremen hold
--     none, as in 128). A create or resend whose invite email belongs to a
--     removed member of the company returns their cognito_sub (the handler
--     enables them); a revoke returns it when no live invite for that email
--     remains (the handler disables them).
-- (3) NO ROW LOCKS. Under a definer's UPDATE policies a row-locking read
--     silently skips a row that fails the policy (128). The only lock taken
--     is the company row's, whose UPDATE policy is USING (true); every
--     writer of organization_invites and organization_members holds it
--     (128's enforcer and restorer included), so the plain reads after it
--     see settled rows. Every UPDATE names a row already classified and
--     checks ROW_COUNT = 1.
-- (4) THE INVITE EMAIL. Every create and resend writes one email_outbox row
--     (source_type organization_invite, source_id the invite) through
--     org_team_invite_queue_email, in the same transaction: the recipient is
--     the invite's own email. The body carries the raw token, so only the
--     capability owner and the email sender read it; jale_api holds no right
--     on email_outbox. The rows also count the sends: 20 per company and 5
--     resends per invite in any 24 hours. A partial index on invite mail
--     (source_id, created_at) keeps those counts off a full outbox scan
--     while the company lock is held. The invites table stores only the
--     token's SHA-256. organization_invites.last_sent_at (new, NOT NULL
--     DEFAULT now()) carries the 60-second resend cooldown.
-- No runtime login gains any right on organizations or organization_invites.
--
-- LOCK ORDER. Everything on organization_members, users and email_outbox
-- (their grants, policies and the invite-mail index) is the last section.
-- CREATE POLICY takes ACCESS EXCLUSIVE on its table, so from each policy
-- until COMMIT every read and every write of organization_members, users
-- and email_outbox waits. The invite-mail index is built before the
-- outbox's policies (members and users are already locked by then): its
-- SHARE lock holds back only the outbox's writes, and its reads wait only
-- from the first outbox policy. Apply in a quiet window.
--
-- REPLAY: refused once jale_cap.org_team_invite_accept exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 133: connect as the migration login itself, without SET ROLE';
  END IF;
  IF to_regprocedure('jale_cap.org_team_invite_accept(bytea)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 133: already applied (jale_cap.org_team_invite_accept exists); it is not re-runnable';
  END IF;
  IF to_regprocedure('public.jobs_assignee_must_be_active()') IS NULL THEN
    RAISE EXCEPTION 'migration 133: apply 129 first';
  END IF;
  IF to_regprocedure('jale_cap.employer_org_usage(boolean)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_invites'::regclass
                     AND polname = 'organization_invites_billing_job_enforcer_update') THEN
    RAISE EXCEPTION 'migration 133: 128''s company lock and invite enforcer are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.organization_invites'::regclass
              AND attname = 'last_sent_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'migration 133: organization_invites.last_sent_at already exists';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('jale_api', 'jale_api_public', 'jale_billing')) <> 3
     OR to_regnamespace('jale_cap') IS NULL THEN
    RAISE EXCEPTION 'migration 133: a schema or role it builds on is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('public.employer_display_name(uuid)')
                    AND r.rolname = 'jale_admin' AND p.prosecdef) THEN
    RAISE EXCEPTION 'migration 133: public.employer_display_name(uuid) is missing or not a jale_admin definer';
  END IF;
  -- 118's tables as applied: one pending invite per (company, email), the
  -- email stored lower(btrim()), the token a 32-byte hash, and one
  -- membership per login (the members primary key).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'organization_invites_one_pending'
                  AND indexdef = 'CREATE UNIQUE INDEX organization_invites_one_pending ON public.organization_invites USING btree (organization_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL))')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.organization_members'::regclass AND c.contype = 'p' AND c.conname = 'organization_members_pkey'
                       AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.organization_invites'::regclass AND c.contype = 'c'
                       AND pg_get_constraintdef(c.oid) = 'CHECK (((email <> ''''::text) AND (email = lower(btrim(email)))))')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.organization_invites'::regclass AND c.contype = 'c'
                       AND pg_get_constraintdef(c.oid) = 'CHECK ((octet_length(token_hash) = 32))') THEN
    RAISE EXCEPTION 'migration 133: organization_invites or organization_members are not as 118 left them';
  END IF;
END $$;

-- ── 1. The capability owner (107/125/128's pattern) ─────────
DO $$
DECLARE
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = 'jale_cap_org_team';
  IF NOT FOUND THEN
    CREATE ROLE jale_cap_org_team NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = 'jale_cap_org_team';
  END IF;

  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
     OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'migration 133: existing role jale_cap_org_team has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.member = helper.oid
        OR (am.roleid = helper.oid
            AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                     AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
  ) THEN
    RAISE EXCEPTION 'migration 133: role jale_cap_org_team has unsafe memberships';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = helper.oid
       AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND am.admin_option
  ) THEN
    EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', 'jale_cap_org_team', current_user);
  END IF;
END $$;

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the function's schema.
GRANT CREATE ON SCHEMA jale_cap TO jale_cap_org_team;
-- Its definers call jale_cap.org_team_locked_owner_org() by name (a capability
-- owner holds no USAGE on jale_cap by default, 128); jale_billing calls the purge.
GRANT USAGE ON SCHEMA jale_cap TO jale_cap_org_team, jale_billing;

-- ── 2. Organizations and invites ────────────────────────────
-- Columns only. The boundary is each function's caller check, as in 128's
-- enforcer: the policies are open to the capability owner.
GRANT SELECT (id), UPDATE (updated_at) ON public.organizations TO jale_cap_org_team;
GRANT SELECT (id, organization_id, email, contact_name, token_hash, invited_by, created_at, expires_at, accepted_at, revoked_at),
      INSERT (organization_id, email, contact_name, token_hash, invited_by, expires_at),
      UPDATE (token_hash, expires_at, revoked_at, accepted_at)
  ON public.organization_invites TO jale_cap_org_team;
CREATE POLICY organizations_cap_org_team_select ON public.organizations AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
-- The lock: FOR NO KEY UPDATE needs the row to pass this USING; true, so it never drops the row.
CREATE POLICY organizations_cap_org_team_lock   ON public.organizations AS PERMISSIVE FOR UPDATE TO jale_cap_org_team USING (true) WITH CHECK (true);
CREATE POLICY organization_invites_cap_org_team_select ON public.organization_invites AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
CREATE POLICY organization_invites_cap_org_team_insert ON public.organization_invites AS PERMISSIVE FOR INSERT TO jale_cap_org_team
  WITH CHECK (accepted_at IS NULL AND revoked_at IS NULL);
-- Only a pending invite changes. Definers never row-lock invites (Global Constraints): they read
-- plainly under the company lock and update only a row they classified as pending.
CREATE POLICY organization_invites_cap_org_team_update ON public.organization_invites AS PERMISSIVE FOR UPDATE TO jale_cap_org_team
  USING (accepted_at IS NULL AND revoked_at IS NULL) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION public.employer_display_name(uuid) TO jale_cap_org_team;  -- by jale_admin, its owner

-- ── 3. The invites column ───────────────────────────────────
-- The last send (create or resend): the 60-second resend cooldown, and the
-- proof queue_email asks for (a pending invite sent in this transaction).
ALTER TABLE public.organization_invites ADD COLUMN last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now();
COMMENT ON COLUMN public.organization_invites.last_sent_at IS
  'When the invite email was last sent: set by the create (its default) and by every resend (133). Drives the 60-second resend cooldown; org_team_invite_queue_email accepts only an invite whose last_sent_at is the current transaction''s now().';
GRANT SELECT (last_sent_at), INSERT (last_sent_at), UPDATE (last_sent_at) ON public.organization_invites TO jale_cap_org_team;

-- ── 4. Functions ────────────────────────────────────────────
-- Created as jale_admin, closed to PUBLIC, granted to their one caller before
-- the transfer (128's pattern: ALTER ... OWNER TO makes the new owner the
-- grantor), then transferred inside the owner's window. The bodies name
-- organization_members, users and email_outbox, whose rights section 5
-- grants: PL/pgSQL resolves names when a statement first runs.

-- The caller's company if they are its active owner, locked FOR NO KEY UPDATE (128's lock),
-- the owner re-checked after the lock in a new statement; NULL otherwise. No grant: internal.
CREATE FUNCTION jale_cap.org_team_locked_owner_org()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_org    UUID;
BEGIN
  IF v_caller IS NULL OR v_caller !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT m.organization_id INTO v_org FROM public.organization_members m
   WHERE m.user_id = v_caller::uuid AND m.role = 'owner' AND m.status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = v_org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.organization_members m
   WHERE m.user_id = v_caller::uuid AND m.organization_id = v_org AND m.role = 'owner' AND m.status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_org;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_create(p_email TEXT, p_contact_name TEXT, p_token_hash BYTEA, p_seat_limit INTEGER)
RETURNS TABLE (
  outcome      TEXT,
  invite_id    UUID,
  email        TEXT,
  contact_name TEXT,
  created_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  company_name TEXT,
  cognito_sub  TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller  TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_name    TEXT := NULLIF(pg_catalog.btrim(p_contact_name), '');
  v_email   TEXT := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_org     UUID;
  v_users   INTEGER;
  v_user    RECORD;
  v_sub     TEXT;
  v_pending RECORD;
  v_sends   INTEGER;
  v_seats   INTEGER;
  v_id      UUID;
  v_created TIMESTAMPTZ;
  v_expires TIMESTAMPTZ;
  v_last    TIMESTAMPTZ;
  v_n       INTEGER;
BEGIN
  -- 1. The arguments.
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'org_team_invite_create: the token hash must be 32 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_seat_limit IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'org_team_invite_create: the seat limit must be a non-negative integer' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pg_catalog.char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'org_team_invite_create: the contact name is longer than 120 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 2. The company lock, for its active owner only.
  v_org := jale_cap.org_team_locked_owner_org();
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 3. The email, normalised as 118 stores it.
  IF v_email IS NULL OR pg_catalog.char_length(v_email) > 254
     OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN QUERY SELECT 'invalid_email'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 4. Who already has that email: no employer login, or one with no
  --    membership, or a removed member of this company (enabled again by the
  --    handler) may be invited; anyone else may not.
  SELECT pg_catalog.count(*)::integer INTO v_users
    FROM public.users u
   WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_email;
  IF v_users > 1 THEN
    RETURN QUERY SELECT 'email_in_use'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_users = 1 THEN
    SELECT u.id, u.cognito_sub, m.organization_id, m.status INTO v_user
      FROM public.users u
      LEFT JOIN public.organization_members m ON m.user_id = u.id
     WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_email;
    IF v_user.id = v_caller::uuid
       OR (v_user.organization_id = v_org AND v_user.status IN ('active', 'suspended')) THEN
      RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                          NULL::timestamptz, NULL::text, NULL::text;
      RETURN;
    END IF;
    IF v_user.organization_id IS NOT NULL AND v_user.organization_id <> v_org THEN
      RETURN QUERY SELECT 'email_in_use'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                          NULL::timestamptz, NULL::text, NULL::text;
      RETURN;
    END IF;
    IF v_user.organization_id = v_org THEN
      v_sub := v_user.cognito_sub;  -- a removed member of this company
    END IF;
  END IF;

  -- 5. The pending invite for this email: a live one blocks; an expired one
  --    is revoked, so the one-pending index lets the new one in.
  SELECT i.id, i.expires_at INTO v_pending
    FROM public.organization_invites i
   WHERE i.organization_id = v_org AND i.email = v_email AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
  IF FOUND THEN
    IF v_pending.expires_at > pg_catalog.now() THEN
      RETURN QUERY SELECT 'invite_pending'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                          NULL::timestamptz, NULL::text, NULL::text;
      RETURN;
    END IF;
    UPDATE public.organization_invites i SET revoked_at = pg_catalog.now()
     WHERE i.id = v_pending.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_create: invite changed under the company lock' USING ERRCODE = 'P0001'; END IF;
  END IF;

  -- 6. The company's sends (creates and resends) in the last 24 hours.
  SELECT pg_catalog.count(*)::integer INTO v_sends
    FROM public.email_outbox o
   WHERE o.source_type = 'organization_invite'
     AND o.created_at > pg_catalog.now() - interval '24 hours'
     AND o.source_id IN (SELECT i.id FROM public.organization_invites i WHERE i.organization_id = v_org);
  IF v_sends >= 20 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 7. Seats held: active foremen and live pending invites.
  SELECT (SELECT pg_catalog.count(*) FROM public.organization_members m
           WHERE m.organization_id = v_org AND m.role = 'foreman' AND m.status = 'active')
       + (SELECT pg_catalog.count(*) FROM public.organization_invites i
           WHERE i.organization_id = v_org
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now())
    INTO v_seats;
  IF v_seats >= p_seat_limit THEN
    RETURN QUERY SELECT 'seat_limit_reached'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 8. The invite; last_sent_at defaults to now().
  INSERT INTO public.organization_invites AS i (organization_id, email, contact_name, token_hash, invited_by, expires_at)
  VALUES (v_org, v_email, v_name, p_token_hash, v_caller::uuid, pg_catalog.now() + interval '7 days')
  RETURNING i.id, i.created_at, i.expires_at, i.last_sent_at INTO v_id, v_created, v_expires, v_last;

  -- 9. The company's name, as every Phase 3 reader shows it.
  RETURN QUERY SELECT 'created'::text, v_id, v_email, v_name, v_created, v_expires, v_last,
                      public.employer_display_name(v_caller::uuid), v_sub;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_resend(p_invite_id UUID, p_token_hash BYTEA, p_seat_limit INTEGER)
RETURNS TABLE (
  outcome             TEXT,
  invite_id           UUID,
  email               TEXT,
  contact_name        TEXT,
  created_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  last_sent_at        TIMESTAMPTZ,
  company_name        TEXT,
  cognito_sub         TEXT,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller  TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_org     UUID;
  v_inv     RECORD;
  v_users   INTEGER;
  v_user    RECORD;
  v_sub     TEXT;
  v_resends INTEGER;
  v_sends   INTEGER;
  v_seats   INTEGER;
  v_expires TIMESTAMPTZ;
  v_last    TIMESTAMPTZ;
  v_n       INTEGER;
  v_outcome TEXT;
  v_retry   INTEGER;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'org_team_invite_resend: the token hash must be 32 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_seat_limit IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'org_team_invite_resend: the seat limit must be a non-negative integer' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. The company lock, for its active owner only.
  v_org := jale_cap.org_team_locked_owner_org();
  IF v_org IS NULL THEN
    v_outcome := 'not_owner';
  ELSE
    -- 2. The invite, of this company only.
    SELECT i.id, i.email, i.contact_name, i.created_at, i.expires_at, i.last_sent_at, i.accepted_at, i.revoked_at
      INTO v_inv
      FROM public.organization_invites i
     WHERE i.id = p_invite_id AND i.organization_id = v_org;
    IF NOT FOUND THEN
      v_outcome := 'not_found';
    ELSIF v_inv.accepted_at IS NOT NULL OR v_inv.revoked_at IS NOT NULL THEN
      v_outcome := 'closed';
    -- 3. The cooldown, before both caps.
    ELSIF v_inv.last_sent_at > pg_catalog.now() - interval '60 seconds' THEN
      v_outcome := 'too_soon';
      v_retry := LEAST(60, GREATEST(1, pg_catalog.ceil(60 - pg_catalog.date_part('epoch', pg_catalog.now() - v_inv.last_sent_at))::integer));
    END IF;
  END IF;
  IF v_outcome IS NOT NULL THEN
    RETURN QUERY SELECT v_outcome, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text, v_retry;
    RETURN;
  END IF;

  -- 4. This invite's resends (its mail after the create's) and the company's
  --    sends, in the last 24 hours.
  SELECT pg_catalog.count(*)::integer INTO v_resends
    FROM public.email_outbox o
   WHERE o.source_type = 'organization_invite' AND o.source_id = v_inv.id
     AND o.created_at > v_inv.created_at
     AND o.created_at > pg_catalog.now() - interval '24 hours';
  SELECT pg_catalog.count(*)::integer INTO v_sends
    FROM public.email_outbox o
   WHERE o.source_type = 'organization_invite'
     AND o.created_at > pg_catalog.now() - interval '24 hours'
     AND o.source_id IN (SELECT i.id FROM public.organization_invites i WHERE i.organization_id = v_org);
  IF v_resends >= 5 OR v_sends >= 20 THEN
    v_outcome := 'rate_limited';
  ELSE
    -- 5. The email rules of create.
    SELECT pg_catalog.count(*)::integer INTO v_users
      FROM public.users u
     WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_inv.email;
    IF v_users > 1 THEN
      v_outcome := 'email_in_use';
    ELSIF v_users = 1 THEN
      SELECT u.id, u.cognito_sub, m.organization_id, m.status INTO v_user
        FROM public.users u
        LEFT JOIN public.organization_members m ON m.user_id = u.id
       WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_inv.email;
      IF v_user.id = v_caller::uuid
         OR (v_user.organization_id = v_org AND v_user.status IN ('active', 'suspended')) THEN
        v_outcome := 'already_member';
      ELSIF v_user.organization_id IS NOT NULL AND v_user.organization_id <> v_org THEN
        v_outcome := 'email_in_use';
      ELSIF v_user.organization_id = v_org THEN
        v_sub := v_user.cognito_sub;  -- a removed member of this company
      END IF;
    END IF;
  END IF;
  IF v_outcome IS NULL AND v_inv.expires_at <= pg_catalog.now() THEN
    -- 6. An expired invite comes back to life: it needs a free seat (the
    --    other live invites and the active foremen hold theirs).
    SELECT (SELECT pg_catalog.count(*) FROM public.organization_members m
             WHERE m.organization_id = v_org AND m.role = 'foreman' AND m.status = 'active')
         + (SELECT pg_catalog.count(*) FROM public.organization_invites i
             WHERE i.organization_id = v_org AND i.id <> v_inv.id
               AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now())
      INTO v_seats;
    IF v_seats >= p_seat_limit THEN
      v_outcome := 'seat_limit_reached';
    END IF;
  END IF;
  IF v_outcome IS NOT NULL THEN
    RETURN QUERY SELECT v_outcome, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
                        NULL::timestamptz, NULL::text, NULL::text, NULL::integer;
    RETURN;
  END IF;

  -- 7. A new token, a new week, a new send.
  UPDATE public.organization_invites i
     SET token_hash = p_token_hash, expires_at = pg_catalog.now() + interval '7 days', last_sent_at = pg_catalog.now()
   WHERE i.id = v_inv.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  RETURNING i.expires_at, i.last_sent_at INTO v_expires, v_last;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_resend: invite changed under the company lock' USING ERRCODE = 'P0001'; END IF;

  RETURN QUERY SELECT 'resent'::text, v_inv.id, v_inv.email, v_inv.contact_name, v_inv.created_at, v_expires, v_last,
                      public.employer_display_name(v_caller::uuid), v_sub, NULL::integer;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_revoke(p_invite_id UUID)
RETURNS TABLE (outcome TEXT, cognito_sub TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_org  UUID;
  v_inv  RECORD;
  v_subs TEXT[];
  v_n    INTEGER;
BEGIN
  v_org := jale_cap.org_team_locked_owner_org();
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::text; RETURN;
  END IF;

  SELECT i.id, i.email, i.accepted_at, i.revoked_at INTO v_inv
    FROM public.organization_invites i
   WHERE i.id = p_invite_id AND i.organization_id = v_org;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN;
  END IF;
  IF v_inv.accepted_at IS NOT NULL OR v_inv.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'closed'::text, NULL::text; RETURN;
  END IF;

  UPDATE public.organization_invites i SET revoked_at = pg_catalog.now()
   WHERE i.id = v_inv.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_revoke: invite changed under the company lock' USING ERRCODE = 'P0001'; END IF;

  -- A removed member of this company re-invited with this email is
  -- disabled again. The rule is "unless another live invite of this company
  -- for that email remains", and organization_invites_one_pending (118)
  -- allows one pending invite per (company, email): the one just revoked.
  -- So none remains, and the sub is always returned. Another company's
  -- invite never re-enables this login (create and resend give it
  -- email_in_use), so it does not count.
  SELECT pg_catalog.array_agg(u.cognito_sub) INTO v_subs
    FROM public.users u
    JOIN public.organization_members m ON m.user_id = u.id
   WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_inv.email
     AND m.organization_id = v_org AND m.status = 'removed';
  RETURN QUERY SELECT 'revoked'::text, CASE WHEN pg_catalog.cardinality(v_subs) = 1 THEN v_subs[1] END;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_queue_email(p_invite_id UUID, p_subject TEXT, p_body_text TEXT, p_body_html TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_org UUID;
  v_inv RECORD;
  v_id  UUID;
BEGIN
  v_org := jale_cap.org_team_locked_owner_org();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'org_team_invite_queue_email: the caller is not the active owner of a company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Pending, and sent in this transaction: a create or a resend set
  -- last_sent_at to this transaction's now().
  SELECT i.id, i.email, i.token_hash INTO v_inv
    FROM public.organization_invites i
   WHERE i.id = p_invite_id AND i.organization_id = v_org
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.last_sent_at = pg_catalog.now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_team_invite_queue_email: no invite was sent in this transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.email_outbox AS o (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key)
  VALUES (v_inv.email, p_subject, p_body_text, p_body_html, 'organization_invite', v_inv.id,
          'org-invite:' || v_inv.id::text || ':' || pg_catalog.encode(pg_catalog.substr(v_inv.token_hash, 1, 8), 'hex'))
  RETURNING o.id INTO v_id;
  RETURN v_id;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_lookup(p_token_hash BYTEA)
RETURNS TABLE (
  outcome          TEXT,
  company_name     TEXT,
  email            TEXT,
  contact_name     TEXT,
  existing_account BOOLEAN,
  expires_at       TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_inv     RECORD;
  v_outcome TEXT;
BEGIN
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    v_outcome := 'not_found';
  ELSE
    SELECT i.email, i.contact_name, i.invited_by, i.expires_at, i.accepted_at, i.revoked_at INTO v_inv
      FROM public.organization_invites i
     WHERE i.token_hash = p_token_hash;
    IF NOT FOUND THEN
      v_outcome := 'not_found';
    ELSIF v_inv.accepted_at IS NOT NULL THEN
      v_outcome := 'used';
    ELSIF v_inv.revoked_at IS NOT NULL THEN
      v_outcome := 'revoked';
    ELSIF v_inv.expires_at <= pg_catalog.now() THEN
      v_outcome := 'expired';
    END IF;
  END IF;
  IF v_outcome IS NOT NULL THEN
    RETURN QUERY SELECT v_outcome, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'valid'::text, public.employer_display_name(v_inv.invited_by), v_inv.email::text, v_inv.contact_name::text,
         EXISTS (SELECT 1 FROM public.users u
                  WHERE u.user_type = 'employer' AND pg_catalog.lower(pg_catalog.btrim(u.email)) = v_inv.email),
         v_inv.expires_at::timestamptz;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invite_accept(p_token_hash BYTEA)
RETURNS TABLE (outcome TEXT, organization_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_sub     TEXT := pg_catalog.current_setting('app.current_user_id', true);
  v_org     UUID;
  v_inv     RECORD;
  v_user    RECORD;
  v_member  RECORD;
  v_outcome TEXT;
  v_n       INTEGER;
  v_constraint TEXT;
BEGIN
  IF v_sub IS NULL OR v_sub = '' THEN
    RAISE EXCEPTION 'org_team_invite_accept: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN;
  END IF;
  SELECT i.organization_id INTO v_org FROM public.organization_invites i WHERE i.token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;

  -- 128's order: the company first. Every writer of invites and members holds this lock, so
  -- the plain reads below see the settled rows. No row lock: under the UPDATE policies a
  -- row-locking read would silently skip a closed invite or an owner's membership.
  PERFORM 1 FROM public.organizations o WHERE o.id = v_org FOR NO KEY UPDATE;
  -- Re-read by the token too: a resend that committed while we waited rotated it.
  SELECT i.id, i.email, i.invited_by, i.expires_at, i.accepted_at, i.revoked_at
    INTO v_inv FROM public.organization_invites i
   WHERE i.organization_id = v_org AND i.token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  IF v_inv.accepted_at IS NOT NULL THEN RETURN QUERY SELECT 'used'::text, NULL::uuid; RETURN; END IF;
  IF v_inv.revoked_at IS NOT NULL THEN RETURN QUERY SELECT 'revoked'::text, NULL::uuid; RETURN; END IF;
  IF v_inv.expires_at <= pg_catalog.now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid; RETURN; END IF;

  SELECT u.id, u.user_type, pg_catalog.lower(pg_catalog.btrim(u.email)) AS email
    INTO v_user FROM public.users u WHERE u.cognito_sub = v_sub;
  IF NOT FOUND OR v_user.user_type IS DISTINCT FROM 'employer' THEN
    RETURN QUERY SELECT 'not_employer'::text, NULL::uuid; RETURN;
  END IF;
  IF v_user.email IS DISTINCT FROM v_inv.email THEN
    RETURN QUERY SELECT 'email_mismatch'::text, NULL::uuid; RETURN;
  END IF;

  SELECT m.organization_id, m.role, m.status INTO v_member
    FROM public.organization_members m WHERE m.user_id = v_user.id;
  IF NOT FOUND THEN
    -- No company lock covers the caller's other companies: an accept of
    -- another company's invite (or a start-company) for the same login may
    -- commit first. Its row wins the members primary key; this one is
    -- already_member, never an error. Any other unique violation re-raises.
    BEGIN
      INSERT INTO public.organization_members (user_id, organization_id, role, status, invited_by, joined_at, status_changed_at)
      VALUES (v_user.id, v_org, 'foreman', 'active', v_inv.invited_by, pg_catalog.now(), pg_catalog.now());
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'organization_members_pkey' THEN
        RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
      END IF;
      RAISE;
    END;
    v_outcome := 'accepted';
  ELSIF v_member.organization_id = v_org AND v_member.role = 'foreman' AND v_member.status = 'removed' THEN
    -- billing_suspended_at = NULL is defensive: 128's CHECK already forbids
    -- the mark on a removed row.
    UPDATE public.organization_members m
       SET status = 'active', billing_suspended_at = NULL, invited_by = v_inv.invited_by,
           joined_at = pg_catalog.now(), status_changed_at = pg_catalog.now()
     WHERE m.user_id = v_user.id AND m.status = 'removed';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_accept: membership changed under the company lock' USING ERRCODE = 'P0001'; END IF;
    v_outcome := 'rejoined';
  ELSE
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
  END IF;

  UPDATE public.organization_invites i SET accepted_at = pg_catalog.now()
   WHERE i.id = v_inv.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_accept: invite changed under the company lock' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT v_outcome, v_org;
END;
$fn$;

-- Post-confirmation without a usable token: the caller's single live invite
-- whose email is the caller's confirmed email.
CREATE FUNCTION jale_cap.org_team_invite_accept_email()
RETURNS TABLE (outcome TEXT, organization_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_sub    TEXT := pg_catalog.current_setting('app.current_user_id', true);
  v_user   RECORD;
  v_ids    UUID[];
  v_orgs   UUID[];
  v_invite UUID;
  v_org    UUID;
  v_inv    RECORD;
  v_n      INTEGER;
  v_constraint TEXT;
BEGIN
  IF v_sub IS NULL OR v_sub = '' THEN
    RAISE EXCEPTION 'org_team_invite_accept_email: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. The caller: an employer login with no membership.
  SELECT u.id, u.user_type, pg_catalog.lower(pg_catalog.btrim(u.email)) AS email
    INTO v_user FROM public.users u WHERE u.cognito_sub = v_sub;
  IF NOT FOUND OR v_user.user_type IS DISTINCT FROM 'employer' THEN
    RETURN QUERY SELECT 'not_employer'::text, NULL::uuid; RETURN;
  END IF;
  PERFORM 1 FROM public.organization_members m WHERE m.user_id = v_user.id;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
  END IF;

  -- 2. The live invites to that email, in one statement.
  SELECT COALESCE(pg_catalog.array_agg(i.id), ARRAY[]::UUID[]), COALESCE(pg_catalog.array_agg(i.organization_id), ARRAY[]::UUID[])
    INTO v_ids, v_orgs
    FROM public.organization_invites i
   WHERE i.email = v_user.email
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now();
  IF pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid; RETURN;
  END IF;
  IF pg_catalog.cardinality(v_ids) > 1 THEN
    RETURN QUERY SELECT 'ambiguous'::text, NULL::uuid; RETURN;
  END IF;
  v_invite := v_ids[1];
  v_org := v_orgs[1];

  -- 3. Its company's lock (128's order), then the invite and the caller
  --    again: a revoke, a downgrade or another accept may have committed
  --    while we waited.
  PERFORM 1 FROM public.organizations o WHERE o.id = v_org FOR NO KEY UPDATE;
  SELECT i.invited_by INTO v_inv
    FROM public.organization_invites i
   WHERE i.id = v_invite AND i.organization_id = v_org
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now();
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text, NULL::uuid; RETURN;
  END IF;
  PERFORM 1 FROM public.organization_members m WHERE m.user_id = v_user.id;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
  END IF;

  -- As in accept: a concurrent accept or start-company for this login in
  -- another company wins the members primary key; this one is already_member.
  BEGIN
    INSERT INTO public.organization_members (user_id, organization_id, role, status, invited_by, joined_at, status_changed_at)
    VALUES (v_user.id, v_org, 'foreman', 'active', v_inv.invited_by, pg_catalog.now(), pg_catalog.now());
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'organization_members_pkey' THEN
      RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
    END IF;
    RAISE;
  END;

  UPDATE public.organization_invites i SET accepted_at = pg_catalog.now()
   WHERE i.id = v_invite AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_invite_accept_email: invite changed under the company lock' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT 'accepted'::text, v_org;
END;
$fn$;

-- 108's terms (problem-report mail): a day after it was queued, once the
-- sender will no longer retry it.
CREATE FUNCTION jale_cap.org_team_invite_mail_purge(p_batch INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 1000 THEN
    RAISE EXCEPTION 'org_team_invite_mail_purge: the batch must be between 1 and 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH picked AS (
    SELECT o.id
      FROM public.email_outbox o
     WHERE o.source_type = 'organization_invite'
       AND o.created_at < pg_catalog.now() - interval '1 day'
       AND NOT (o.status IN ('pending', 'failed') AND o.attempt_count < 5)
     ORDER BY o.created_at, o.id
     LIMIT p_batch
  )
  DELETE FROM public.email_outbox o
   USING picked
   WHERE o.id = picked.id
     AND o.source_type = 'organization_invite'
     AND o.created_at < pg_catalog.now() - interval '1 day'
     AND NOT (o.status IN ('pending', 'failed') AND o.attempt_count < 5);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION jale_cap.org_team_locked_owner_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_create(text, text, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_resend(uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_revoke(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_queue_email(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_lookup(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_accept(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_accept_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invite_mail_purge(integer) FROM PUBLIC;
-- Granted before the transfer (128 :300-304): the owner becomes the grantor.
-- org_team_locked_owner_org gets no grant: only its owner's definers call it.
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_create(text, text, bytea, integer) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_resend(uuid, bytea, integer) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_revoke(uuid) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_queue_email(uuid, text, text, text) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_lookup(bytea) TO jale_api_public;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_accept(bytea) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_accept_email() TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invite_mail_purge(integer) TO jale_billing;

-- Transferred to their owner inside its window (128 :306-316).
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_org_team', current_user);
END $$;
ALTER FUNCTION jale_cap.org_team_locked_owner_org() OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_create(text, text, bytea, integer) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_resend(uuid, bytea, integer) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_revoke(uuid) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_queue_email(uuid, text, text, text) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_lookup(bytea) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_accept(bytea) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_accept_email() OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invite_mail_purge(integer) OWNER TO jale_cap_org_team;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_org_team', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_org_team', current_user, current_user);
END $$;

-- ── 5. Last: members, users, outbox ─────────────────────────
GRANT SELECT (user_id, organization_id, role, status, invited_by, joined_at, status_changed_at, billing_suspended_at),
      INSERT (user_id, organization_id, role, status, invited_by, joined_at, status_changed_at),
      UPDATE (status, billing_suspended_at, invited_by, joined_at, status_changed_at)
  ON public.organization_members TO jale_cap_org_team;
CREATE POLICY organization_members_cap_org_team_select ON public.organization_members AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
CREATE POLICY organization_members_cap_org_team_insert ON public.organization_members AS PERMISSIVE FOR INSERT TO jale_cap_org_team
  WITH CHECK (role = 'foreman' AND status = 'active');
-- Only foremen change here; an owner's row never does (role is not updatable, so WITH CHECK holds it).
CREATE POLICY organization_members_cap_org_team_update ON public.organization_members AS PERMISSIVE FOR UPDATE TO jale_cap_org_team
  USING (role = 'foreman') WITH CHECK (role = 'foreman');
GRANT SELECT (id, cognito_sub, user_type, email) ON public.users TO jale_cap_org_team;
CREATE POLICY users_cap_org_team_select ON public.users AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (user_type = 'employer');
GRANT SELECT (id, source_type, source_id, created_at, status, attempt_count),
      INSERT (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key),
      DELETE
  ON public.email_outbox TO jale_cap_org_team;
-- The send counts (20 per company, 5 resends per invite, 24 hours) run under
-- the company lock: read them by invite and time, not by scanning the outbox.
-- Built before the outbox's policies: its SHARE lock lets reads through.
CREATE INDEX email_outbox_organization_invite_sends ON public.email_outbox (source_id, created_at)
  WHERE source_type = 'organization_invite';
CREATE POLICY email_outbox_cap_org_team_select ON public.email_outbox AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (source_type = 'organization_invite');
CREATE POLICY email_outbox_cap_org_team_insert ON public.email_outbox AS PERMISSIVE FOR INSERT TO jale_cap_org_team WITH CHECK (source_type = 'organization_invite');
CREATE POLICY email_outbox_cap_org_team_delete ON public.email_outbox AS PERMISSIVE FOR DELETE TO jale_cap_org_team USING (source_type = 'organization_invite');

-- ── 6. Self-check ───────────────────────────────────────────
DO $$
DECLARE
  spec     RECORD;
  fn_oid   OID;
  info     RECORD;
  offender TEXT;
  v_grants TEXT[];
  v_login  TEXT;
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Every function: owner, definer, pinned path, language, exactly its caller
  -- (org_team_locked_owner_org: nobody but its owner).
  FOR spec IN
    SELECT * FROM (VALUES
      ('org_team_locked_owner_org', '', NULL),
      ('org_team_invite_create', 'p_email text, p_contact_name text, p_token_hash bytea, p_seat_limit integer', 'jale_api'),
      ('org_team_invite_resend', 'p_invite_id uuid, p_token_hash bytea, p_seat_limit integer', 'jale_api'),
      ('org_team_invite_revoke', 'p_invite_id uuid', 'jale_api'),
      ('org_team_invite_queue_email', 'p_invite_id uuid, p_subject text, p_body_text text, p_body_html text', 'jale_api'),
      ('org_team_invite_lookup', 'p_token_hash bytea', 'jale_api_public'),
      ('org_team_invite_accept', 'p_token_hash bytea', 'jale_api'),
      ('org_team_invite_accept_email', '', 'jale_api'),
      ('org_team_invite_mail_purge', 'p_batch integer', 'jale_billing')
    ) AS t(fn_name, fn_args, caller)
  LOOP
    fn_oid := NULL;
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'jale_cap' AND p.proname = spec.fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = spec.fn_args;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM 'jale_cap_org_team' OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 133: jale_cap.% has the wrong owner, security, search_path or language', spec.fn_name;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR spec.caller IS NULL OR pg_catalog.pg_get_userbyid(a.grantee) <> spec.caller);
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 133: jale_cap.% is executable by a role other than its owner and caller (%)', spec.fn_name, offender;
    END IF;
    IF spec.caller IS NOT NULL AND NOT has_function_privilege(spec.caller, fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 133: % cannot execute jale_cap.%', spec.caller, spec.fn_name;
    END IF;
  END LOOP;

  -- The twelve policies, each for exactly its role, and no other for it.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polpermissive AND p.polroles = ARRAY['jale_cap_org_team'::regrole::oid]
         AND (p.polrelid::regclass::text, p.polname) IN (
           ('public.organizations', 'organizations_cap_org_team_select'),
           ('public.organizations', 'organizations_cap_org_team_lock'),
           ('public.organization_invites', 'organization_invites_cap_org_team_select'),
           ('public.organization_invites', 'organization_invites_cap_org_team_insert'),
           ('public.organization_invites', 'organization_invites_cap_org_team_update'),
           ('public.organization_members', 'organization_members_cap_org_team_select'),
           ('public.organization_members', 'organization_members_cap_org_team_insert'),
           ('public.organization_members', 'organization_members_cap_org_team_update'),
           ('public.users', 'users_cap_org_team_select'),
           ('public.email_outbox', 'email_outbox_cap_org_team_select'),
           ('public.email_outbox', 'email_outbox_cap_org_team_insert'),
           ('public.email_outbox', 'email_outbox_cap_org_team_delete'))) <> 12
     OR (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)) <> 12 THEN
    RAISE EXCEPTION 'migration 133: the jale_cap_org_team policy set is not as reviewed';
  END IF;

  -- The capability owner: no login, nothing elevated, NOINHERIT, member of
  -- nothing, no SET or INHERIT window left, exactly its column rights, and
  -- DELETE on the invite mail only.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'jale_cap_org_team'
              AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
                   OR r.rolreplication OR r.rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members am
                 WHERE am.member = 'jale_cap_org_team'::regrole
                    OR (am.roleid = 'jale_cap_org_team'::regrole AND (am.inherit_option OR am.set_option))) THEN
    RAISE EXCEPTION 'migration 133: jale_cap_org_team has unsafe attributes or memberships';
  END IF;
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_invites'::regclass,
                   'public.organization_members'::regclass, 'public.users'::regclass, 'public.email_outbox'::regclass)
     AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'email_outbox:attempt_count:SELECT', 'email_outbox:body_html:INSERT', 'email_outbox:body_text:INSERT',
    'email_outbox:created_at:SELECT', 'email_outbox:id:SELECT', 'email_outbox:idempotency_key:INSERT',
    'email_outbox:recipient_email:INSERT', 'email_outbox:source_id:INSERT', 'email_outbox:source_id:SELECT',
    'email_outbox:source_type:INSERT', 'email_outbox:source_type:SELECT', 'email_outbox:status:SELECT',
    'email_outbox:subject:INSERT',
    'organization_invites:accepted_at:SELECT', 'organization_invites:accepted_at:UPDATE',
    'organization_invites:contact_name:INSERT', 'organization_invites:contact_name:SELECT',
    'organization_invites:created_at:SELECT', 'organization_invites:email:INSERT', 'organization_invites:email:SELECT',
    'organization_invites:expires_at:INSERT', 'organization_invites:expires_at:SELECT', 'organization_invites:expires_at:UPDATE',
    'organization_invites:id:SELECT', 'organization_invites:invited_by:INSERT', 'organization_invites:invited_by:SELECT',
    'organization_invites:last_sent_at:INSERT', 'organization_invites:last_sent_at:SELECT', 'organization_invites:last_sent_at:UPDATE',
    'organization_invites:organization_id:INSERT', 'organization_invites:organization_id:SELECT',
    'organization_invites:revoked_at:SELECT', 'organization_invites:revoked_at:UPDATE',
    'organization_invites:token_hash:INSERT', 'organization_invites:token_hash:SELECT', 'organization_invites:token_hash:UPDATE',
    'organization_members:billing_suspended_at:SELECT', 'organization_members:billing_suspended_at:UPDATE',
    'organization_members:invited_by:INSERT', 'organization_members:invited_by:SELECT', 'organization_members:invited_by:UPDATE',
    'organization_members:joined_at:INSERT', 'organization_members:joined_at:SELECT', 'organization_members:joined_at:UPDATE',
    'organization_members:organization_id:INSERT', 'organization_members:organization_id:SELECT',
    'organization_members:role:INSERT', 'organization_members:role:SELECT',
    'organization_members:status:INSERT', 'organization_members:status:SELECT', 'organization_members:status:UPDATE',
    'organization_members:status_changed_at:INSERT', 'organization_members:status_changed_at:SELECT',
    'organization_members:status_changed_at:UPDATE',
    'organization_members:user_id:INSERT', 'organization_members:user_id:SELECT',
    'organizations:id:SELECT', 'organizations:updated_at:UPDATE',
    'users:cognito_sub:SELECT', 'users:email:SELECT', 'users:id:SELECT', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 133: jale_cap_org_team column rights are not as reviewed (%)', v_grants;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c
              WHERE c.relkind IN ('r', 'p') AND c.oid <> 'public.email_outbox'::regclass
                AND has_table_privilege('jale_cap_org_team', c.oid, 'DELETE, TRUNCATE, TRIGGER'))
     OR NOT has_table_privilege('jale_cap_org_team', 'public.email_outbox', 'DELETE')
     OR NOT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'USAGE')
     OR NOT has_schema_privilege('jale_billing', 'jale_cap', 'USAGE')
     OR NOT has_function_privilege('jale_cap_org_team', 'public.employer_display_name(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 133: jale_cap_org_team table, schema or function rights are not as reviewed';
  END IF;

  -- No runtime login holds a right on organizations or organization_invites
  -- (118's login list, and the logins added since).
  FOREACH v_login IN ARRAY ARRAY[
    'jale_api', 'jale_api_public', 'jale_job_email_sender', 'jale_job_visibility_drain', 'jale_job_digest',
    'jale_job_ses_feedback', 'jale_job_retention', 'jale_posture', 'jale_whatsapp', 'jale_ai', 'jale_billing',
    'jale_public_jobs', 'jale_matching', 'jale_admin_console',
    'jale_api_public_reports', 'jale_job_report_cleanup', 'jale_job_audit_export'
  ] LOOP
    CONTINUE WHEN to_regrole(v_login) IS NULL;
    IF has_table_privilege(v_login, 'public.organizations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_login, 'public.organizations', 'SELECT, INSERT, UPDATE, REFERENCES')
       OR has_table_privilege(v_login, 'public.organization_invites', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_login, 'public.organization_invites', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'migration 133: login % holds a right on organizations or organization_invites', v_login;
    END IF;
  END LOOP;
  -- And the request logins none on the invite mail.
  IF has_any_column_privilege('jale_api', 'public.email_outbox', 'SELECT, INSERT, UPDATE')
     OR has_any_column_privilege('jale_api_public', 'public.email_outbox', 'SELECT, INSERT, UPDATE')
     OR has_table_privilege('jale_api', 'public.email_outbox', 'DELETE, TRUNCATE')
     OR has_table_privilege('jale_api_public', 'public.email_outbox', 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'migration 133: a request login holds a right on email_outbox';
  END IF;

  -- The send counts' index.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'email_outbox_organization_invite_sends'
                  AND indexdef = 'CREATE INDEX email_outbox_organization_invite_sends ON public.email_outbox USING btree (source_id, created_at) WHERE (source_type = ''organization_invite''::text)') THEN
    RAISE EXCEPTION 'migration 133: email_outbox_organization_invite_sends is missing or drifted';
  END IF;

  -- The new column.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.organization_invites'::regclass AND a.attname = 'last_sent_at'
                    AND a.atttypid = 'timestamptz'::regtype AND a.attnotnull AND NOT a.attisdropped
                    AND pg_get_expr(d.adbin, d.adrelid) = 'now()') THEN
    RAISE EXCEPTION 'migration 133: organization_invites.last_sent_at is missing or not NOT NULL DEFAULT now()';
  END IF;

  -- Every window is closed.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname = 'jale_cap_org_team' AND u.rolname = current_user AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'migration 133: the jale_cap_org_team window was left open';
  END IF;
END $$;

COMMIT;
