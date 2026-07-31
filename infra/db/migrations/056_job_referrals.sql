-- 055_job_referrals.sql
-- Design: docs/2026-07-29-job-referrals-design-brief.pdf
-- Public job pages, per-channel share links, share/open history, worker
-- attribution (first touch + latest touch), and the WhatsApp carry-through
-- (apply tokens + codes parked against a phone before any account exists).
-- Forward-only. Applied manually via bastion (ADR-005).
--
-- Design constraint that shapes everything here: a phone never reports which
-- app a link was shared to, and messaging apps strip the referrer. Attribution
-- can only ever be as good as what we build into the link at the moment of
-- sharing; nothing is recoverable afterwards. Hence one link per (job,
-- referrer, channel), minted by our own share panel.

BEGIN;

-- ---------------------------------------------------------------------------
-- Code generator
-- ---------------------------------------------------------------------------
-- Pure generator: no existence check, no retry loop inside the function. There
-- is exactly one uniqueness mechanism -- the unique index -- and every caller
-- retries on unique_violation. (A function that queried jobs.public_code while
-- serving as that column's DEFAULT would be a re-entrancy hazard during bulk
-- backfill, and a DEFAULT expression cannot retry itself.)
CREATE OR REPLACE FUNCTION gen_referral_code(code_len INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    -- Crockford base32: digits plus A-Z minus I, L, O and U, so a code stays
    -- unambiguous when read aloud over the phone or typed by hand.
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    result   TEXT := '';
    byte_val INTEGER;
BEGIN
    IF code_len IS NULL OR code_len < 4 OR code_len > 24 THEN
        RAISE EXCEPTION 'gen_referral_code: code_len must be 4..24, got %', code_len;
    END IF;

    FOR i IN 1..code_len LOOP
        -- pgcrypto is not installed in this database, so gen_random_uuid() is
        -- the available CSPRNG source. The first byte of a v4 UUID is fully
        -- random (version/variant bits sit further in), and 256 is an exact
        -- multiple of 32, so this modulo is uniform with no rejection sampling.
        byte_val := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 2))::bit(8)::int;
        result := result || substr(alphabet, (byte_val % 32) + 1, 1);
    END LOOP;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION gen_referral_code(INTEGER) IS
    'Crockford base32 code generator (excludes I, L, O, U). Pure: callers must retry on unique_violation.';

-- ---------------------------------------------------------------------------
-- jobs: a short shareable code, and an employer opt-out from public listing
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS public_code TEXT,
    -- Employer consent: a job can be excluded from public pages entirely.
    ADD COLUMN IF NOT EXISTS public_listing_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_public_code_charset_check;
