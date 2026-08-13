-- 070_wage_references.sql
-- Recommended-pay reference data: BLS OEWS wage percentiles per trade x
-- Texas area, and a TX city -> CBSA crosswalk so a job/worker city_key
-- resolves to the right area. Read-only reference tables for Feature B
-- (recommended pay -- design:
-- docs/superpowers/specs/2026-08-12-recommended-pay-design.md). No AI, no
-- PII.
--
-- Both tables live in one migration rather than a separate 071: they are
-- always created, seeded, and read together (a wage lookup always resolves
-- an area_code via the crosswalk first), so keeping them in one file keeps
-- the pair atomic and avoids a second, redundant manifest-sync surface for
-- no isolation benefit.
--
-- ---------------------------------------------------------------------------
-- RLS: read-only-forever-to-app, writes only through a script-owned window
-- ---------------------------------------------------------------------------
-- ENABLE + FORCE on both, mirroring billing_plans (034): a read-only catalog
-- is default-deny even for its own owner. jale_admin gets exactly ONE
-- policy on each table -- SELECT, USING (true). No INSERT/UPDATE/DELETE
-- policy exists anywhere in this migration, on purpose:
--
--   * These tables are created here connected as jale_admin, so jale_admin
--     is their owner. A bare INSERT/UPDATE/DELETE by jale_admin (or anyone
--     else) outside of the seed script therefore fails. Verified against
--     Postgres 16: with FORCE RLS and zero matching policy for a command,
--     INSERT fails LOUDLY ("new row violates row-level security policy");
--     UPDATE/DELETE fail SILENTLY (0 rows affected, no error -- the same
--     "silent zero" hazard called out in migrations 056/062). Both are
--     intentional here: nothing should ever write to these tables except
--     the seed path below, and the wage-references integration suite
--     asserts both shapes distinctly rather than expecting all three to
--     throw.
--   * The seed path (infra/scripts/seed-oews-wages.ts, run by an operator,
--     roughly annually) opens a temporary write policy scoped to jale_admin
--     inside its own transaction, upserts, drops the policy, and verifies
--     the upserted row count before committing -- exactly the pattern
--     migration 069 used to update billing_plans.entitlements (also a
--     FORCE-RLS, SELECT-only table) from outside the migration that created
--     it. No additional GRANT is needed for this: Postgres gives a table's
--     owner full DML privilege regardless of explicit GRANT statements
--     (verified empirically -- a table created and never explicitly granted
--     any privilege back to its own owner still allows that owner's INSERT/
--     UPDATE once a matching RLS policy admits it); only RLS gates the
--     write here, and RLS is exactly what the seed script's temporary
--     policy lifts for the duration of that one transaction. A separate
--     throwaway role (the SET ROLE pattern 067 uses for its one-time
--     backfill) is not needed: this is a repeatable operator path, not a
--     one-shot migration-embedded repair, and jale_admin is already the
--     only identity that ever runs it.
--
-- Explicitly NOT granted here: jale_public_jobs, jale_whatsapp. Neither role
-- has any business reading wage benchmarks; since neither gets any GRANT at
-- all, an attempted SELECT from either fails with "permission denied for
-- table" -- a table-privilege error raised before RLS is ever consulted
-- (loud, same failure class as a role with zero grant on any other table).
--
-- ---------------------------------------------------------------------------
-- city_cbsa_crosswalk coverage and county_fips
-- ---------------------------------------------------------------------------
-- city_cbsa_crosswalk only maps principal cities of the 5 target Texas MSAs
-- (Austin 12420, Dallas-Fort Worth-Arlington 19100, Houston-Pasadena-The
-- Woodlands 26420, San Antonio-New Braunfels 41700, El Paso 21340), derived
-- from the Census Bureau's July 2023 CBSA delineation files (list1_2023.xlsx,
-- list2_2023.xlsx -- see infra/scripts/generate-oews-seed.ts's header for the
-- exact URLs and SHA-256 hashes; those two files downloaded successfully and
-- are real government data, unlike the wage numbers below).
--
-- It deliberately does NOT map any city to the 6 nonmetro OEWS regions
-- (Northwestern, North, Eastern, Hill Country, Border, Coastal Plains --
-- real BLS area codes 4800001-4800006, verified against the downloaded
-- May-2025 OEWS bulk file; NOTE this is 6 regions with 4 different names
-- than the recommended-pay design doc's stated "5 named nonmetro regions
-- (Border, West Texas, Coastal Plains, North Texas, Big Thicket)" -- BLS
-- has revised its Texas nonmetro area definitions since that doc was
-- written; only "Border" and "Coastal Plains" persisted under the same
-- name. Reconciled against current reality per CLAUDE.md Source Authority,
-- not silently absorbed -- see infra/scripts/lib/wage-seed-lib.ts's
-- TX_NONMETRO_AREAS for the full account). No public file mapping
-- individual counties/cities to these BLS-drawn nonmetro region groupings
-- was located (a few plausible bls.gov URLs were tried and returned only
-- the site's generic template, not real area-definition content -- this is
-- "no such file found," NOT a network block: Node's fetch() reaches
-- bls.gov fine in this environment, unlike curl; see the generator
-- header). Guessing a county -> nonmetro-region mapping without that
-- source would risk silently misrouting a small-town lookup to the wrong
-- regional wage figure, so the six wage_references rows with
-- area_kind='nonmetro' exist in the table (reachable directly by
-- area_code, and populated with REAL BLS wage data) but are UNREACHABLE
-- via any city_key lookup until that mapping is found. A city not covered
-- here -- including every non-MSA Texas town -- falls straight through to
-- the area_kind='state' row. That is the documented, tested (B-2)
-- behavior, not a bug: T-B2's implementer should not add a nonmetro
-- fallback path that can never fire and then "fix" it by inventing a
-- county mapping.
--
-- county_fips on city_cbsa_crosswalk is nullable and is NULL for every row
-- this migration's checked-in seed data populates: list2_2023.xlsx
-- (principal cities) gives a CBSA code per city but not a county, and every
-- one of the 5 target CBSAs spans multiple counties (verified against the
-- delineation file -- Dallas-Fort Worth-Arlington alone has 11), so a
-- specific county cannot be attributed to a principal city without
-- guessing. The column is kept for a future ZIP/HUD-crosswalk phase that
-- can populate it accurately.
--
-- The state tier's area_code is the literal string 'TX', NOT BLS's raw
-- AREA='48' FIPS code -- a documented, deliberate schema convention (see
-- wage-seed-lib.ts's TX_STATE_AREA) so a reader of T-B2's pay-reference
-- lookup can interpret the key without a FIPS table, and so a second
-- state later reads as 'OK' rather than a bare '40'. The metro (CBSA
-- number) and nonmetro (BLS area number) codes above ARE the raw
-- upstream codes, because there is no more-readable alternative for those;
-- 'state' is a single, statically-known tier per state, so nothing is
-- lost by using a readable label there instead.
--
-- Run AFTER 069_employer_job_templates.sql, connected as jale_admin (NOT the
-- RDS master user). Forward-only (ADR-005). Schema only -- no rows are
-- seeded by this migration; infra/scripts/seed-oews-wages.ts populates both
-- tables from the checked-in infra/scripts/data/oews-tx-seed.json, which
-- holds REAL May-2025 BLS OEWS wage data (not placeholder -- see that
-- file's "placeholder": false and "provenance" fields, and the generator's
-- header for how the bulk file was actually fetched). A future re-seed
-- whose OEWS download fails falls back to a clearly-flagged placeholder
-- (infra/scripts/generate-oews-seed.ts prints a loud warning banner in that
-- case, and seed-oews-wages.ts refuses to load such a file silently).

BEGIN;

CREATE TABLE wage_references (
  trade_category TEXT         NOT NULL CHECK (trade_category IN (
                                 'electrician',
                                 'plumber',
                                 'carpenter',
                                 'concrete',
                                 'painting',
                                 'drywall',
                                 'general_labor',
                                 'other'
                               )),
  area_code      TEXT         NOT NULL,
  area_kind      TEXT         NOT NULL CHECK (area_kind IN ('metro', 'nonmetro', 'state')),
  area_label     TEXT         NOT NULL,
  p25_hourly     NUMERIC(6,2) NOT NULL,
  p50_hourly     NUMERIC(6,2) NOT NULL,
  p75_hourly     NUMERIC(6,2) NOT NULL,
  source_tier    TEXT         NOT NULL CHECK (source_tier IN ('metro', 'nonmetro', 'state')),
  data_vintage   TEXT         NOT NULL,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_category, area_code),
  CHECK (p25_hourly > 0 AND p25_hourly <= p50_hourly AND p50_hourly <= p75_hourly)
);

