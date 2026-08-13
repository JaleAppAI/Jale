#!/usr/bin/env bash
#
# Fail-closed runner for the focused wage_references / city_cbsa_crosswalk
# PostgreSQL suite (migration 070).
#
# An unset or empty JALE_TEST_DATABASE_URL is a hard, non-zero failure
# instead of a false green. The integration suite SKIPs (registering only a
# placeholder CONCERN assertion) when the URL is absent, so invoking jest
# directly would exit 0 without ever touching Postgres. This guard refuses
# to run in that case -- mirrors scripts/run-whatsapp-v2-db-tests.sh.
#
# The URL value is never printed -- only its presence is checked.
set -euo pipefail

# Anchor at the infra package root regardless of the caller's cwd, so the
# relative suite path and `npx jest` resolve the same way `npm run` invokes it.
cd "$(dirname "$0")/.."

if [ -z "${JALE_TEST_DATABASE_URL:-}" ]; then
  echo "run-wage-reference-db-tests: JALE_TEST_DATABASE_URL is not set (or empty)." >&2
  echo "  Refusing to run: the migration-070 integration suite SKIPs without a" >&2
  echo "  database URL and jest would otherwise exit 0 without verifying anything." >&2
  echo "  Set it to a local Postgres 16 superuser URL (schema through 070 applied), then" >&2
  echo "  re-run. The value is never printed." >&2
  exit 1
fi

#
# Deliberately does NOT include apply-order.test.ts / migrations.test.ts:
# those re-apply migrations 001-034 from scratch against the SAME
# JALE_TEST_DATABASE_URL (they want a VIRGIN cluster), while this suite
# assumes the full chain (001->070) is already applied and seeds real rows
# into it. Pointing one URL at both wants is a known, pre-existing
# contradiction (see the whatsapp-v2 testbed notes) -- not something to
# "fix" by merging the runners. The non-DB unit tests for the generator/
# parser/loader (wage-seed-lib, oews-bulk-parser, census-crosswalk-parser,
# oews-tx-seed-data, seed-oews-wages) run under the normal capped `npm
# test`; they need no database and don't belong in this fail-closed gate.
exec npx jest --runInBand \
  test/unit/db/wage-references.integration.test.ts