ALTER TABLE jobs
    ADD CONSTRAINT jobs_public_code_charset_check
    CHECK (public_code IS NULL OR public_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$');

CREATE UNIQUE INDEX IF NOT EXISTS jobs_public_code_key ON jobs (public_code);

-- Backfill every existing job, retrying per row on collision.
DO $$
DECLARE
    target   UUID;
    attempts INTEGER;
BEGIN
    FOR target IN SELECT id FROM jobs WHERE public_code IS NULL LOOP
        attempts := 0;
        LOOP
            attempts := attempts + 1;
            BEGIN
                UPDATE jobs SET public_code = gen_referral_code(6) WHERE id = target;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                IF attempts >= 10 THEN
                    RAISE EXCEPTION 'could not mint a unique public_code for job % after % attempts', target, attempts;
                END IF;
            END;
        END LOOP;
    END LOOP;
END;
$$;

ALTER TABLE jobs ALTER COLUMN public_code SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN public_code SET DEFAULT gen_referral_code(6);

COMMENT ON COLUMN jobs.public_code IS
    'Short human-shareable code in the public URL path (/j/{public_code}). Not an internal id.';
COMMENT ON COLUMN jobs.public_listing_enabled IS
    'Employer opt-out. When false the job is invisible to the public read role at any status.';

-- ---------------------------------------------------------------------------
-- job_share_links: one durable link per (job, referrer, channel)
-- ---------------------------------------------------------------------------
CREATE TABLE job_share_links (
    code                TEXT PRIMARY KEY CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
    job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    -- NULL = an organic / employer share with no referring worker.
    referrer_worker_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    -- 'device_share' is the phone's own share sheet: we recorded that the
    -- worker chose it, but the OS never tells us which app they picked, so the
    -- true destination is unknowable by design. 'unknown' is an arrival with
    -- no usable tag at all.
    channel             TEXT NOT NULL CHECK (channel IN
        ('whatsapp', 'sms', 'facebook', 'copy_link', 'device_share', 'unknown')),
    open_count          INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
    last_opened_at      TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two partial indexes rather than one UNIQUE constraint: in Postgres NULLs are
-- distinct, so a plain UNIQUE (job_id, referrer_worker_id, channel) would let
-- organic shares (NULL referrer) duplicate without limit.
CREATE UNIQUE INDEX job_share_links_referrer_channel_key
    ON job_share_links (job_id, referrer_worker_id, channel)
    WHERE referrer_worker_id IS NOT NULL;
CREATE UNIQUE INDEX job_share_links_organic_channel_key
    ON job_share_links (job_id, channel)
    WHERE referrer_worker_id IS NULL;

CREATE INDEX job_share_links_referrer_idx ON job_share_links (referrer_worker_id)
    WHERE referrer_worker_id IS NOT NULL;
CREATE INDEX job_share_links_job_idx ON job_share_links (job_id);

-- ---------------------------------------------------------------------------
-- job_share_opens: one row per open. All reporting is calculated from this.
-- ---------------------------------------------------------------------------
CREATE TABLE job_share_opens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Nullable: an arrival with a stripped or invalid tag is still recorded,
    -- as an untagged open rather than an error.
    share_code   TEXT REFERENCES job_share_links(code) ON DELETE SET NULL,
    job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    device_kind  TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (device_kind IN ('mobile', 'tablet', 'desktop', 'unknown')),
    locale       TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$'),
    -- Salted SHA-256 of IP + user agent, used only to collapse duplicate opens.
    -- The raw IP address and user-agent string are NEVER stored or logged.
    visitor_hash TEXT CHECK (visitor_hash IS NULL OR visitor_hash ~ '^[0-9a-f]{64}$'),
    opened_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX job_share_opens_share_idx ON job_share_opens (share_code, opened_at DESC);
CREATE INDEX job_share_opens_job_idx   ON job_share_opens (job_id, opened_at DESC);

COMMENT ON COLUMN job_share_opens.visitor_hash IS
    'Salted hash of IP+UA for de-duplication only. Never store or log the raw values.';

-- ---------------------------------------------------------------------------
-- worker_attribution: first touch AND latest touch
-- ---------------------------------------------------------------------------
-- Keeping only the most recent source makes job fairs look worthless when they
-- are in fact feeding the referrals that close. So first_* is written once and
-- never changes; latest_* is overwritten freely.
CREATE TABLE worker_attribution (
    worker_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    first_share_code           TEXT,
    first_channel              TEXT CHECK (first_channel IS NULL OR first_channel IN
        ('whatsapp', 'sms', 'facebook', 'copy_link', 'device_share', 'unknown')),
    first_job_id               UUID REFERENCES jobs(id) ON DELETE SET NULL,
    -- Denormalized on purpose: job_share_links.referrer_worker_id is ON DELETE
    -- SET NULL, so if a referring worker is deleted their historical shares
    -- would become indistinguishable from organic ones. Copying the referrer
    -- here at write time keeps the credit after that account is gone.
    first_referrer_worker_id   UUID,
    first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    latest_share_code          TEXT,
    latest_channel             TEXT CHECK (latest_channel IS NULL OR latest_channel IN
        ('whatsapp', 'sms', 'facebook', 'copy_link', 'device_share', 'unknown')),
    latest_job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
    latest_referrer_worker_id  UUID,
    latest_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX worker_attribution_first_referrer_idx
    ON worker_attribution (first_referrer_worker_id)
    WHERE first_referrer_worker_id IS NOT NULL;

-- First-touch immutability must be a TRIGGER, not a withheld UPDATE grant.
-- jale_admin owns these tables, so withholding a grant does nothing, and under
-- RLS a blocked write is a silent zero-row success rather than an error.
CREATE OR REPLACE FUNCTION worker_attribution_reject_first_touch_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.first_share_code         IS DISTINCT FROM OLD.first_share_code
       OR NEW.first_channel            IS DISTINCT FROM OLD.first_channel
       OR NEW.first_job_id             IS DISTINCT FROM OLD.first_job_id
       OR NEW.first_referrer_worker_id IS DISTINCT FROM OLD.first_referrer_worker_id
       OR NEW.first_seen_at            IS DISTINCT FROM OLD.first_seen_at
    THEN
        RAISE EXCEPTION
            'worker_attribution first-touch columns are immutable (worker_id=%)', OLD.worker_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER worker_attribution_first_touch_immutable
    BEFORE UPDATE ON worker_attribution
    FOR EACH ROW
    EXECUTE FUNCTION worker_attribution_reject_first_touch_change();

-- ---------------------------------------------------------------------------
-- referral_apply_tokens: the only thing that survives web -> WhatsApp
-- ---------------------------------------------------------------------------
-- The applicant leaves the browser to message us, so nothing remembered
-- client-side survives. The token travels inside the message body itself.
-- Only the SHA-256 hash is stored (precedent: employer-upload-token.ts).
CREATE TABLE referral_apply_tokens (
    token_hash          TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    share_code          TEXT REFERENCES job_share_links(code) ON DELETE SET NULL,
    job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    locale              TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$'),
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_at         TIMESTAMPTZ,
    consumed_phone_hash TEXT CHECK (consumed_phone_hash IS NULL OR consumed_phone_hash ~ '^[0-9a-f]{64}$'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_apply_tokens_consumed_coherent
        CHECK ((consumed_at IS NULL) = (consumed_phone_hash IS NULL))
);

CREATE INDEX referral_apply_tokens_expiry_idx ON referral_apply_tokens (expires_at)
    WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- referral_pending_claims: a code parked against a phone pre-registration
-- ---------------------------------------------------------------------------
-- Deliberately its own table rather than worker_identity_challenges.context:
-- that row's lifecycle is short (expired/locked/superseded) while a claim must
-- survive until the person finishes onboarding, possibly days later.
-- phone_hash convention matches worker_identity_challenges (migration 042).
CREATE TABLE referral_pending_claims (
    phone_hash          TEXT PRIMARY KEY CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
    job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    share_code          TEXT REFERENCES job_share_links(code) ON DELETE SET NULL,
    referrer_worker_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    locale              TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$'),
    expires_at          TIMESTAMPTZ NOT NULL,
    claimed_at          TIMESTAMPTZ,
    claimed_worker_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_pending_claims_claimed_coherent
        CHECK ((claimed_at IS NULL) = (claimed_worker_id IS NULL))
);

CREATE INDEX referral_pending_claims_expiry_idx ON referral_pending_claims (expires_at)
    WHERE claimed_at IS NULL;

COMMENT ON TABLE referral_pending_claims IS
    'A referral code sent by WhatsApp before any users row exists. Keyed by phone_hash. Last code wins.';

-- ---------------------------------------------------------------------------
-- RLS: enable and force on every new table
-- ---------------------------------------------------------------------------
ALTER TABLE job_share_links         ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_share_links         FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_share_opens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_share_opens         FORCE  ROW LEVEL SECURITY;
ALTER TABLE worker_attribution      ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_attribution      FORCE  ROW LEVEL SECURITY;
ALTER TABLE referral_apply_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_apply_tokens   FORCE  ROW LEVEL SECURITY;
ALTER TABLE referral_pending_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_pending_claims FORCE  ROW LEVEL SECURITY;

-- EVERY policy below names its role with TO <role>. A policy created without a
-- TO clause applies to PUBLIC -- that is exactly the defect
-- 038_rls_relationship_recursion_repair.sql exists to repair. No policy here
-- is added to the users table, and no new policy on jobs joins back to users.

-- ---------- jale_admin: user-facing endpoints ----------
-- A worker owns the share links they minted.
CREATE POLICY job_share_links_owner ON job_share_links
    FOR ALL TO jale_admin
    USING (referrer_worker_id = (SELECT id FROM users
                                 WHERE cognito_sub = current_setting('app.current_user_id', true)))
    WITH CHECK (referrer_worker_id = (SELECT id FROM users
                                 WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- A worker reads their own attribution; writes happen on the signup path where
-- the RLS context is already that new worker.
CREATE POLICY worker_attribution_owner ON worker_attribution
    FOR ALL TO jale_admin
    USING (worker_id = (SELECT id FROM users
                        WHERE cognito_sub = current_setting('app.current_user_id', true)))
    WITH CHECK (worker_id = (SELECT id FROM users
                        WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- Deliberately NO jale_admin policy on job_share_opens, referral_apply_tokens
-- or referral_pending_claims: locked by default. Open counts reach the worker
-- through job_share_links.open_count, not the raw open history.

GRANT SELECT, INSERT, UPDATE ON job_share_links    TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON worker_attribution TO jale_admin;

-- ---------- jale_whatsapp: parks and claims codes, has no cognito context ----------
GRANT SELECT, UPDATE         ON referral_apply_tokens   TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON referral_pending_claims TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON worker_attribution      TO jale_whatsapp;
GRANT SELECT                 ON job_share_links         TO jale_whatsapp;

CREATE POLICY referral_apply_tokens_whatsapp ON referral_apply_tokens
    FOR ALL TO jale_whatsapp USING (true) WITH CHECK (true);
CREATE POLICY referral_pending_claims_whatsapp ON referral_pending_claims
    FOR ALL TO jale_whatsapp USING (true) WITH CHECK (true);
CREATE POLICY worker_attribution_whatsapp ON worker_attribution
    FOR ALL TO jale_whatsapp USING (true) WITH CHECK (true);
CREATE POLICY job_share_links_whatsapp ON job_share_links
    FOR SELECT TO jale_whatsapp USING (true);

-- ---------------------------------------------------------------------------
-- jale_public_jobs: the anonymous public read role
-- ---------------------------------------------------------------------------
-- Jale's first unauthenticated database read. The design requires that
-- employer contact details, applicant lists and documents be UNREACHABLE, not
-- merely unselected -- so the control is column-scoped grants plus a policy
-- targeted at this role, never handler discipline.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_public_jobs') THEN
        CREATE ROLE jale_public_jobs WITH LOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO jale_public_jobs;

-- Column-scoped read of jobs. employer_id is deliberately ABSENT: it is the
-- join key to employer contact details. Geo columns from 009 are also absent.
GRANT SELECT (
    id, public_code, title, company, location, job_type, description,
    pay, pay_min, pay_max, pay_interval, start_date, expected_duration,
    shift_schedule, trade_category, required_experience_years,
    required_experience_months, certifications, language_preference,
    transportation_required, work_authorization_required,
    number_of_workers_needed, required_docs, status, public_listing_enabled,
    created_at
) ON jobs TO jale_public_jobs;

-- No grant of ANY kind on users, employer_profiles, job_applications, or any
-- document table. The "never expose" list is unreachable, not just unread.

-- Status is intentionally NOT in this policy. A link to a filled job must be
-- able to say "no longer accepting applications" rather than 404; the handler
-- projects full detail only when status = 'active' and a minimal closed-state
-- view otherwise. The predicate touches only jobs -- no join to users, so the
-- 038 recursion class cannot recur.
CREATE POLICY jobs_public_read ON jobs
    FOR SELECT TO jale_public_jobs
    USING (public_listing_enabled);

-- The resolver records opens and mints apply tokens; nothing more.
GRANT SELECT                        ON job_share_links       TO jale_public_jobs;
GRANT UPDATE (open_count, last_opened_at) ON job_share_links TO jale_public_jobs;
GRANT INSERT                        ON job_share_opens       TO jale_public_jobs;
GRANT SELECT, INSERT                ON referral_apply_tokens TO jale_public_jobs;

CREATE POLICY job_share_links_public_read ON job_share_links
    FOR SELECT TO jale_public_jobs USING (revoked_at IS NULL);
CREATE POLICY job_share_links_public_count ON job_share_links
    FOR UPDATE TO jale_public_jobs USING (revoked_at IS NULL) WITH CHECK (revoked_at IS NULL);
CREATE POLICY job_share_opens_public_insert ON job_share_opens
    FOR INSERT TO jale_public_jobs WITH CHECK (true);
CREATE POLICY referral_apply_tokens_public_insert ON referral_apply_tokens
    FOR INSERT TO jale_public_jobs WITH CHECK (consumed_at IS NULL);
-- Read-back of a freshly minted token row only; the public role can never mark
-- one consumed -- that is the WhatsApp lane's job.
CREATE POLICY referral_apply_tokens_public_read ON referral_apply_tokens
    FOR SELECT TO jale_public_jobs USING (true);

COMMIT;
