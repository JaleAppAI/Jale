-- 063_employer_referral_links.sql
-- Extends the 056 referral schema so an EMPLOYER, not just a worker, can be
-- the referrer on a job_share_link -- e.g. an employer's own recruiting link
-- for a job fair or paid channel, tracked the same way worker referrals are.
--
-- referrer_worker_id and referrer_employer_id are mutually exclusive (a link
-- has at most one kind of referrer, or none for an organic share) -- enforced
-- by a named CHECK rather than left to application discipline.
--
-- The 056 organic-share partial unique index only excluded rows with a NULL
-- worker referrer, so before this migration a job+channel could ambiguously
-- collide between "organic" and "employer-referred" once employer referrers
-- existed. It is rebuilt here (same name, tightened predicate) so "organic"
-- means both referrer columns NULL.
--
-- job_share_links_employer_channel_key is a NEW index, not a rebuild: it is
-- the ON CONFLICT arbiter another task's employer-link-minting INSERT targets
-- directly by name/predicate, mirroring 056's worker-referrer unique index.
--
-- job_share_links_owner (the only jale_admin write policy on this table) is
-- extended to treat either referrer column as ownership, using the exact
-- `users.cognito_sub = current_setting('app.current_user_id', true)` subquery
-- idiom 056 already uses for the worker case -- copied verbatim rather than
-- reshaped, so the two clauses stay visibly parallel.
--
-- job_share_links_claim_read (059) is untouched: it already has no referrer
-- predicate (`USING (revoked_at IS NULL)`), so an employer-referred link
-- resolves through the claim-read path exactly like a worker-referred one --
-- verified by re-reading 059 before writing this migration.
--
-- worker_attribution's first-touch immutability trigger function is
-- CREATE OR REPLACE'd (029 precedent: this preserves the existing trigger
-- binding) to add first_referrer_employer_id to the protected-columns
-- comparison; everything else in the function body is byte-identical to 056.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

-- ---------------------------------------------------------------------------
-- job_share_links: employer referrer
-- ---------------------------------------------------------------------------
ALTER TABLE job_share_links
    ADD COLUMN IF NOT EXISTS referrer_employer_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE job_share_links DROP CONSTRAINT IF EXISTS job_share_links_referrer_exclusive_check;
ALTER TABLE job_share_links
    ADD CONSTRAINT job_share_links_referrer_exclusive_check
    CHECK (referrer_worker_id IS NULL OR referrer_employer_id IS NULL);

-- Rebuild the organic-share partial unique index so "organic" requires BOTH
-- referrer columns NULL (previously only referrer_worker_id IS NULL, which
-- predates referrer_employer_id existing at all).
DROP INDEX IF EXISTS job_share_links_organic_channel_key;
CREATE UNIQUE INDEX job_share_links_organic_channel_key
    ON job_share_links (job_id, channel)
    WHERE referrer_worker_id IS NULL AND referrer_employer_id IS NULL;

-- New: the ON CONFLICT arbiter for employer-referrer link minting. Name and
-- predicate must match exactly what the minting INSERT targets.
CREATE UNIQUE INDEX job_share_links_employer_channel_key
    ON job_share_links (job_id, referrer_employer_id, channel)
    WHERE referrer_employer_id IS NOT NULL;

CREATE INDEX job_share_links_referrer_employer_idx
    ON job_share_links (referrer_employer_id)
    WHERE referrer_employer_id IS NOT NULL;

-- Extend ownership: either referrer column matching the caller counts as
-- owning the link. Same subquery idiom as 056, copied verbatim per column.
DROP POLICY IF EXISTS job_share_links_owner ON job_share_links;
CREATE POLICY job_share_links_owner ON job_share_links
    FOR ALL TO jale_admin
    USING (
        referrer_worker_id = (SELECT id FROM users
                              WHERE cognito_sub = current_setting('app.current_user_id', true))
        OR referrer_employer_id = (SELECT id FROM users
                              WHERE cognito_sub = current_setting('app.current_user_id', true))
    )
    WITH CHECK (
        referrer_worker_id = (SELECT id FROM users
                              WHERE cognito_sub = current_setting('app.current_user_id', true))
        OR referrer_employer_id = (SELECT id FROM users
                              WHERE cognito_sub = current_setting('app.current_user_id', true))
    );

-- job_share_links_claim_read (059) is intentionally untouched here.

-- ---------------------------------------------------------------------------
-- worker_attribution: employer referrer, first AND latest touch
-- ---------------------------------------------------------------------------
ALTER TABLE worker_attribution
    ADD COLUMN IF NOT EXISTS first_referrer_employer_id  UUID,
    ADD COLUMN IF NOT EXISTS latest_referrer_employer_id UUID;

-- Same immutability trigger function as 056, with first_referrer_employer_id
-- added to the protected-columns comparison. Body is otherwise identical.
CREATE OR REPLACE FUNCTION worker_attribution_reject_first_touch_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.first_share_code           IS DISTINCT FROM OLD.first_share_code
       OR NEW.first_channel              IS DISTINCT FROM OLD.first_channel
       OR NEW.first_job_id               IS DISTINCT FROM OLD.first_job_id
       OR NEW.first_referrer_worker_id   IS DISTINCT FROM OLD.first_referrer_worker_id
       OR NEW.first_referrer_employer_id IS DISTINCT FROM OLD.first_referrer_employer_id
       OR NEW.first_seen_at              IS DISTINCT FROM OLD.first_seen_at
    THEN
        RAISE EXCEPTION
            'worker_attribution first-touch columns are immutable (worker_id=%)', OLD.worker_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
