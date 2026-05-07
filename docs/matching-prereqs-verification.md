# Matching Prereqs Verification

This file maps the readiness stop/go criteria for Job Matching Engine V1 to the tests and artifacts added by the prerequisite workstreams.

| Criterion | Coverage |
|---|---|
| Migration baseline applies in order | `infra/test/unit/db/migrations/apply-order.test.ts`; live Postgres apply path enabled by `JALE_TEST_DATABASE_URL` |
| Canonical matching source fields are documented | `docs/ARCHITECTURE.md`; asserted by `apply-order.test.ts` |
| Worker skills normalized out of `worker_profiles.skills` | `infra/db/migrations/008_worker_skills.sql`; `worker-profile-update.test.ts`; profile/applicant query tests |
| Coordinate schema and source precedence are present | `infra/db/migrations/009_location_foundation.sql`; `location.test.ts`; coordinate API tests |
| Dedicated internal matching DB role and tables exist | `infra/db/migrations/010_matching_write_semantics.sql`; migration tests |
| Matching role secret uses generated password plus RDS endpoint metadata | `DatabaseStack` tests; `matching-db.test.ts` |
| Employer-safe and worker-safe view contracts strip private matching data | `candidate-views.test.ts` |
| Matching queue skeleton exists without enabling processors early | `matching-stack.test.ts`; `MatchingStack` disabled scheduled rule |
| Scoring and idempotency contracts are locked for V1 | `match-score.test.ts` and `idempotency.test.ts` TODO scaffolds |
| V1 route integration expectations are documented but not active early | skipped tests in `infra/test/integration/matching/` |

V1 can begin once the final prerequisite gate is green: `npm test`, `npx tsc --noEmit`, and `npx cdk synth` from `infra/`.