COMMENT ON COLUMN wage_references.source_tier IS
  'Which OEWS publication tier actually supplied this row''s wage numbers -- '
  'may differ from area_kind when the natural tier''s own cell was '
  'suppressed and a broader tier''s figures were copied down (e.g. a metro '
  'row whose own metro-level cell was suppressed, backed by the statewide '
  'number instead). The UI reads source_tier, not area_kind, to decide '
  'whether to say "in <city>" or "in Texas".';

GRANT SELECT ON wage_references TO jale_admin;

ALTER TABLE wage_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE wage_references FORCE ROW LEVEL SECURITY;

CREATE POLICY wage_references_read_all ON wage_references
  FOR SELECT TO jale_admin USING (true);

CREATE TABLE city_cbsa_crosswalk (
  city_key    TEXT PRIMARY KEY,
  county_fips TEXT,
  area_code   TEXT NOT NULL,
  area_kind   TEXT NOT NULL CHECK (area_kind IN ('metro', 'nonmetro'))
);

COMMENT ON COLUMN city_cbsa_crosswalk.county_fips IS
  'Nullable, and NULL for every row this migration''s checked-in seed data '
  'populates -- see the migration header for why a specific county cannot '
  'be attributed to a multi-county CBSA''s principal city without '
  'guessing.';

GRANT SELECT ON city_cbsa_crosswalk TO jale_admin;

ALTER TABLE city_cbsa_crosswalk ENABLE ROW LEVEL SECURITY;
ALTER TABLE city_cbsa_crosswalk FORCE ROW LEVEL SECURITY;

CREATE POLICY city_cbsa_crosswalk_read_all ON city_cbsa_crosswalk
  FOR SELECT TO jale_admin USING (true);

COMMIT;
