// Admin UI contract: the analytics read model (BE-3a).
// admin-analytics.ts: which loader records which surface, and the SQL each
// read model calls.
// Split out of check-ui-contract.mjs in sprint 28 step 0; the assertions are
// unchanged.
import assert from 'node:assert/strict';
import { read } from './lib/ui-contract-helpers.mjs';

const analyticsReadModel = read('src/lib/server/admin-analytics.ts');

// --- Roadmap 2b: employer health ----------------------------------------------
for (const [loader, surface] of [
  ['loadSlowestEmployers', 'admin.analytics_slowest_employers'],
  ['loadCompanies', 'admin.analytics_companies'],
  ['loadStaleJobs', 'admin.analytics_stale_jobs'],
]) {
  const body = analyticsReadModel.match(new RegExp(`export async function ${loader}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? '';
  assert.match(body, /withAdminReadTransaction\(session, async \(client\) =>/, `${loader} reads in one recorded transaction`);
  assert.match(body, new RegExp(`recordAdminAccess\\(session, \\{\\s*surface: '${surface.replace('.', '\\.')}'`), `${loader} records ${surface} before COMMIT`);
  assert.match(body, new RegExp(`recordAdminAttempt\\(session, \\{\\s*surface: '${surface.replace('.', '\\.')}'`), `a failed ${loader} records a failed attempt`);
}
// The stale jobs record names exactly the rows the list renders: the same
// helper and limit as StaleJobsList.
assert.match(analyticsReadModel, /const \{ shown \} = firstWithRest\(rows, STALE_JOBS_SHOWN\);/, 'the loader records the rendered slice');
for (const [pattern, point] of [
  [/admin_analytics_employer_weekly\(\$1\)',\s*\[weeks\],/, 'weekly(weeks)'],
  [/admin_analytics_slowest_employers\(\$1, \$2\)',\s*\[weeks, SLOWEST_EMPLOYERS_LIMIT\],/, 'slowest(weeks, 10)'],
  [/admin_analytics_stale_jobs\(\$1\)',\s*\[days\],/, 'stale(days)'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}

// --- Phase 5: companies ----------------------------------------------------------
for (const [pattern, point] of [
  [/'SELECT \* FROM admin_analytics_companies\(\$1::int, NULL\)',\s*\[COMPANIES_LIMIT\],/, 'companies(100, NULL)'],
  [/'SELECT \* FROM admin_analytics_companies\(1, \$1::uuid\)',\s*\[organizationId\],/, 'companies(1, id)'],
  [/'SELECT \* FROM admin_analytics_company_members\(\$1::uuid\)',\s*\[organizationId\],/, 'company_members(id)'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
// The pages: the Employers tab loads the panel through the recorded loader; the
// company page loads once (every load writes an audit record, so no second
// load for metadata) and never reads unrecorded.
const employersPage = read('src/app/(console)/analytics/employers/page.tsx');
assert.match(employersPage, /loadCompanies\(session\)/, 'the Employers tab calls loadCompanies with the session');
const companyPage = read('src/app/(console)/analytics/employers/[organizationId]/page.tsx');
assert.equal((companyPage.match(/loadCompany\(/g) ?? []).length, 1, 'the company page calls loadCompany once');
assert.doesNotMatch(companyPage, /generateMetadata|cache\(/, 'the company page has a static title and no second load');

// --- Roadmap 2c: ops health ---------------------------------------------------
for (const [pattern, point] of [
  [/pool\.query<MessageBacklogRow>\('SELECT \* FROM admin_analytics_message_backlog\(\)'\)/, 'message_backlog()'],
  [/pool\.query<MessageFailuresRow>\(\s*'SELECT \* FROM admin_analytics_message_failures\(\$1\)',\s*\[weeks\],\s*\)/, 'message_failures(weeks)'],
  [/pool\.query<VoiceExtractionRow>\(\s*'SELECT \* FROM admin_analytics_voice_extraction\(\$1\)',\s*\[weeks\],\s*\)/, 'voice_extraction(weeks)'],
  [/pool\.query<TrustExtractionRow>\(\s*'SELECT \* FROM admin_analytics_trust_extraction\(\$1\)',\s*\[weeks\],\s*\)/, 'trust_extraction(weeks)'],
  [/pool\.query<BillingInboxRow>\(\s*'SELECT \* FROM admin_analytics_billing_inbox\(\$1\)',\s*\[weeks\],\s*\)/, 'billing_inbox(weeks)'],
  [/pool\.query<BillingInboxNowRow>\('SELECT \* FROM admin_analytics_billing_inbox_now\(\)'\)/, 'billing_inbox_now()'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
assert.match(
  analyticsReadModel,
  /if \(!row\) \{\n    throw new Error\('admin_analytics_billing_inbox_now\(\) returned no row'\);/,
  'a missing live billing row is an error, never "nothing stuck"',
);

// --- Roadmap 2d: operator resets and the applicant digest --------------------
for (const [pattern, point] of [
  [/pool\.query<OnboardingRestartRow>\(\s*'SELECT \* FROM admin_analytics_onboarding_restarts\(\$1\)',\s*\[weeks\],\s*\)/, 'onboarding_restarts(weeks)'],
  [/pool\.query<OperatorResetRow>\(\s*'SELECT \* FROM admin_analytics_operator_resets\(\$1\)',\s*\[weeks\],\s*\)/, 'operator_resets(weeks)'],
  [/pool\.query<DigestAdoptionRow>\('SELECT \* FROM admin_analytics_digest_adoption\(\)'\)/, 'digest_adoption()'],
  [/pool\.query<DigestSendsRow>\(\s*'SELECT \* FROM admin_analytics_digest_sends\(\$1\)',\s*\[weeks\],\s*\)/, 'digest_sends(weeks)'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
assert.match(
  analyticsReadModel,
  /if \(!row\) \{\n    throw new Error\('admin_analytics_digest_adoption\(\) returned no row'\);/,
  'a missing adoption row is an error, never "digest on for 0%"',
);

console.log('admin UI analytics server contract checks passed');
