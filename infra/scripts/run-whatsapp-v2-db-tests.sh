#!/usr/bin/env bash
#
# Fail-closed runner for the focused WhatsApp v2 PostgreSQL enforcement and
# concurrency suites (migrations 042/049/080/086/087/091 + onboarding
# concurrency, least-privilege flow coverage, and the 080 application-fill DB
# contract: worker_documents grants/RLS, the 075/078 cert caps, and -- since
# migration 091 retired the 022 INSERT guard the 080 suite used to exercise --
# the proof that a doc-less application INSERT now succeeds on both roles),
# plus the R2-C0 web-onboarding-door spike (086's
# start_web_onboarding_workflow driven end-to-end as jale_whatsapp), the
# R2-C23 web-door HTTP suite, and the R2-C6 web->WhatsApp crossover suite.
#
# The final entry is the migration-091 application-stages contract: the widened
# status CHECK, the hire-requirements trigger (which runs with INVOKER rights,
# so only a real database with real policies can prove it fails closed), the
# jale_whatsapp column grants, and the prompts CHECK function.
#
# The 086 EMPLOYER side of that migration is closed by two more entries: the
# worker_trust_extractions policies and the two SECURITY DEFINER entry points,
# and then the two employer applicant reads executed as their exported query
# text against the real policies. They are here rather than in a mocked suite
# for the reason the rest of this list exists -- a mocked pool has no planner
# and no policies, so a column this role cannot select is a 42501 (or a 42702)
# that only a real database ever raises.
#
# WHAT THE DATABASE MUST BE. `JALE_TEST_DATABASE_URL` must point at a
# disposable local Postgres 16 database with migrations 001 THROUGH 091
# applied, and the connecting role must be a SUPERUSER. The suites are not
# disposable local Postgres 16 database with migrations 001 THROUGH 087
# applied (091 for the sprint-23 stage suite), and the connecting role must be
# a SUPERUSER. The suites are not
# merely readers: they ALTER ROLE jale_whatsapp / jale_ai to set the test
# passwords they then reconnect with, insert fixtures past RLS, and read
# columns those roles are not granted. A non-superuser URL fails deep inside
# a beforeAll with a permission error that reads like a schema bug, so the
# check below is done up front instead.
#
# `test:whatsapp-v2-db` points here so that an unset or empty
# JALE_TEST_DATABASE_URL is a hard, non-zero failure instead of a false green.
# The integration suites SKIP (registering only placeholder assertions) when
# the URL is absent, so invoking jest directly would exit 0 without ever
# touching Postgres. This guard refuses to run in that case.
#
# The URL value is never printed — only its presence is checked.
set -euo pipefail

# Anchor at the infra package root regardless of the caller's cwd, so the
# relative suite paths and `npx jest` resolve the same way `npm run` invokes it.
cd "$(dirname "$0")/.."

if [ -z "${JALE_TEST_DATABASE_URL:-}" ]; then
  echo "run-whatsapp-v2-db-tests: JALE_TEST_DATABASE_URL is not set (or empty)." >&2
  echo "  Refusing to run: the migration-042/049 and concurrency suites SKIP without a" >&2
  echo "  database URL and jest would otherwise exit 0 without verifying anything." >&2
  echo "  Set it to a local Postgres 16 SUPERUSER url (migrations 001-091 applied)," >&2
  echo "  then re-run. The value is never printed." >&2
  exit 1
fi

# Fail LOUDLY and fast on a non-superuser URL rather than deep inside a
# beforeAll. Uses node + the repo's own `pg` (psql is not installed on CI
# images) and a hard connect timeout, so an unreachable host is a 5-second
# error rather than a hang. The URL is passed through the environment and
# never interpolated into the program text, so it cannot reach a log line or
# a process listing.
if ! node -e '
  const { Client } = require("pg");
  const c = new Client({
    connectionString: process.env.JALE_TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  c.connect()
    .then(() => c.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user"))
    .then((r) => {
      if (!r.rows[0] || r.rows[0].rolsuper !== true) {
        console.error("  connected, but the role is NOT a superuser.");
        process.exit(2);
      }
    })
    .then(() => c.end())
    .catch((e) => { console.error("  " + e.message); process.exit(3); });
' 2>&1; then
  echo "run-whatsapp-v2-db-tests: JALE_TEST_DATABASE_URL is unusable." >&2
  echo "  These suites need a disposable local database with migrations 001-091" >&2
  echo "  applied, reached as a SUPERUSER: they ALTER ROLE jale_whatsapp/jale_ai to" >&2
  echo "  set test passwords, insert fixtures past RLS, and read columns those roles" >&2
  echo "  are not granted. Refusing to run. The value is never printed." >&2
  exit 1
fi

exec npx jest --runInBand \
  test/unit/db/whatsapp-onboarding-042.integration.test.ts \
  test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts \
  test/unit/db/whatsapp-flow-049.integration.test.ts \
  test/unit/db/worker-profiles-constraints.integration.test.ts \
  test/unit/db/whatsapp-onboarding-052.integration.test.ts \
  test/unit/db/whatsapp-onboarding-reset.integration.test.ts \
  test/unit/db/retrigger-sweep-definer.integration.test.ts \
  test/unit/db/whatsapp-application-fill-080.integration.test.ts \
  test/unit/db/web-onboarding-door-spike.integration.test.ts \
  test/unit/db/web-onboarding-door.integration.test.ts \
  test/unit/db/web-worker-whatsapp-crossover.integration.test.ts \
  test/unit/db/trust-extractions-086.integration.test.ts \
  test/unit/db/employer-worker-reads.integration.test.ts \
  test/unit/db/web-onboarding-hostile-inputs.integration.test.ts \
  test/unit/db/application-stages-091.integration.test.ts
  test/unit/db/worker-application-details.integration.test.ts
  test/unit/db/application-stage-notify.integration.test.ts
