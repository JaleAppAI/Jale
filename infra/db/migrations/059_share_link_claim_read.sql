-- 059_share_link_claim_read.sql
-- Let an authenticated worker RESOLVE a share link they hold the code for.
--
-- Production blocker found by review before the web-apply flow shipped:
-- job_share_links' only jale_admin policy is job_share_links_owner
-- (referrer_worker_id = caller), so the claim endpoint's SELECT ... WHERE
-- code = $1, running under the CLAIMER's RLS context, was filtered to zero
-- rows for every genuine (non-self) referral. The endpoint could only ever
-- persist self-referrals; real claims silently returned { claimed: false }.
--
-- The semantic being encoded: a share code is a CAPABILITY TOKEN. Possession
-- of the code is the authorization to resolve it -- exactly the contract the
-- anonymous role already has (job_share_links_public_read USING
-- (revoked_at IS NULL)). This policy gives authenticated app sessions the
-- same read, no more: handlers only ever query by exact code, the code space
-- is 40 bits of CSPRNG output, and revoked links stay unreadable. Writes are
-- untouched -- job_share_links_owner still scopes INSERT/UPDATE to the
-- owning referrer.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

CREATE POLICY job_share_links_claim_read ON job_share_links
    FOR SELECT TO jale_admin
    USING (revoked_at IS NULL);

COMMIT;
