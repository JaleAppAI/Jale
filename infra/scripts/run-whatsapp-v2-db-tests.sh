#!/usr/bin/env bash
#
# Fail-closed runner for the focused WhatsApp v2 PostgreSQL enforcement and
# concurrency suites (migration 042 + onboarding concurrency).
#
# `test:whatsapp-v2-db` points here so that an unset or empty
# JALE_TEST_DATABASE_URL is a hard, non-zero failure instead of a false green.
# Both integration suites SKIP (registering only placeholder assertions) when
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
  echo "  Refusing to run: the migration-042 and concurrency suites SKIP without a" >&2
  echo "  database URL and jest would otherwise exit 0 without verifying anything." >&2
  echo "  Set it to a local Postgres 16 superuser URL (schema 001-042 applied), then" >&2
  echo "  re-run. The value is never printed." >&2
  exit 1
fi

exec npx jest --runInBand \
  test/unit/db/whatsapp-onboarding-042.integration.test.ts \
  test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts
