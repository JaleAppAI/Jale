#!/usr/bin/env bash
#
# Fail-closed runner for the PostgreSQL-backed test suites of the infra
# package: every *.integration.test.ts under test/unit/db, and any other test
# that reads a test-database URL. test/unit/scripts/run-whatsapp-v2-db-tests.test.ts
# fails when a suite on disk is neither listed in SUITES below nor excused
# there with a reason (the clean-apply suites, which each need a cluster of
# their own, run alone through --suite).
#
# These suites need a real database because a mocked pool has no planner, no
# grants and no policies: a column a role may not read is a 42501, a write
# with a missing GUC is a silent zero-row success, and FORCE ROW LEVEL
# SECURITY hides rows even from a table's owner. Only PostgreSQL shows any of
# it.
#
# WHAT THE DATABASE MUST BE. JALE_TEST_DATABASE_URL must point at a disposable
# local PostgreSQL 16 database with every migration on disk applied
# (infra/db/local/bootstrap-testbed.sh), reached as a SUPERUSER. The suites
# set the bed's test passwords with ALTER ROLE, insert fixtures past row
# security, read columns the runtime roles are not granted, and several
# re-apply a migration file as the bed's jale_admin. A non-superuser URL fails
# deep inside a beforeAll with a permission error that reads like a schema
# bug, so it is refused up front.
#
# PROFILES. bootstrap-testbed.sh --profile exports JALE_TEST_DB_PROFILE:
# standard (the default), request or owner-unrestricted. The runner validates
# it, exports it to every suite, and refuses a bed that does not match it:
# owner-unrestricted proves that handlers scope in SQL on their own, and the
# other two leave the bed as the migration chain built it. A suite that
# applies to some profiles only declares that itself, with describeInProfiles
# or itInProfiles from test/unit/db/helpers/login-pool.ts. The runner never
# filters suites by name: every registered suite runs in every profile.
#
# ORDER. Jest's default sequencer ignores the order of the paths it is given
# (it runs earlier failures first, then the slowest suites, then the largest
# files), so the runner hands jest a sequencer that runs SUITES exactly as
# listed, and the results check proves they ran that way. The order rules are
# with the list.
#
# SKIPS FAIL THE RUN. Without a database a suite registers placeholder or
# pending tests and jest still exits 0, so a skip can read as a pass. Jest
# therefore writes its results as JSON, and the run fails unless every
# registered suite ran exactly once, in order, and every test in it passed:
# nothing failed, pending, todo or skipped. There is no allow-list. Jest is
# given exact paths (--runTestsByPath), so a listed file that is missing
# fails the run instead of being dropped.
#
# MODES.
#   (no argument)          run SUITES against JALE_TEST_DATABASE_URL.
#   --suite PATH           run one suite alone (PATH relative to infra/) under
#                          the same checks, e.g. a clean-apply suite on a bed
#                          of its own. No URL check: the suite's own skip
#                          fails the results check.
#   --check-results FILE   check a jest JSON results file against SUITES;
#                          runs nothing.
# JALE_DB_TEST_RESULTS names the results file to write (default: a temporary
# file, removed on exit). When GITHUB_STEP_SUMMARY is set, the check appends
# the commit, the profile and the per-suite counts to it;
# JALE_DB_TEST_PR_HEAD, when set, is recorded next to the commit.
#
# The URL value is never printed — only its presence is checked.
set -euo pipefail

# Anchor at the infra package root regardless of the caller's cwd, so the
# relative suite paths and `npx jest` resolve the same way `npm run` invokes it.
cd "$(dirname "$0")/.."

SUITES=(
  # 1. Catalog-only suites, before any suite writes a fixture. They read the
  #    catalog as the migrations left it (the access-manifest coverage guard,
  #    the login posture, the capability-function surface) and change nothing.
  test/unit/db/least-privilege-coverage.integration.test.ts
  test/unit/db/least-privilege-posture.integration.test.ts
  test/unit/db/least-privilege-cap-functions.integration.test.ts
  # 2. 043's worker_intent lease is global, and this suite asserts that a
  #    lease returns exactly its own row, so it runs before any other suite
  #    can leave a leasable row behind.
  test/unit/db/whatsapp-worker-intent-043.integration.test.ts
  # 2b. The admin analytics suites check whole-database figures (every row in
  #    a window, not only their own), so they run before any suite after 043
  #    writes a fixture; 043 removes the rows they count. Each removes its own
  #    fixtures afterwards, so the next one also starts from an unwritten bed.
  test/unit/db/onboarding-funnel-2a.integration.test.ts
  test/unit/db/employer-health-2b.integration.test.ts
  test/unit/db/ops-health-2c.integration.test.ts
  test/unit/db/admin-queues-2d.integration.test.ts
  #    120's superadmin guard counts every active superadmin in the database,
  #    so its suite also runs here, before a later suite leaves an admin
  #    behind; it parks the active superadmins it finds and restores them.
  test/unit/db/admin-access-120.integration.test.ts
  test/unit/db/support-mode-121.integration.test.ts
  test/unit/db/admin-inbox-122.integration.test.ts
  test/unit/db/admin-analytics-s28.integration.test.ts
  #    124's capture suite asserts its whole-database figures inside rolled-back
  #    transactions, and its committed fixtures leave with their accounts.
  test/unit/db/analytics-capture-124.integration.test.ts
  # 3. The body. These suites key every assertion on their own fixtures (or
  #    measure deltas), so they tolerate each other's leftover rows. A new
  #    suite goes here unless it belongs in the tail; one that leaves
  #    worker_intent or job-message outbox rows behind must clean them up.
  test/unit/db/whatsapp-onboarding-042.integration.test.ts
  test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts
  test/unit/db/whatsapp-flow-049.integration.test.ts
  test/unit/db/worker-profiles-constraints.integration.test.ts
  test/unit/db/whatsapp-onboarding-reset.integration.test.ts
  test/unit/db/retrigger-sweep-definer.integration.test.ts
  test/unit/db/whatsapp-application-fill-080.integration.test.ts
  test/unit/db/web-onboarding-door-spike.integration.test.ts
  test/unit/db/web-onboarding-door.integration.test.ts
  test/unit/db/web-worker-whatsapp-crossover.integration.test.ts
  test/unit/db/trust-extractions-086.integration.test.ts
  test/unit/db/employer-worker-reads.integration.test.ts
  test/unit/db/web-onboarding-hostile-inputs.integration.test.ts
  test/unit/db/application-stages-091.integration.test.ts
  test/unit/db/worker-application-details.integration.test.ts
  test/unit/db/whatsapp-applications-command.integration.test.ts
  test/unit/db/onboarding-cleanup-092.integration.test.ts
  test/unit/db/application-field-reuse.integration.test.ts
  test/unit/db/application-stage-notify.integration.test.ts
  test/unit/db/application-web-completion.integration.test.ts
  test/unit/db/billing-rls.integration.test.ts
  test/unit/db/job-limits-129.integration.test.ts
  test/unit/db/entitlement-concurrency.integration.test.ts
  test/unit/db/billing-job-limit.integration.test.ts
  test/unit/db/billing-current-subscription.integration.test.ts
  test/unit/db/rls-relationship-repair.integration.test.ts
  test/unit/db/employer-organizations-118.integration.test.ts
  test/unit/db/whatsapp-support-039.integration.test.ts
  test/unit/db/whatsapp-delivery-040.integration.test.ts
  test/unit/db/referrals-rls.integration.test.ts
  test/unit/db/worker-closed-job-read.integration.test.ts
  test/unit/db/wage-references.integration.test.ts
  test/unit/db/pay-reference-lookup.integration.test.ts
  test/unit/db/digest-settings.integration.test.ts
  test/unit/db/media-board-rls.integration.test.ts
  test/unit/db/rls-trust-assessment-employer-read.integration.test.ts
  test/unit/db/admin-analytics.integration.test.ts
  test/unit/db/email-outbox-090.integration.test.ts
  test/unit/db/whatsapp-delivery-retrigger.integration.test.ts
  test/unit/db/twilio-callback-job-outbox-097.integration.test.ts
  test/unit/db/history-capture-1d.integration.test.ts
  test/unit/db/identity-lockouts-1b.integration.test.ts
  test/unit/scripts/run-production-upgrade-020b-040.test.ts
  test/unit/db/scram-verifier.integration.test.ts
  test/unit/db/testbed-login-passwords.integration.test.ts
  test/unit/db/r-paths-pool-identity.integration.test.ts
  test/unit/db/r-paths-job-outbox-sender.integration.test.ts
  test/unit/db/r-paths-applicant-docs.integration.test.ts
  test/unit/db/r-paths-job-matching-geo.integration.test.ts
  test/unit/db/r-paths-job-delete.integration.test.ts
  test/unit/db/r-paths-job-visibility-dedupe.integration.test.ts
  test/unit/db/r-paths-share-link-claim.integration.test.ts
  test/unit/db/r-paths-checkout-release.integration.test.ts
  test/unit/db/r-paths-upload-tokens.integration.test.ts
  test/unit/db/r-paths-employer-messaging.integration.test.ts
  test/unit/db/r-paths-stage-notify.integration.test.ts
  test/unit/db/r-paths-referred-jobs.integration.test.ts
  test/unit/db/r-paths-handler-sweep.integration.test.ts
  test/unit/db/problem-reports-rls.integration.test.ts
  test/unit/db/problem-reports-functions.integration.test.ts
  test/unit/db/problem-reports-cleanup.integration.test.ts
  test/unit/db/problem-reports-handlers.integration.test.ts
  test/unit/db/audit-storage.integration.test.ts
  test/unit/db/audit-export.integration.test.ts
  test/unit/db/audit-history.integration.test.ts
  test/unit/db/audit-admin-legacy.integration.test.ts
  test/unit/db/audit-change-log.integration.test.ts
  test/unit/db/audit-posture.integration.test.ts
  test/unit/db/audit-ops.integration.test.ts
  test/unit/db/d-app-access-records.integration.test.ts
  test/unit/db/d-app-change-context.integration.test.ts
  test/unit/db/d-app-whatsapp-context.integration.test.ts
  test/unit/db/d-app-cascade-parents.integration.test.ts
  test/unit/db/least-privilege-cap-upload-tokens.integration.test.ts
  test/unit/db/least-privilege-cap-worker-lane.integration.test.ts
  test/unit/db/least-privilege-seeded-definers.integration.test.ts
  test/unit/db/least-privilege-denials.integration.test.ts
  test/unit/db/least-privilege-query-plans.integration.test.ts
  test/unit/db/hire-and-resume-125.integration.test.ts
  # 4. The tail, in this order. 093 leases worker_intent rows globally and
  #    advances the attempt count of every row it leases, so it follows every
  #    suite that could own one. Then each suite that re-applies its migration
  #    file as the bed's jale_admin, in migration order: a replay takes ACCESS
  #    EXCLUSIVE locks and backfills every matching row on the bed.
  test/unit/db/worker-intent-defer-093.integration.test.ts
  test/unit/db/sprint24-data-backfills-094.integration.test.ts
  test/unit/db/application-hire-ack-095.integration.test.ts
  test/unit/db/employer-conversation-read.integration.test.ts
  test/unit/db/worker-referred-jobs-103.integration.test.ts
  test/unit/db/access-manifest-alignment-114b.integration.test.ts
)

usage() {
  cat <<'EOF'
Usage: run-whatsapp-v2-db-tests.sh [--suite PATH | --check-results FILE]
  (no argument)          run every suite in SUITES against JALE_TEST_DATABASE_URL
  --suite PATH           run one suite alone (PATH relative to infra/) under the same checks
  --check-results FILE   check a jest JSON results file against SUITES; runs nothing
EOF
}

mode="all"
target=""
case "${1:-}" in
  "")
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    ;;
  --suite | --check-results)
    [[ $# -eq 2 && -n "$2" ]] || { usage >&2; exit 2; }
    mode="${1#--}"
    target="$2"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

profile="${JALE_TEST_DB_PROFILE:-standard}"
case "$profile" in
  standard | request | owner-unrestricted) ;;
  *)
    echo "run-whatsapp-v2-db-tests: JALE_TEST_DB_PROFILE must be standard, request or owner-unrestricted." >&2
    exit 2
    ;;
esac
export JALE_TEST_DB_PROFILE="$profile"

# The commit the results belong to, for the run summary.
commit="$(git -C .. rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=""
if [[ "$commit" != "unknown" && -n "$(git -C .. status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  dirty="1"
fi

# check_results LABEL FILE SUITE...
# Checks a jest --json results file against the suites that should have run,
# in that order. Prints the per-suite counts, appends them to
# $GITHUB_STEP_SUMMARY when it is set, and fails on any problem.
check_results() {
  JALE_DB_TEST_LABEL="$1" JALE_DB_TEST_COMMIT="$commit" JALE_DB_TEST_DIRTY="$dirty" \
    node - "${@:2}" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');

const [resultsFile, ...expected] = process.argv.slice(2);
const label = process.env.JALE_DB_TEST_LABEL;
const profile = process.env.JALE_TEST_DB_PROFILE;
const commit = process.env.JALE_DB_TEST_COMMIT || 'unknown';
const dirty = process.env.JALE_DB_TEST_DIRTY === '1';
const prHead = process.env.JALE_DB_TEST_PR_HEAD || '';
const summaryFile = process.env.GITHUB_STEP_SUMMARY || '';
const problems = [];

let results = null;
try {
  results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  if (!results || !Array.isArray(results.testResults)) throw new Error('it has no testResults list');
} catch (error) {
  results = null;
  problems.push(`no readable jest results at ${resultsFile} (${error.message})`);
}

const root = process.cwd();
const relative = (name) => path.relative(root, String(name)).split(path.sep).join('/');
const firstLine = (text) => String(text).split('\n').map((line) => line.trim()).find((line) => line !== '') || '';
const suites = (results ? results.testResults : [])
  .map((suite) => ({ ...suite, file: relative(suite.name) }))
  .sort((a, b) => a.startTime - b.startTime);

function tally(tests) {
  const counts = { total: tests.length, passed: 0, failed: 0, pending: 0, todo: 0 };
  for (const test of tests) {
    if (test.status === 'passed') counts.passed += 1;
    else if (test.status === 'failed') counts.failed += 1;
    else if (test.status === 'todo') counts.todo += 1;
    else counts.pending += 1; // pending, skipped, disabled, focused
  }
  return counts;
}

if (results) {
  const runs = new Map();
  for (const suite of suites) runs.set(suite.file, (runs.get(suite.file) || 0) + 1);
  for (const file of expected) {
    if (!runs.has(file)) problems.push(`${file}: did not run`);
  }
  for (const [file, count] of runs) {
    if (!expected.includes(file)) problems.push(`${file}: ran, but is not registered`);
    else if (count > 1) problems.push(`${file}: ran ${count} times`);
  }

  const seen = new Set();
  const ranOrder = suites
    .map((suite) => suite.file)
    .filter((file) => expected.includes(file) && !seen.has(file) && seen.add(file));
  const wantedOrder = expected.filter((file) => runs.has(file));
  const at = wantedOrder.findIndex((file, index) => ranOrder[index] !== file);
  if (at !== -1) {
    problems.push(`suites did not run in the declared order: position ${at + 1} should be ${wantedOrder[at]}, ran ${ranOrder[at]}`);
  }

  const LIMIT = 40;
  let notPassed = 0;
  for (const suite of suites) {
    const tests = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    if (tests.length === 0) {
      problems.push(`${suite.file}: ran no tests${suite.message ? ` (${firstLine(suite.message)})` : ''}`);
    }
    if (suite.status !== 'passed') problems.push(`${suite.file}: suite status ${suite.status}`);
    for (const test of tests) {
      if (test.status === 'passed') continue;
      notPassed += 1;
      if (notPassed <= LIMIT) problems.push(`${suite.file} › ${test.fullName}: ${test.status}`);
    }
  }
  if (notPassed > LIMIT) problems.push(`... and ${notPassed - LIMIT} more tests that did not pass`);

  for (const key of [
    'numFailedTests', 'numFailedTestSuites', 'numRuntimeErrorTestSuites',
    'numPendingTests', 'numPendingTestSuites', 'numTodoTests',
  ]) {
    if (results[key]) problems.push(`jest reported ${key} = ${results[key]}`);
  }
  if (results.success !== true) problems.push('jest reported success = false');
  if (results.wasInterrupted) problems.push('jest reported the run as interrupted');
}

const rows = suites.map((suite) => ({
  file: suite.file,
  ...tally(Array.isArray(suite.assertionResults) ? suite.assertionResults : []),
  seconds: ((suite.endTime - suite.startTime) / 1000).toFixed(1),
}));
const totals = rows.reduce(
  (sum, row) => ({
    total: sum.total + row.total,
    passed: sum.passed + row.passed,
    failed: sum.failed + row.failed,
    pending: sum.pending + row.pending,
    todo: sum.todo + row.todo,
  }),
  { total: 0, passed: 0, failed: 0, pending: 0, todo: 0 },
);
const commitText = `${commit}${dirty ? ' (with uncommitted changes)' : ''}`;

const pad = (value, width) => String(value).padStart(width);
console.log('');
console.log(`${label}: ${profile} profile, commit ${commitText}`);
console.log('  tests passed failed pending todo   secs  suite');
for (const row of rows) {
  console.log(`  ${pad(row.total, 5)} ${pad(row.passed, 6)} ${pad(row.failed, 6)} ${pad(row.pending, 7)} ${pad(row.todo, 4)} ${pad(row.seconds, 6)}  ${row.file}`);
}
console.log(`  ${pad(totals.total, 5)} ${pad(totals.passed, 6)} ${pad(totals.failed, 6)} ${pad(totals.pending, 7)} ${pad(totals.todo, 4)}         total, ${rows.length} suites`);

if (summaryFile) {
  const lines = [`### ${label}: ${profile} profile`, '', `Commit \`${commit}\`${dirty ? ' (with uncommitted changes)' : ''}`];
  if (prHead) lines.push('', `Pull request head \`${prHead}\``);
  lines.push('', problems.length
    ? `**Failed:** ${problems.length} problem(s), listed below the table.`
    : `**Passed:** ${expected.length} suite(s), ${totals.total} tests; none failed, pending, todo or skipped.`);
  lines.push('', '| Suite | Tests | Passed | Failed | Pending | Todo | Seconds |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    lines.push(`| ${row.file} | ${row.total} | ${row.passed} | ${row.failed} | ${row.pending} | ${row.todo} | ${row.seconds} |`);
  }
  if (problems.length) {
    lines.push('', 'Problems:', '');
    for (const problem of problems) lines.push(`- ${problem.replace(/\|/g, '\\|')}`);
  }
  fs.appendFileSync(summaryFile, `${lines.join('\n')}\n\n`);
}

if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`!! ${problem}`);
  console.error(`run-whatsapp-v2-db-tests: FAILED with ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`run-whatsapp-v2-db-tests: all ${expected.length} suite(s) ran once, in order; ${totals.total} tests passed, none failed, pending, todo or skipped.`);
JS
}

if [[ "$mode" == "check-results" ]]; then
  check_results "Database suites" "$target" "${SUITES[@]}"
  exit 0
fi

if [[ "$mode" == "all" ]]; then
  if [ -z "${JALE_TEST_DATABASE_URL:-}" ]; then
    echo "run-whatsapp-v2-db-tests: JALE_TEST_DATABASE_URL is not set (or empty)." >&2
    echo "  Refusing to run: the database suites SKIP without a database URL and jest" >&2
    echo "  would otherwise exit 0 without verifying anything. Set it to a local" >&2
    echo "  Postgres 16 SUPERUSER url (every migration on disk applied), then re-run." >&2
    echo "  The value is never printed." >&2
    exit 1
  fi

  # Fail LOUDLY and fast on a non-superuser URL, or on a bed that does not
  # match the profile, rather than deep inside a beforeAll. Uses node + the
  # repo's own `pg` (psql is not installed on CI images) and a hard connect
  # timeout, so an unreachable host is a 5-second error rather than a hang. The
  # URL is passed through the environment and never interpolated into the
  # program text, so it cannot reach a log line or a process listing.
  if ! node -e '
    const { Client } = require("pg");
    const profile = process.env.JALE_TEST_DB_PROFILE;
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
      .then(() => c.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = $1", ["jale_admin"]))
      .then((r) => {
        if (!r.rows[0]) {
          console.error("  connected, but the bed has no jale_admin role: the migrations are not applied.");
          process.exit(4);
        }
        if (r.rows[0].rolbypassrls !== (profile === "owner-unrestricted")) {
          console.error("  the bed does not match JALE_TEST_DB_PROFILE=" + profile + ": jale_admin "
            + (r.rows[0].rolbypassrls ? "has" : "lacks") + " BYPASSRLS.");
          process.exit(5);
        }
      })
      .then(() => c.end())
      .catch((e) => { console.error("  " + e.message); process.exit(3); });
  ' 2>&1; then
    echo "run-whatsapp-v2-db-tests: JALE_TEST_DATABASE_URL is unusable." >&2
    echo "  These suites need a disposable local database with every migration on disk" >&2
    echo "  applied, bootstrapped for the profile in JALE_TEST_DB_PROFILE and reached as" >&2
    echo "  a SUPERUSER: they ALTER ROLE to set test passwords, insert fixtures past RLS," >&2
    echo "  and read columns the runtime roles are not granted. Refusing to run. The" >&2
    echo "  value is never printed." >&2
    exit 1
  fi
  label="Database suites"
  expected=("${SUITES[@]}")
else
  label="Database suite, run alone"
  expected=("$target")
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
results="${JALE_DB_TEST_RESULTS:-$work/jest-results.json}"
mkdir -p "$(dirname "$results")"
# Never check a results file an earlier run left behind.
rm -f "$results"

# The sequencer that makes jest run the suites in the order listed here.
printf '%s\n' "${expected[@]}" > "$work/suite-order.txt"
cat > "$work/declared-order-sequencer.cjs" <<'JS'
'use strict';
// Written by run-whatsapp-v2-db-tests.sh. Runs the suites in the order the
// script lists them, where jest's default sequencer would sort them by past
// failures, duration and file size.
const fs = require('fs');
const path = require('path');

const order = fs.readFileSync(path.join(__dirname, 'suite-order.txt'), 'utf8').split('\n').filter(Boolean);
const rank = new Map(order.map((file, index) => [file, index]));
const position = (test) => {
  const file = path.relative(process.cwd(), test.path).split(path.sep).join('/');
  return rank.has(file) ? rank.get(file) : order.length;
};

module.exports = class DeclaredOrderSequencer {
  sort(tests) {
    return [...tests].sort((a, b) => position(a) - position(b));
  }

  cacheResults() {}

  allFailedTests(tests) {
    return tests;
  }
};
JS

echo ">> ${#expected[@]} suite(s), ${profile} profile, in the declared order"
jest_status=0
npx jest --runInBand --runTestsByPath --testSequencer "$work/declared-order-sequencer.cjs" \
  --json --outputFile "$results" "${expected[@]}" || jest_status=$?

check_status=0
check_results "$label" "$results" "${expected[@]}" || check_status=$?
if [[ "$jest_status" -ne 0 || "$check_status" -ne 0 ]]; then
  echo "run-whatsapp-v2-db-tests: FAILED (jest exit ${jest_status}, results check exit ${check_status})." >&2
  exit 1
fi
