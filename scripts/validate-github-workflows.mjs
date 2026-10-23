import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const requiredFiles = [
  '.github/CODEOWNERS',
  '.github/actions/setup-node-cache/action.yml',
  '.github/actions/aws-oidc-login/action.yml',
  '.github/workflows/pr-validate.yml',
  '.github/workflows/deploy-production.yml',
  '.github/workflows/_reusable-validate.yml',
  '.github/workflows/_reusable-deploy.yml',
  'scripts/run-admin-migration.ps1',
  'scripts/bootstrap-admin-user.ps1',
  'scripts/deploy-bastion.ps1',
  'scripts/deploy-bastion.sh',
  'scripts/run-production-upgrade-020b-040.sh',
  'docs/production-upgrade-020b-040.md',
  'infra/scripts/check-prepared-login-secrets.ts',
];

function fail(message) {
  console.error(`CI workflow validation failed: ${message}`);
  process.exitCode = 1;
}

function readRequired(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    fail(`missing ${path}`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}

function requireIncludes(file, content, expected) {
  if (!content.includes(expected)) {
    fail(`${file} must include ${expected}`);
  }
}

function requireMatches(file, content, pattern, description) {
  if (!pattern.test(content)) {
    fail(`${file} must include ${description}`);
  }
}

/**
 * Slices out one top-level job block (from its `  <name>:` line up to but not
 * including the next top-level job's `  <name>:` line) so assertions about a
 * specific job cannot be satisfied by a string living in a different job.
 */
function sliceJobBlock(file, content, startLabel, endLabel) {
  const start = content.indexOf(startLabel);
  const end = start === -1 ? -1 : content.indexOf(endLabel, start + startLabel.length);
  if (start === -1 || end === -1) {
    fail(`${file}: could not locate job block between ${JSON.stringify(startLabel)} and ${JSON.stringify(endLabel)}`);
    return '';
  }
  return content.slice(start, end);
}

/**
 * Every `bash -n` invocation in `content` whose arguments are not exactly one
 * plain file: an array expansion, a glob, or two or more arguments. YAML
 * comment lines are ignored, and the arguments end at the first shell
 * separator, so `for f in ...; do bash -n "$f"; done` reads as one argument.
 */
function multiFileBashSyntaxChecks(content) {
  const offending = [];
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(/\bbash\s+-n\b([^;&|)\n]*)/g)) {
      const args = match[1].trim().split(/\s+/).filter((arg) => arg !== '' && arg !== '--');
      if (args.length !== 1 || /\[[@*]\]|[*?]/.test(args[0])) {
        offending.push(match[0].trim());
      }
    }
  }
  return offending;
}

/**
 * The text of every `run:` script in a workflow: an inline value, or every
 * line of a block scalar (`run: |`), so a check sees the whole script and
 * not only the line that holds the key.
 */
function runScripts(content) {
  const lines = content.split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    if (!/^[|>][-+]?\s*$/.test(match[2])) {
      scripts.push(match[2]);
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

for (const file of requiredFiles) {
  readRequired(file);
}

const prValidate = readRequired('.github/workflows/pr-validate.yml');
const deployProduction = readRequired('.github/workflows/deploy-production.yml');
const reusableValidate = readRequired('.github/workflows/_reusable-validate.yml');
const reusableDeploy = readRequired('.github/workflows/_reusable-deploy.yml');
const setupNode = readRequired('.github/actions/setup-node-cache/action.yml');
const awsLogin = readRequired('.github/actions/aws-oidc-login/action.yml');
const codeowners = readRequired('.github/CODEOWNERS');
const adminMigration = readRequired('scripts/run-admin-migration.ps1');
const adminBootstrap = readRequired('scripts/bootstrap-admin-user.ps1');
const bastionDeploy = readRequired('scripts/deploy-bastion.ps1');
const bastionDeploySh = readRequired('scripts/deploy-bastion.sh');

requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'pull_request:');
requireMatches('.github/workflows/pr-validate.yml', prValidate, /branches:\s*\[[^\]]*prod[^\]]*\]/, 'prod pull request validation');
requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'cancel-in-progress: true');
requireIncludes('.github/workflows/pr-validate.yml', prValidate, 'contents: read');

requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'deploy-production');
requireMatches('.github/workflows/deploy-production.yml', deployProduction, /branches:\s*\[\s*prod\s*\]/, 'push trigger for prod only');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "github.ref == 'refs/heads/prod'");
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'Require prod branch');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'cancel-in-progress: false');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'id-token: write');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, '_reusable-deploy.yml');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "grep -Ev '^infra/package(-lock)?\\.json$'");
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'admin-prerequisites');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleDatabaseStack JaleAdminCertStack');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleDatabaseStack JaleDocumentsStack JaleWhatsAppStack JaleReportsStack JaleAdminStack');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "vars.CDK_CONTEXT_ENVIRONMENT || 'production'");

requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run build');
// test:ci (plain jest) rather than `npm test`: the default test script
// carries --maxWorkers=2 (dev-host OOM cap) and jest rejects combining
// --maxWorkers with --runInBand in a single invocation.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:ci -- --runInBand');
// The unit tests run in the infra-tests job, one jest --shard per matrix
// entry. The shard list must be exactly 1..N for the N in --shard=<i>/N, or
// some test files would run in no shard (a list short of N) or a shard would
// fail on an index above N.
const infraTestsJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '\n  infra-tests:\n', '\n  database:\n');
{
  const label = '.github/workflows/_reusable-validate.yml (infra-tests job)';
  if (!infraTestsJob.includes('\n      fail-fast: false\n')) {
    fail(`${label} must set fail-fast: false, so every shard reports its own result`);
  }
  const shardList = infraTestsJob.match(/\n {8}shard: \[([0-9, ]+)\]\n/);
  const shardRun = infraTestsJob.match(/\n {8}run: npm run test:ci -- --runInBand --shard=\$\{\{ matrix\.shard \}\}\/([0-9]+)\n/);
  if (shardList === null) {
    fail(`${label} must list its shards as matrix shard: [1, 2, ...]`);
  } else if (shardRun === null) {
    fail(`${label} must run exactly: npm run test:ci -- --runInBand --shard=\${{ matrix.shard }}/<N>`);
  } else {
    const shards = shardList[1].split(',').map((value) => Number(value.trim()));
    const total = Number(shardRun[1]);
    const expected = Array.from({ length: total }, (_, index) => index + 1);
    if (total < 2 || shards.join(',') !== expected.join(',')) {
      fail(`${label} must list shards [${expected.join(', ')}] for --shard=<i>/${total} (found [${shards.join(', ')}])`);
    }
  }
}
// The infra job builds and synthesizes only: a second jest run there would
// repeat every shard's work.
const infraBuildJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '\n  infra:\n', '\n  infra-tests:\n');
if (infraBuildJob.includes('npm run test:ci') || /\bnpx jest\b/.test(infraBuildJob)) {
  fail('.github/workflows/_reusable-validate.yml (infra job) must not run the unit tests; the infra-tests job runs them in shards');
}
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npx cdk synth');
// `--all` is not a valid `cdk synth` option in the CDK 2.1133+ CLI this repo
// pins (it prints "Unknown option(s): --all" and is ignored); `cdk synth`
// with no stack argument already synthesizes every stack.
if (reusableValidate.includes('cdk synth --all')) {
  fail('.github/workflows/_reusable-validate.yml must not pass --all to cdk synth (not a valid option; omit the stack argument to synth everything)');
}
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c emailFromAddress=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesVerifiedIdentityArn=');
// Cognito employer-pool SES sender: CI synth must exercise the auth-stack SES
// branch (it is dead code unless sesEmailFromAddress is supplied).
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesEmailFromAddress=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesEmailRegion=us-east-1');
// The CI synth must resolve the deploy's main region. The CDK CLI overrides
// CDK_DEFAULT_REGION with the region it resolves itself (us-east-1 with no AWS
// configuration), and the app builds its edge stacks around the main region,
// so the synth step sets AWS_REGION from the region input, as
// _reusable-deploy.yml does. It is set in that step's own env, so no other step
// of the infra job changes.
const infraJob = infraBuildJob;
const synthStep = infraJob.split('\n      - name: ').find((block) => block.startsWith('CDK synth backend stacks\n'));
if (synthStep === undefined) {
  fail('.github/workflows/_reusable-validate.yml (infra job) must have a step named CDK synth backend stacks');
} else {
  requireMatches(
    '.github/workflows/_reusable-validate.yml (infra job, step CDK synth backend stacks)',
    synthStep,
    /\n {8}env:\n(?: {10}.*\n| *#.*\n)*? {10}AWS_REGION: \$\{\{ inputs\.aws-region \}\}\n/,
    'AWS_REGION: ${{ inputs.aws-region }} in the step env',
  );
}
const infraJobHead = infraJob.slice(0, infraJob.indexOf('\n    steps:\n'));
if (/\bAWS_REGION:/.test(infraJobHead)) {
  fail('.github/workflows/_reusable-validate.yml (infra job) must set AWS_REGION in the synth step env only, not in the job env');
}
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c whatsappAlarmTopicArn=');
// BillingStack alarms reuse the same monitored ops topic as the WhatsApp/AI/
// referrals alarms; without this context key the stack falls back to creating
// a bare jale-billing-alarms topic that has no subscribers.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c billingAlarmTopicArn=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm audit --audit-level=high');
// Lane D removes the xlsx devDependency that forced --omit=dev (GHSA-4r6h-8v6p-xvw6,
// no npm fix published); once that lands, the infra audit step must cover the
// FULL dependency tree, not skip devDependencies.
if (reusableValidate.includes('npm audit --omit=dev')) {
  fail('.github/workflows/_reusable-validate.yml must not run npm audit --omit=dev (Lane D removed the devDependency that required it)');
}
// The frontend/admin audit runs through the dated-exception gate (currently
// with an empty exception list -- see .github/audit-exceptions.json) rather
// than a plain `npm audit`, so a future unfixable advisory can be excused on
// the record instead of the job silently going red or being hand-waved past;
// the self-tests are what keep the gate honest.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'node ../scripts/npm-audit-gate.mjs --level critical');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'node --test "${tests[@]}"');

// `bash -n` checks ONE script. Given several, bash reads the first and hands
// the rest to it as positional arguments, so `bash -n a.sh b.sh` exits 0 with
// b.sh broken. The script-syntax job must therefore check each file on its
// own, and no workflow may pass `bash -n` an array, a glob or a second file.
const scriptsJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '  scripts:', '  infra:');
requireIncludes('.github/workflows/_reusable-validate.yml (scripts job)', scriptsJob, 'for f in "${scripts[@]}"; do');
requireIncludes('.github/workflows/_reusable-validate.yml (scripts job)', scriptsJob, 'bash -n "$f"');
// Every shell script in the repository is syntax-checked, wherever it lives.
requireIncludes('.github/workflows/_reusable-validate.yml (scripts job)', scriptsJob, "find . -name '*.sh'");
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'node scripts/validate-github-workflows.mjs');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'working-directory: admin');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:session');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'npm run test:dispatch');

// Job-scoped checks: Next 16's `next build` no longer runs ESLint, so the
// frontend job must lint, typecheck, and test on its own before building.
// Sliced to the frontend job block so a script living in a neighbouring job
// (e.g. the infra job's `npm run test:ci`) cannot satisfy these by accident.
const frontendJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '  frontend:', '  admin:');
requireIncludes('.github/workflows/_reusable-validate.yml (frontend job)', frontendJob, 'npm run lint');
requireIncludes('.github/workflows/_reusable-validate.yml (frontend job)', frontendJob, 'npx tsc --noEmit');
requireIncludes('.github/workflows/_reusable-validate.yml (frontend job)', frontendJob, 'npm test');

// F31: the job step above is only half the guarantee. `npm test` runs whatever
// frontend/package.json says, and vitest's DEFAULT mode is watch -- a script
// changed from `vitest run` to `vitest` would keep this job green in every
// local check and then hang the runner until the 20-minute timeout killed it,
// which reads as a flaky CI box rather than a broken test script.
const frontendPackageJson = readRequired('frontend/package.json');
if (frontendPackageJson) {
  let frontendTestScript = '';
  try {
    frontendTestScript = JSON.parse(frontendPackageJson).scripts?.test ?? '';
  } catch {
    fail('frontend/package.json is not valid JSON');
  }
  if (!/(^|\s)vitest\s+run(\s|$)/.test(frontendTestScript)) {
    fail(
      "frontend/package.json's `test` script must run vitest in NON-watch mode "
      + `(expected \`vitest run\`, found ${JSON.stringify(frontendTestScript)})`,
    );
  }
}

// The database job runs every PostgreSQL-backed suite in each test-bed
// profile. bootstrap-testbed.sh starts its own postgres:16 container with the
// runner's Docker and applies every migration on disk; the runner fails on any
// suite that did not run, ran out of order, or skipped a test. The two
// clean-apply suites need a cluster of their own each, so they run alone on
// fresh beds in the standard leg, as do the admin dashboard's access-record
// and report checks. Results are uploaded under the commit SHA and the
// profile. The job needs no credentials, so it may use none.
const databaseJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '\n  database:\n', '\n  frontend:\n');
for (const expected of [
  'profile: [standard, request, owner-unrestricted]',
  'fail-fast: false',
  'uses: ./.github/actions/setup-node-cache',
  'working-directory: infra',
  'PROFILE: ${{ matrix.profile }}',
  'bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile "$PROFILE" -- bash infra/scripts/run-whatsapp-v2-db-tests.sh',
  'JALE_DB_TEST_RESULTS: ${{ runner.temp }}/db-results/',
  'uses: actions/upload-artifact@v7',
  'name: db-suites-${{ github.sha }}-${{ matrix.profile }}',
  'path: ${{ runner.temp }}/db-results',
]) {
  requireIncludes('.github/workflows/_reusable-validate.yml (database job)', databaseJob, expected);
}
requireMatches('.github/workflows/_reusable-validate.yml (database job)', databaseJob, /\n    timeout-minutes: \d+\n/, 'a job timeout-minutes');
// The database job's steps by name. Each standard-leg step runs on a bed of
// its own whatever an earlier step did, so every suite and check reports its
// own result, and each runs its exact command: the admin checks report a skip
// and pass when no test bed exported a database URL, so they must run under
// bootstrap-testbed.sh. The main step runs in every leg.
const databaseSteps = new Map(
  databaseJob.split('\n      - name: ').slice(1).map((block) => [block.slice(0, block.indexOf('\n')), `${block}\n`]),
);
const STANDARD_LEG_ONLY = "\n        if: ${{ !cancelled() && matrix.profile == 'standard' }}\n";
const standardLegSteps = [
  ['Run migration apply-order suite (empty cluster)', [
    '\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --empty -- bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/apply-order.test.ts\n',
  ]],
  ['Run billing upgrade suite (bare cluster)', [
    '\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL -- bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/billing-034-upgrade.test.ts\n',
  ]],
  ['Run employer organizations upgrade suite (bare cluster)', [
    '\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL -- bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/employer-organizations-118-upgrade.test.ts\n',
  ]],
  ['Run company billing upgrade suite (bare cluster)', [
    '\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL -- bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/company-billing-127-upgrade.test.ts\n',
  ]],
  ['Run migration 119 apply-order suite (bare cluster)', [
    '\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL -- bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/migration-119-out-of-order.test.ts\n',
  ]],
  ['Setup admin dependencies', [
    '\n        uses: ./.github/actions/setup-node-cache\n',
    '\n          working-directory: admin\n',
  ]],
  ['Run admin access-record checks', [
    "\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile standard -- bash -c 'cd admin && npm run test:audit-db'\n",
  ]],
  ['Run admin report checks', [
    "\n        run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile standard -- bash -c 'cd admin && npm run test:report-db'\n",
  ]],
];
for (const [name, expected] of standardLegSteps) {
  const block = databaseSteps.get(name);
  if (block === undefined) {
    fail(`.github/workflows/_reusable-validate.yml (database job) must have a step named ${name}`);
    continue;
  }
  for (const text of [STANDARD_LEG_ONLY, ...expected]) {
    if (!block.includes(text)) {
      fail(`.github/workflows/_reusable-validate.yml (database job, step ${name}) must include the line ${text.trim()}`);
    }
  }
}
const standardLegConditions = databaseJob.split(STANDARD_LEG_ONLY.trim()).length - 1;
if (standardLegConditions !== standardLegSteps.length) {
  fail(
    `.github/workflows/_reusable-validate.yml (database job) must run exactly ${standardLegSteps.length} steps `
    + `in the standard leg only (found ${standardLegConditions})`,
  );
}
if (/\n        if:/.test(databaseSteps.get('Run database suites') ?? '\n        if:')) {
  fail('.github/workflows/_reusable-validate.yml (database job) must run the database suites, unconditionally, in every leg');
}
const databaseStepNames = [...databaseSteps.keys()];
if (databaseStepNames.indexOf('Setup admin dependencies') + 1 !== databaseStepNames.indexOf('Run admin access-record checks')) {
  fail('.github/workflows/_reusable-validate.yml (database job) must set up the admin dependencies just before the admin access-record checks');
}
if (databaseStepNames.indexOf('Run admin access-record checks') + 1 !== databaseStepNames.indexOf('Run admin report checks')) {
  fail('.github/workflows/_reusable-validate.yml (database job) must run the admin report checks right after the admin access-record checks');
}
for (const [pattern, description] of [
  [/secrets\./, 'a repository secret'],
  [/id-token:/, 'an OIDC token permission'],
  [/aws-oidc-login|configure-aws-credentials/, 'an AWS credentials action'],
  [/\baws\s+[a-z]/, 'an AWS CLI command'],
]) {
  if (pattern.test(databaseJob)) {
    fail(`.github/workflows/_reusable-validate.yml (database job) must not use ${description}`);
  }
}

// The admin job must build BEFORE typecheck (Next generates `.next/types`
// during build, which the typecheck now references) and must run all 11
// admin contract-check scripts, not 10.
const adminJob = sliceJobBlock('.github/workflows/_reusable-validate.yml', reusableValidate, '  admin:', '  security:');
requireIncludes('.github/workflows/_reusable-validate.yml (admin job)', adminJob, 'npm run test:charts');
const adminBuildIndex = adminJob.indexOf('npm run build');
const adminTypecheckIndex = adminJob.indexOf('npm run typecheck');
if (adminBuildIndex === -1 || adminTypecheckIndex === -1 || adminBuildIndex >= adminTypecheckIndex) {
  fail(
    '.github/workflows/_reusable-validate.yml (admin job) must run `npm run build` before `npm run typecheck` '
    + `(build at ${adminBuildIndex}, typecheck at ${adminTypecheckIndex})`,
  );
}

requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'workflow_call:');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'environment: ${{ inputs.github-environment }}');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'plan:\n    name: Production plan\n    runs-on: ubuntu-latest\n    environment: ${{ inputs.github-environment }}');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'JaleFrontendStack');
if (reusableDeploy.includes('JaleBastionStack')) {
  fail('.github/workflows/_reusable-deploy.yml must not deploy JaleBastionStack by default');
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk diff');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '--no-change-set');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'cdk deploy');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c deletionProtection=true');
// The flag must ride on ALL FOUR cdk invocations -- plan synth, plan diff,
// deploy diff, deploy. It is app-global context, so it is what arms
// DeletionProtection on the RDS instance and on all three Cognito pools; a
// diff run without it plans INACTIVE and the operator reviews the wrong plan.
const deletionProtectionFlags = reusableDeploy.match(/-c deletionProtection=true/g) ?? [];
if (deletionProtectionFlags.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass -c deletionProtection=true on all four cdk '
    + `invocations (plan synth, plan diff, deploy diff, deploy); found ${deletionProtectionFlags.length}`,
  );
}
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_EMAIL_FROM_ADDRESS');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'BILLING_SES_VERIFIED_IDENTITY_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c emailFromAddress=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c sesVerifiedIdentityArn=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'COGNITO_EMAIL_FROM_ADDRESS: ${{ vars.COGNITO_EMAIL_FROM_ADDRESS }}');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'Require Cognito SES sender variable');
// The guard must run in BOTH jobs: the plan job is skipped entirely when no
// plan role is configured, and the deploy job is the one that can break prod.
const cognitoSenderGuards = reusableDeploy.match(/- name: Require Cognito SES sender variable/g) ?? [];
if (cognitoSenderGuards.length !== 2) {
  fail(
    '.github/workflows/_reusable-deploy.yml must guard COGNITO_EMAIL_FROM_ADDRESS in both the plan and deploy jobs',
  );
}
// Database posture, checked before and after the CDK deploy
// (infra/scripts/db-posture-gate.mjs). The override and its free-text reason
// reach the script through `env:` only: an expression interpolated into a
// `run:` script is spliced into the shell before it runs.
const deployJobStart = reusableDeploy.indexOf('\n  deploy:\n');
const deployJob = deployJobStart === -1 ? '' : reusableDeploy.slice(deployJobStart);
if (deployJobStart === -1) {
  fail('.github/workflows/_reusable-deploy.yml: could not locate the deploy job');
}
const deploySteps = deployJob.split('\n      - name: ').slice(1).map((block) => ({
  name: block.slice(0, block.indexOf('\n')).trim(),
  block,
}));
const deployStepNames = deploySteps.map((step) => step.name);
const postureOrder = [
  'Run CDK diff after approval',
  'Database posture gate',
  'Deploy CDK stacks',
  'Database posture verification',
  'Scrub deployment artifacts',
  'Upload deployment artifacts',
];
const postureAt = postureOrder.map((name) => deployStepNames.indexOf(name));
if (postureAt.includes(-1) || postureAt.some((at, index) => index > 0 && at !== postureAt[index - 1] + 1)) {
  fail(
    '.github/workflows/_reusable-deploy.yml (deploy job) must run these steps back to back, in this order: '
    + `${postureOrder.join(' -> ')} (found them at step positions ${postureAt.join(', ')})`,
  );
}
// Nothing may let the deploy past a failed gate, or ignore the verification
// after it: no condition (`if:`) and no `continue-on-error` on either posture
// step or on "Deploy CDK stacks", and nothing appended to the gate's command
// (`|| true`). Each posture step is therefore pinned whole, as the lines it
// must be, and the deploy step may set only its four keys. Each of the three
// steps appears once, so a copy elsewhere in the job cannot satisfy a check.
/** A step's text without the blank and comment lines that trail it (they introduce the next step). */
function stepText(block) {
  const lines = block.split('\n');
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim().startsWith('#'))) {
    lines.pop();
  }
  return lines.join('\n');
}
/** A step's own keys: its lines at the step's indentation, comments aside, each up to its first colon, unquoted. */
function stepKeys(block) {
  return block.split('\n').slice(1)
    .filter((line) => /^ {8}\S/.test(line) && !line.trimStart().startsWith('#'))
    .map((line) => line.trim().split(':')[0].trim().replace(/^(["'])(.*)\1$/, '$2'));
}
for (const name of ['Database posture gate', 'Deploy CDK stacks', 'Database posture verification']) {
  const count = deployStepNames.filter((candidate) => candidate === name).length;
  if (count !== 1) {
    fail(`.github/workflows/_reusable-deploy.yml (deploy job) must have exactly one step named ${name} (found ${count})`);
  }
}
// The gate before the deploy first writes this release's posture expectation
// (infra/scripts/write-posture-expectation.ts) and checks against it, so its
// run block is pinned whole too: the writer, then the gate with --expected,
// under set -euo pipefail, so a failed writer stops the step before the gate.
const POSTURE_EXPECTATION_FILE = '"$RUNNER_TEMP/posture-expected.json"';
const postureRuns = {
  pre: {
    lines: [
      '        run: |',
      '          set -euo pipefail',
      `          npx --no-install tsx scripts/write-posture-expectation.ts ${POSTURE_EXPECTATION_FILE}`,
      `          node scripts/db-posture-gate.mjs --phase pre --expected ${POSTURE_EXPECTATION_FILE}`,
    ],
    described: 'a run block of exactly set -euo pipefail, then npx --no-install tsx scripts/write-posture-expectation.ts '
      + `${POSTURE_EXPECTATION_FILE}, then node scripts/db-posture-gate.mjs --phase pre --expected ${POSTURE_EXPECTATION_FILE}`,
  },
  post: {
    lines: ['        run: node scripts/db-posture-gate.mjs --phase post'],
    described: 'the whole command node scripts/db-posture-gate.mjs --phase post',
  },
};
for (const [name, phase] of [['Database posture gate', 'pre'], ['Database posture verification', 'post']]) {
  const step = deploySteps.find((candidate) => candidate.name === name);
  if (!step) continue;
  const pinned = [
    name,
    '        working-directory: infra',
    '        shell: bash',
    '        env:',
    '          POSTURE_OVERRIDE: ${{ inputs.posture-override }}',
    '          POSTURE_OVERRIDE_REASON: ${{ inputs.posture-override-reason }}',
    ...postureRuns[phase].lines,
  ].join('\n');
  if (stepText(step.block) !== pinned) {
    fail(
      `.github/workflows/_reusable-deploy.yml (deploy job, ${name}) must be exactly the pinned step: working-directory infra, `
      + `shell bash, the two override variables and nothing else in env, and ${postureRuns[phase].described}; `
      + 'no condition and no continue-on-error',
    );
  }
}
const deployStep = deploySteps.find((candidate) => candidate.name === 'Deploy CDK stacks');
if (deployStep) {
  const keys = stepKeys(deployStep.block);
  if ([...keys].sort().join(' ') !== 'env run shell working-directory') {
    fail(
      '.github/workflows/_reusable-deploy.yml (deploy job, Deploy CDK stacks) must set only working-directory, shell, env and run '
      + `(found ${keys.join(', ')}): a condition or continue-on-error would let it run after a failed gate`,
    );
  }
}
requireMatches(
  '.github/workflows/_reusable-deploy.yml',
  reusableDeploy,
  /\n {6}posture-override:\n(?: {8}.*\n)*? {8}type: boolean\n/,
  'a boolean posture-override workflow_call input',
);
requireMatches(
  '.github/workflows/_reusable-deploy.yml',
  reusableDeploy,
  /\n {6}posture-override-reason:\n(?: {8}.*\n)*? {8}type: string\n/,
  'a string posture-override-reason workflow_call input',
);
requireMatches(
  '.github/workflows/deploy-production.yml',
  deployProduction,
  /\n {6}posture_override:\n(?: {8}.*\n)*? {8}type: boolean\n/,
  'a boolean posture_override workflow_dispatch input',
);
requireMatches(
  '.github/workflows/deploy-production.yml',
  deployProduction,
  /\n {6}posture_override_reason:\n(?: {8}.*\n)*? {8}type: string\n/,
  'a string posture_override_reason workflow_dispatch input',
);
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, 'posture-override: ${{ inputs.posture_override == true }}');
requireIncludes('.github/workflows/deploy-production.yml', deployProduction, "posture-override-reason: ${{ inputs.posture_override_reason || '' }}");
for (const [file, content] of [
  ['.github/workflows/_reusable-deploy.yml', reusableDeploy],
  ['.github/workflows/deploy-production.yml', deployProduction],
]) {
  for (const script of runScripts(content)) {
    if (/\$\{\{[^}]*posture/i.test(script)) {
      fail(`${file} must pass the posture override and its reason to a run script through env, never as a \${{ }} expression in run:`);
    }
  }
}

// The prepared-login secrets check (infra/scripts/check-prepared-login-secrets.ts):
// the stacks import those secrets by name, which deploys green even when one
// is missing. It runs in the deploy job only, on every deploy, once the
// credentials and the infra dependencies are in place and before anything
// deploys. The run log is public: the script prints counts only, and the
// step discards its stderr, because AWS error text carries the account, the
// role and the secret name.
const SECRETS_CHECK = 'Check prepared-login secrets';
const secretsCheckSteps = reusableDeploy.split(`\n      - name: ${SECRETS_CHECK}\n`).length - 1;
const secretsCheck = deploySteps.find((step) => step.name === SECRETS_CHECK);
if (secretsCheckSteps !== 1 || !secretsCheck) {
  fail(
    `.github/workflows/_reusable-deploy.yml must run the step ${SECRETS_CHECK} once, in the deploy job and not the plan job `
    + `(found ${secretsCheckSteps}${secretsCheck ? '' : ', none in the deploy job'})`,
  );
} else {
  const label = `.github/workflows/_reusable-deploy.yml (deploy job, ${SECRETS_CHECK})`;
  requireIncludes(label, secretsCheck.block, '\n        working-directory: infra\n');
  requireIncludes(label, secretsCheck.block, '\n        run: npx --no-install tsx scripts/check-prepared-login-secrets.ts 2>/dev/null\n');
  if (/\n {8}if:/.test(secretsCheck.block)) {
    fail(`${label} must run on every deploy, with no condition`);
  }
  const at = deployStepNames.indexOf(SECRETS_CHECK);
  for (const earlier of ['Configure AWS deploy credentials', 'Setup infra dependencies']) {
    const earlierAt = deployStepNames.indexOf(earlier);
    if (earlierAt === -1 || earlierAt > at) {
      fail(`${label} must come after the step ${earlier}`);
    }
  }
  if (at > deployStepNames.indexOf('Deploy CDK stacks')) {
    fail(`${label} must come before the step Deploy CDK stacks`);
  }
}

// ECR Public sign-in: the frontend and admin image builds copy the Lambda Web
// Adapter from public.ecr.aws, and anonymous pulls are refused with 429 once
// the runner address's shared allowance runs out. The deploy job signs in
// first, on every deploy, after its credentials and before anything builds;
// the token goes to docker on stdin and the AWS error text never reaches the
// public log.
const ECR_SIGN_IN = 'Sign in to ECR Public';
const ECR_SIGN_IN_RUN = [
  '\n        run: |\n',
  '          set -euo pipefail\n',
  '          aws ecr-public get-login-password --region us-east-1 2>/dev/null | docker login --username AWS --password-stdin public.ecr.aws >/dev/null 2>&1 \\\n',
  '            || { echo "::error::Could not sign in to ECR Public. The deploy role needs ecr-public:GetAuthorizationToken and sts:GetServiceBearerToken."; exit 1; }\n',
  '          echo "Signed in to ECR Public."\n',
].join('');
{
  const label = `.github/workflows/_reusable-deploy.yml (deploy job, ${ECR_SIGN_IN})`;
  const count = reusableDeploy.split(`\n      - name: ${ECR_SIGN_IN}\n`).length - 1;
  const step = deploySteps.find((candidate) => candidate.name === ECR_SIGN_IN);
  if (count !== 1 || !step) {
    fail(`${label} must exist once, in the deploy job (found ${count}${step ? '' : ', none in the deploy job'})`);
  } else {
    if (!step.block.includes(ECR_SIGN_IN_RUN)) {
      fail(`${label} must run exactly the pinned sign-in: the token on stdin, stderr discarded, a fixed error sentence`);
    }
    if (/\n {8}(if|continue-on-error|["']?if["']?|["']?continue-on-error["']?):/.test(step.block)) {
      fail(`${label} must run on every deploy and fail the job when it fails`);
    }
    const at = deployStepNames.indexOf(ECR_SIGN_IN);
    if (deployStepNames.indexOf('Configure AWS deploy credentials') > at) {
      fail(`${label} must come after the step Configure AWS deploy credentials`);
    }
    if (at > deployStepNames.indexOf('Deploy CDK stacks')) {
      fail(`${label} must come before the step Deploy CDK stacks`);
    }
  }
}

// The two "Resolve frontend configuration" steps (plan and deploy) read the
// Cognito pools and the API URL. The run logs are public and AWS error text
// names the account and the role, so each AWS call there keeps its stdout
// only and discards its stderr, a failed Cognito lookup becomes an empty
// value that the fixed sentence reports, nothing captured is echoed
// (variables go only to $GITHUB_ENV), and every ::error:: sentence is fixed
// text.
for (const [job, name, roleVariable, jobContent] of [
  ['plan', 'Resolve frontend configuration for plan', 'AWS_PLAN_ROLE_ARN', reusableDeploy.slice(0, Math.max(deployJobStart, 0))],
  ['deploy', 'Resolve frontend configuration', 'AWS_ROLE_ARN', deployJob],
]) {
  const label = `.github/workflows/_reusable-deploy.yml (${job} job, ${name})`;
  const steps = jobContent.split('\n      - name: ').filter((block) => block.startsWith(`${name}\n`));
  if (steps.length !== 1) {
    fail(`${label}: expected one step of that name in the ${job} job, found ${steps.length}`);
    continue;
  }
  const step = steps[0];
  for (const resolver of ['resolve_pool_id', 'resolve_client_id']) {
    requireMatches(
      label,
      step,
      new RegExp(`\\n {10}${resolver}\\(\\) \\{\\n(?: {12}.*\\n)*? {14}--output text 2>/dev/null \\|\\| true\\n {10}\\}\\n`),
      `${resolver} ending its AWS call with --output text 2>/dev/null || true`,
    );
  }
  requireMatches(
    label,
    step,
    /\n {10}resolve_api_url\(\) \{\n(?: {12}.*\n)*? {14}--output text 2>\/dev\/null\n {10}\}\n/,
    'resolve_api_url ending its AWS call with --output text 2>/dev/null',
  );
  requireIncludes(label, step, [
    '',
    '          if ! api_url="$(resolve_api_url)"; then',
    `            echo "::error::Unable to read JaleApiStack.ApiUrl. Grant cloudformation:DescribeStacks on JaleApiStack to ${roleVariable}'s role."`,
    '            exit 1',
    '          fi',
    '',
  ].join('\n'));
  const code = step.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const awsCalls = code.filter((line) => /^aws\s/.test(line));
  const awsCallEnds = code.filter((line) => /--output text\b/.test(line));
  if (awsCalls.length !== 3 || awsCallEnds.length !== 3) {
    fail(`${label} must make exactly three AWS calls, each ending in --output text (found ${awsCalls.length} calls, ${awsCallEnds.length} endings)`);
  }
  if (awsCallEnds.some((line) => !/^--output text 2>\/dev\/null( \|\| true)?$/.test(line))) {
    fail(`${label} must discard the stderr of every AWS call (--output text 2>/dev/null)`);
  }
  if (code.some((line) => line.includes('2>&1'))) {
    fail(`${label} must not merge stderr into anything it keeps (2>&1)`);
  }
  // A variable may be printed only into $GITHUB_ENV: inside a { ... } group
  // that closes with `} >> "$GITHUB_ENV"`, or on a line that appends there.
  let group = null;
  const loggedValues = [];
  for (const line of code) {
    if (line === '{') {
      group = [];
    } else if (group && line.startsWith('}')) {
      if (line !== '} >> "$GITHUB_ENV"') loggedValues.push(...group);
      group = null;
    } else if (/^echo "::(error|warning|notice)::/.test(line) && line.includes('$')) {
      fail(`${label} must print only fixed ::error:: sentences, with no variable in them`);
    } else if (/^(echo|printf)\b/.test(line) && line.includes('$') && !/>> "\$GITHUB_ENV"$/.test(line)) {
      (group ?? loggedValues).push(line);
    }
  }
  if (group) loggedValues.push(...group);
  if (loggedValues.length > 0) {
    fail(`${label} must not echo a captured value to the log; only $GITHUB_ENV receives variables (found ${loggedValues.length} such lines)`);
  }
}

// The run logs are public, and a step's log header lists the step's
// environment, the job's env: included. The OIDC login masks the account id
// only from its own step on. So no value from vars that carries the account
// id (an ARN) sits in the workflow's or a job's env: each step that reads one
// sets it in its own env, and every such step runs after its job's login.
const ARN_FROM_VARS = /\$\{\{\s*vars\.[A-Za-z0-9_]*ARN\s*\}\}/;
const codeLinesOf = (text) => text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
const ARN_VARIABLES = [
  ['BILLING_SES_VERIFIED_IDENTITY_ARN', 'SES_VERIFIED_IDENTITY_ARN'],
  ['WHATSAPP_ALARM_TOPIC_ARN', 'WHATSAPP_ALARM_TOPIC_ARN'],
];
const jobsAt = reusableDeploy.indexOf('\njobs:\n');
if (jobsAt === -1 || codeLinesOf(reusableDeploy.slice(0, jobsAt)).some((line) => ARN_FROM_VARS.test(line))) {
  fail('.github/workflows/_reusable-deploy.yml must not set an ARN from vars at the workflow level');
}
const planJobStart = reusableDeploy.indexOf('\n  plan:\n');
for (const [job, jobContent, minimumReaders] of [
  ['plan', planJobStart === -1 || deployJobStart === -1 ? '' : reusableDeploy.slice(planJobStart, deployJobStart), 2],
  ['deploy', deployJob, 3],
]) {
  const label = `.github/workflows/_reusable-deploy.yml (${job} job)`;
  const stepsAt = jobContent.indexOf('\n    steps:\n');
  if (stepsAt === -1) {
    fail(`${label}: could not locate the job's steps`);
    continue;
  }
  if (codeLinesOf(jobContent.slice(0, stepsAt)).some((line) => ARN_FROM_VARS.test(line))) {
    fail(`${label} must not set an ARN from vars in the job's env; the steps that read it set it, after the login`);
  }
  const steps = jobContent.slice(stepsAt).split('\n      - name: ').slice(1).map((block) => ({
    name: block.slice(0, block.indexOf('\n')).trim(),
    block,
  }));
  const loginAt = steps.findIndex((step) => step.block.includes('\n        uses: ./.github/actions/aws-oidc-login\n'));
  if (loginAt === -1) {
    fail(`${label}: could not locate the login step`);
    continue;
  }
  let readers = 0;
  steps.forEach((step, at) => {
    const code = codeLinesOf(step.block);
    let reads = false;
    for (const [name, variable] of ARN_VARIABLES) {
      const sets = new RegExp(`\\n {8}env:\\n(?: {10}.*\\n)*? {10}${name}: \\$\\{\\{ vars\\.${variable} \\}\\}\\n`).test(step.block);
      const read = code.some((line) => !line.trimStart().startsWith(`${name}:`) && new RegExp(`\\$\\{?${name}\\b|\\benv\\.${name}\\b`).test(line));
      reads ||= read;
      if (read && !sets) {
        fail(`${label}, step ${step.name}: reads ${name}, so it must set ${name}: \${{ vars.${variable} }} in its own env`);
      }
      if ((read || sets) && at <= loginAt) {
        fail(`${label}, step ${step.name}: carries ${name}, so it must run after the login step ${steps[loginAt].name}`);
      }
    }
    if (code.some((line) => ARN_FROM_VARS.test(line)) && at <= loginAt) {
      fail(`${label}, step ${step.name}: sets an ARN from vars, so it must run after the login step ${steps[loginAt].name}`);
    }
    if (reads) readers += 1;
  });
  if (readers < minimumReaders) {
    fail(`${label}: expected at least ${minimumReaders} steps that read the ARN variables, found ${readers}`);
  }
}

// The artifacts of a run on this repository are public, and CDK's diff,
// deploy log and outputs name the account id. A scrub runs right before each
// upload, under the upload's own if:, over exactly the files the upload
// names. It moves each file aside first, so an upload path only ever holds
// nothing or a scrubbed copy. It reads the account id from STS (projected,
// stderr discarded, never printed), writes each copy with the id replaced by
// <aws-account>, and requires a recount of 0. On any failure its EXIT trap
// deletes the files instead, and the step still exits 0: the deploy never
// depends on it. It prints fixed sentences and three counts only. The plan
// upload carries the diff alone and still fails when the diff is withheld;
// both uploads keep 14 days.
const planJobContent = planJobStart === -1 || deployJobStart === -1 ? '' : reusableDeploy.slice(planJobStart, deployJobStart);
const stepsOfJob = (jobContent) => {
  const at = jobContent.indexOf('\n    steps:\n');
  return at === -1 ? [] : jobContent.slice(at).split('\n      - name: ').slice(1).map((block) => ({
    name: block.slice(0, block.indexOf('\n')).trim(),
    block,
  }));
};
const uploadPathsOf = (block) => {
  const inline = block.match(/\n {10}path: (\S.*)\n/);
  if (inline && inline[1] !== '|') return [inline[1]];
  const list = block.match(/\n {10}path: \|\n((?: {12}.*\n)+)/);
  return list ? list[1].split('\n').map((line) => line.trim()).filter(Boolean) : [];
};
const scrubBlocks = [];
for (const { job, jobContent, scrub, upload, what } of [
  { job: 'plan', jobContent: planJobContent, scrub: 'Scrub production plan artifacts', upload: 'Upload production plan artifacts', what: 'Plan artifacts' },
  { job: 'deploy', jobContent: deployJob, scrub: 'Scrub deployment artifacts', upload: 'Upload deployment artifacts', what: 'Deployment artifacts' },
]) {
  const label = `.github/workflows/_reusable-deploy.yml (${job} job, ${scrub})`;
  const steps = stepsOfJob(jobContent);
  const scrubAt = steps.findIndex((step) => step.name === scrub);
  const uploadAt = steps.findIndex((step) => step.name === upload);
  if (steps.filter((step) => step.name === scrub).length !== 1 || uploadAt === -1) {
    fail(`${label}: expected one step ${scrub} and one step ${upload} in the ${job} job`);
    continue;
  }
  const scrubBlock = steps[scrubAt].block;
  const uploadBlock = steps[uploadAt].block;
  scrubBlocks.push(scrubBlock);
  if (scrubAt !== uploadAt - 1) {
    fail(`${label} must run immediately before the step ${upload}`);
  }
  const ifOf = (block) => (block.match(/\n {8}if: .*\n/) ?? [''])[0];
  if (ifOf(scrubBlock) === '' || ifOf(scrubBlock) !== ifOf(uploadBlock)) {
    fail(`${label} must run under the same if: as the step ${upload}`);
  }
  requireIncludes(label, scrubBlock, '\n        shell: bash\n');
  const uploadPaths = uploadPathsOf(uploadBlock);
  const uploadNames = uploadPaths.map((path) => (path.match(/^\$\{\{ runner\.temp \}\}\/([\w.-]+)$/) ?? [])[1]);
  const listed = scrubBlock.match(/\n {10}files=\(((?:"\$RUNNER_TEMP\/[\w.-]+" ?)+)\)\n/);
  const scrubNames = listed ? [...listed[1].matchAll(/"\$RUNNER_TEMP\/([\w.-]+)"/g)].map((match) => match[1]) : [];
  if (uploadNames.length === 0 || uploadNames.includes(undefined) || uploadNames.join(' ') !== scrubNames.join(' ')) {
    fail(`${label} must cover exactly the files ${upload} names, in the same order, each a file in runner.temp (upload: ${uploadPaths.join(', ') || 'none'}; scrub: ${scrubNames.join(', ') || 'none'})`);
  }
  requireIncludes(label, scrubBlock, [
    '',
    '          scrubbed=0',
    '          finish() {',
    '            trap - EXIT',
    '            if [[ "$scrubbed" != 1 ]]; then',
    '              for file in "${files[@]}"; do',
    '                rm -rf -- "$file" "$file.unscrubbed" 2>/dev/null || true',
    '              done',
    `              echo "::warning::${what} withheld: the account id could not be removed from them."`,
    '            fi',
    '            exit 0',
    '          }',
    '          trap finish EXIT',
    '',
  ].join('\n'));
  const code = codeLinesOf(scrubBlock).map((line) => line.trim());
  const at = (line) => code.indexOf(line);
  const MOVE_ASIDE = 'mv -f -- "$file" "$file.unscrubbed" 2>/dev/null || exit';
  const CAPTURE = 'account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || exit';
  const SCRUB = 'sed "s/${account}/<aws-account>/g" "$file.unscrubbed" > "$file" 2>/dev/null || exit';
  const ACCOUNT_CHECK = '[[ "$account" =~ ^[0-9]{12}$ ]] || exit';
  const LEFT = '[[ "$left" -eq 0 ]] || exit';
  const COUNTS = `printf '${what} scrubbed: files %d, account id occurrences replaced %d, left %d.\\n' "\${#present[@]}" "$replaced" "$left"`;
  if (code.filter((line) => line.includes('get-caller-identity')).length !== 1 || at(CAPTURE) === -1) {
    fail(`${label} must read the account id exactly once, as ${CAPTURE}`);
  }
  for (const [line, purpose] of [
    [MOVE_ASIDE, 'move each file aside before it reads the account id'],
    [ACCOUNT_CHECK, 'accept only a 12-digit account id'],
    [SCRUB, 'write each copy with the account id replaced by <aws-account>'],
    [LEFT, 'require a recount of 0'],
    [COUNTS, 'print one fixed line of counts on success'],
  ]) {
    if (at(line) === -1) fail(`${label} must ${purpose} (${line})`);
  }
  const order = [at(MOVE_ASIDE), at(CAPTURE), at(ACCOUNT_CHECK), at(SCRUB), at(LEFT), code.lastIndexOf('scrubbed=1'), at(COUNTS)];
  if (order.includes(-1) || order.some((position, index) => index > 0 && position <= order[index - 1])) {
    fail(`${label} must move the files aside, read and check the account id, scrub, require 0 left, and only then mark them scrubbed and print the counts`);
  }
  if (code.some((line) => line.includes('2>&1'))) {
    fail(`${label} must not merge stderr into anything it keeps (2>&1)`);
  }
  for (const line of code.filter((candidate) => /^(echo|printf)\b/.test(candidate))) {
    if (/\$\{?account\b/.test(line)) {
      fail(`${label} must never print the account id`);
    } else if (line.includes('$') && line !== COUNTS) {
      fail(`${label} must print fixed sentences and the three counts only`);
    }
  }
  // Past its capture, the account id is only checked, counted and replaced.
  const COUNT = 'count() { awk -v id="$account" \'{ n += gsub(id, "") } END { print n + 0 }\' "$1" 2>/dev/null; }';
  if (code.some((line) => /\$\{?account\b/.test(line) && ![ACCOUNT_CHECK, COUNT, SCRUB].includes(line))) {
    fail(`${label} must use the account id only to check it, count it and replace it`);
  }
}
for (const [job, jobContent, upload] of [
  ['plan', planJobContent, 'Upload production plan artifacts'],
  ['deploy', deployJob, 'Upload deployment artifacts'],
]) {
  const step = stepsOfJob(jobContent).find((candidate) => candidate.name === upload);
  const label = `.github/workflows/_reusable-deploy.yml (${job} job, ${upload})`;
  if (!step) {
    fail(`${label}: could not locate the step`);
  } else {
    requireIncludes(label, step.block, '\n          retention-days: 14\n');
  }
}
const planUpload = stepsOfJob(planJobContent).find((step) => step.name === 'Upload production plan artifacts');
if (planUpload) {
  const label = '.github/workflows/_reusable-deploy.yml (plan job, Upload production plan artifacts)';
  if (uploadPathsOf(planUpload.block).join(' ') !== '${{ runner.temp }}/jale-cdk-diff.txt') {
    fail(`${label} must upload the diff only: path: \${{ runner.temp }}/jale-cdk-diff.txt`);
  }
  requireIncludes(label, planUpload.block, '\n          if-no-files-found: error\n');
}

// Pull request validation also synthesizes production, so the refusals only
// a production synth makes (the engine's preload default, the audit
// detection modes) are met before a merge rather than on the prod push. The
// leg reads no vars, secrets or inputs, so a pull request from a fork passes
// too; it passes every context key the production deploy passes, each with
// a fixed dummy value, and fails unless the synth wrote the expected number
// of templates. The dev leg stays as it is.
const PRODUCTION_SYNTH = 'CDK synth backend stacks (production, fixed context)';
requireMatches(
  '.github/workflows/_reusable-validate.yml',
  reusableValidate,
  /\n {6}production-synth:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false\n/,
  'a boolean production-synth workflow_call input that defaults to false',
);
requireIncludes('.github/workflows/pr-validate.yml', prValidate, '\n      production-synth: true\n');
requireIncludes('.github/workflows/pr-validate.yml', prValidate, "cdk-environment: ${{ vars.CDK_CONTEXT_ENVIRONMENT || 'dev' }}");
if (synthStep !== undefined) {
  requireIncludes('.github/workflows/_reusable-validate.yml (infra job, step CDK synth backend stacks)', synthStep, '-c environment=${{ inputs.cdk-environment }}');
}
const productionSynth = infraJob.split('\n      - name: ').find((block) => block.startsWith(`${PRODUCTION_SYNTH}\n`));
if (productionSynth === undefined) {
  fail(`.github/workflows/_reusable-validate.yml (infra job) must have a step named ${PRODUCTION_SYNTH}`);
} else {
  const label = `.github/workflows/_reusable-validate.yml (infra job, step ${PRODUCTION_SYNTH})`;
  requireIncludes(label, productionSynth, '\n        if: ${{ inputs.production-synth }}\n');
  const expressions = productionSynth.match(/\$\{\{[^}]*\}\}/g) ?? [];
  if (expressions.length !== 1) {
    fail(`${label} must read no vars, secrets or inputs: its one expression is its condition (found ${expressions.length})`);
  }
  requireIncludes(label, productionSynth, '\n        working-directory: infra\n');
  requireIncludes(label, productionSynth, '\n        shell: bash\n');
  for (const fixed of ['AWS_REGION: us-east-2', 'CDK_DEFAULT_REGION: us-east-2', "CDK_DEFAULT_ACCOUNT: '111111111111'"]) {
    requireMatches(label, productionSynth, new RegExp(`\\n {8}env:\\n(?: {10}.*\\n)*? {10}${fixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), `${fixed} in the step env`);
  }
  const productionSynthCommand = productionSynth.split('\n').find((line) => line.trim().startsWith('npx cdk synth ')) ?? '';
  for (const flag of ['-c environment=production ', '-c skipFrontend=true ']) {
    requireIncludes(label, productionSynthCommand, flag);
  }
  // Every context key the production deploy passes, each with a fixed value.
  const deployCommand = (deploySteps.find((step) => step.name === 'Deploy CDK stacks')?.block ?? '')
    .split('\n').find((line) => line.trim().startsWith('npx cdk deploy ')) ?? '';
  const deployKeys = [...new Set([...deployCommand.matchAll(/-c ([A-Za-z0-9]+)=/g)].map((match) => match[1]))];
  if (deployKeys.length < 10) {
    fail(`.github/workflows/_reusable-deploy.yml (deploy job, Deploy CDK stacks): could not read the deploy's context keys (found ${deployKeys.length})`);
  }
  for (const key of deployKeys) {
    if (!new RegExp(`(^|\\s)-c ${key}=[^\\s"'$]`).test(productionSynthCommand)) {
      fail(`${label} must pass -c ${key}= with a fixed value, as the production deploy passes it`);
    }
  }
  requireIncludes(label, productionSynthCommand, ' --output "$RUNNER_TEMP/jale-cdk-synth-production"');
  requireIncludes(label, productionSynth, `\n          templates=$(find "$RUNNER_TEMP/jale-cdk-synth-production" -maxdepth 1 -name '*.template.json' | wc -l)\n`);
  requireMatches(
    label,
    productionSynth,
    /\n {10}if \[ "\$templates" -ne [1-9][0-9]* \]; then\n {12}echo "::error::[^"\n]*"\n {12}exit 1\n {10}fi\n/,
    'a failure unless the synth wrote the expected number of templates',
  );
}

requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'WHATSAPP_ALARM_TOPIC_ARN');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, 'JALE_WHATSAPP_STATUS_CALLBACK_URL');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappStatusCallbackUrl=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c whatsappAlarmTopicArn=');
requireIncludes('.github/workflows/_reusable-deploy.yml', reusableDeploy, '-c billingAlarmTopicArn=');
// Billing alarms are routed to the same monitored ops topic the WhatsApp
// alarms use (vars.WHATSAPP_ALARM_TOPIC_ARN). The paired match also pins the
// flag immediately after whatsappAlarmTopicArn, so a single dropped flag in
// one of the 4 plan/diff/deploy commands fails here instead of silently
// re-creating the unsubscribed jale-billing-alarms topic in production.
const productionBillingAlarmTopicContexts =
  reusableDeploy.match(
    /-c whatsappAlarmTopicArn="\$WHATSAPP_ALARM_TOPIC_ARN" -c billingAlarmTopicArn="\$WHATSAPP_ALARM_TOPIC_ARN"/g,
  ) ?? [];
if (productionBillingAlarmTopicContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must route billing alarms to the ops SNS topic '
      + '(-c billingAlarmTopicArn="$WHATSAPP_ALARM_TOPIC_ARN" immediately after whatsappAlarmTopicArn) '
      + 'in all 4 production CDK plan/diff/deploy commands',
  );
}
const productionFifoTransportContexts =
  reusableDeploy.match(/-c whatsappInboundV2TransportEnabled=true/g) ?? [];
if (productionFifoTransportContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must enable WhatsApp v2 FIFO transport ' +
      'for all 4 production CDK plan/diff/deploy commands',
  );
}
// Cognito + SES is only supported in us-east-1/us-west-2/eu-west-1, so the
// sender region is a literal (the stacks themselves deploy to us-east-2).
const productionCognitoSesContexts =
  reusableDeploy.match(/-c sesEmailFromAddress="\$COGNITO_EMAIL_FROM_ADDRESS" -c sesEmailRegion=us-east-1/g) ?? [];
if (productionCognitoSesContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass the Cognito SES sender ' +
      '(sesEmailFromAddress + sesEmailRegion=us-east-1) to all 4 production CDK plan/diff/deploy commands',
  );
}

// SES configuration set. NotificationsStack creates the set + the SNS event
// destination; BillingStack's sweeper tags outgoing mail with it. If the flag
// reaches only CI synth and not the production commands, every one of those
// resources synthesizes to nothing in prod and the whole bounce/complaint lane
// deploys as a silent no-op -- no error, no alarm, no signal at all. The
// paired match pins the flag immediately after whatsappInboundV2TransportEnabled
// so a single dropped flag in one of the 4 commands fails here.
//
// Deliberately NOT guarded for non-emptiness the way COGNITO_EMAIL_FROM_ADDRESS
// is: the variable is optional by design. An unset GitHub var expands to '',
// which bin/jale-app.ts treats as absent, and that is the supported way to keep
// the feedback lane dark until the cutover.
requireIncludes(
  '.github/workflows/_reusable-deploy.yml',
  reusableDeploy,
  'JALE_SES_CONFIGURATION_SET_NAME: ${{ vars.JALE_SES_CONFIGURATION_SET_NAME }}',
);
const productionSesConfigurationSetContexts =
  reusableDeploy.match(
    /-c whatsappInboundV2TransportEnabled=true -c sesConfigurationSetName="\$JALE_SES_CONFIGURATION_SET_NAME"/g,
  ) ?? [];
if (productionSesConfigurationSetContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass the SES configuration set '
      + '(-c sesConfigurationSetName="$JALE_SES_CONFIGURATION_SET_NAME" immediately after '
      + 'whatsappInboundV2TransportEnabled) in all 4 production CDK plan/diff/deploy commands',
  );
}

// CI synth must exercise the wired path: with no name the configuration set,
// the event destination and the feedback Lambda are all absent from the
// template, so nothing about them would ever be asserted before production.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c sesConfigurationSetName=');

// Audit system. The three audit stacks deploy with the
// backend, the audit stack right after the database: it creates the fallback
// group the database Lambdas write to.
requireIncludes(
  '.github/workflows/deploy-production.yml',
  deployProduction,
  'JaleNetworkStack JaleDatabaseStack JaleAuditArchiveStack JaleAuditStack JaleAuditEdgeStack JaleAuditEdgeUsWest2Stack',
);
// The detection-service modes and the engine's default preload list are
// required in production: synth fails without them, by design. They must
// ride on all 4 production plan/diff/deploy commands, from the pre-check
// variables in both jobs, so the plan the operator reviews is the deploy.
for (const variable of [
  'AUDIT_GUARDDUTY_MODE',
  'AUDIT_SECURITYHUB_MODE',
  'AUDIT_CONFIG_MODE',
  'AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT',
]) {
  const declared = reusableDeploy.split(`${variable}: \${{ vars.${variable} }}`).length - 1;
  if (declared !== 2) {
    fail(`.github/workflows/_reusable-deploy.yml must read ${variable} from vars in both the plan and deploy jobs; found ${declared}`);
  }
}
const productionAuditContexts =
  reusableDeploy.match(
    /-c guardDutyMode="\$AUDIT_GUARDDUTY_MODE" -c securityHubMode="\$AUDIT_SECURITYHUB_MODE" -c configMode="\$AUDIT_CONFIG_MODE" -c dbSharedPreloadLibrariesDefault="\$AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT"/g,
  ) ?? [];
if (productionAuditContexts.length !== 4) {
  fail(
    '.github/workflows/_reusable-deploy.yml must pass the audit modes and the preload default '
      + `(guardDutyMode, securityHubMode, configMode, dbSharedPreloadLibrariesDefault) to all 4 production CDK commands; found ${productionAuditContexts.length}`,
  );
}
// Alert recipients and audit principals never reach a template: no
// workflow may pass them.
for (const [file, content] of [
  ['.github/workflows/_reusable-deploy.yml', reusableDeploy],
  ['.github/workflows/_reusable-validate.yml', reusableValidate],
  ['.github/workflows/deploy-production.yml', deployProduction],
]) {
  if (/AUDIT_ALERT_EMAILS|AUDIT_ROLE_PRINCIPALS/.test(content)) {
    fail(`${file} must not pass audit alert addresses or audit principals; subscriptions and role use are set up out of band`);
  }
}
// CI synth runs the production path, so it must pass the audit flags too.
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c guardDutyMode=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c securityHubMode=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c configMode=');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, '-c dbSharedPreloadLibrariesDefault=');

requireIncludes('scripts/run-admin-migration.ps1', adminMigration, '026_admin_panel.sql');
requireIncludes('scripts/run-admin-migration.ps1', adminMigration, 'jale_admin_console');
if (adminMigration.includes('ALTER ROLE jale_whatsapp') || adminMigration.includes('ALTER ROLE jale_matching')) {
  fail('scripts/run-admin-migration.ps1 must not rotate unrelated database roles');
}

requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin-create-user');
requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin-add-user-to-group');
requireIncludes('scripts/bootstrap-admin-user.ps1', adminBootstrap, 'admin_users');

// The Windows bastion script synthesizes the production app on deploy and on
// destroy, so, like deploy-bastion.sh, it needs the engine's default preload
// list (infra/test/unit/scripts/run-migrations-sh.test.ts checks its text).
requireIncludes('scripts/deploy-bastion.ps1', bastionDeploy, 'AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT');

// Both bastion scripts give the deploy the alarm topic the deploy workflow
// uses (WHATSAPP_ALARM_TOPIC_ARN) as -c whatsappAlarmTopicArn=, and only when
// the variable is set: an empty flag would read as a supplied topic and fail
// at synth. The context starts empty, the flag is added right under the
// check, nothing else passes it, and the destroy never gets it. Comment lines
// are ignored.
for (const [file, content, guard, deployUse, contextName] of [
  [
    'scripts/deploy-bastion.sh',
    bastionDeploySh,
    ['ALARM_CONTEXT=()', 'if [ -n "${WHATSAPP_ALARM_TOPIC_ARN:-}" ]; then', 'ALARM_CONTEXT=(-c "whatsappAlarmTopicArn=$WHATSAPP_ALARM_TOPIC_ARN")'],
    '"${ALARM_CONTEXT[@]}" deploy JaleBastionStack ',
    'ALARM_CONTEXT',
  ],
  [
    'scripts/deploy-bastion.ps1',
    bastionDeploy,
    ['$alarmContext = @()', 'if (-not [string]::IsNullOrEmpty($env:WHATSAPP_ALARM_TOPIC_ARN)) {', `$alarmContext = @('-c', "whatsappAlarmTopicArn=$env:WHATSAPP_ALARM_TOPIC_ARN")`],
    ' @alarmContext deploy JaleBastionStack ',
    'alarmContext',
  ],
]) {
  const code = content.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const at = code.indexOf(guard[0]);
  if (at === -1 || code[at + 1] !== guard[1] || code[at + 2] !== guard[2]) {
    fail(`${file} must start the alarm-topic context empty and add -c whatsappAlarmTopicArn= only when WHATSAPP_ALARM_TOPIC_ARN is set`);
  }
  const passing = code.filter((line) => line.includes('whatsappAlarmTopicArn')).length;
  if (passing !== 1) {
    fail(`${file} must pass whatsappAlarmTopicArn in one place, the context built under the check (found ${passing})`);
  }
  const deploys = code.filter((line) => /^npx cdk .*\bdeploy JaleBastionStack\b/.test(line));
  const destroys = code.filter((line) => /^npx cdk .*\bdestroy JaleBastionStack\b/.test(line));
  if (deploys.length !== 1 || !deploys[0].includes(deployUse)) {
    fail(`${file} must pass the alarm-topic context to its one deploy call`);
  }
  if (destroys.length !== 1 || destroys[0].includes(contextName) || destroys[0].includes('WHATSAPP_ALARM_TOPIC_ARN')) {
    fail(`${file} must not pass the alarm topic to its one destroy call`);
  }
  if (at !== -1 && deploys.length === 1 && code.indexOf(deploys[0]) < at) {
    fail(`${file} must build the alarm-topic context before its deploy call`);
  }
}

requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, 'actions/setup-node');
requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, 'npm ci');
requireIncludes('.github/actions/aws-oidc-login/action.yml', awsLogin, 'aws-actions/configure-aws-credentials');

// Sprint 25 lane E: Node 24 + GitHub Actions majors. Pin checks below so a
// future downgrade of any of these three actions, or the composite action's
// Node default, is caught here instead of surfacing as a runner deprecation.
requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, 'actions/setup-node@v7');
requireIncludes('.github/actions/setup-node-cache/action.yml', setupNode, "default: '24'");
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, 'actions/setup-node@v7');
requireIncludes('.github/workflows/_reusable-validate.yml', reusableValidate, "node-version: '24'");
requireIncludes('.github/actions/aws-oidc-login/action.yml', awsLogin, 'aws-actions/configure-aws-credentials@v6');

const workflowAndActionFiles = {
  '.github/workflows/pr-validate.yml': prValidate,
  '.github/workflows/deploy-production.yml': deployProduction,
  '.github/workflows/_reusable-validate.yml': reusableValidate,
  '.github/workflows/_reusable-deploy.yml': reusableDeploy,
  '.github/actions/setup-node-cache/action.yml': setupNode,
  '.github/actions/aws-oidc-login/action.yml': awsLogin,
};
for (const [file, content] of Object.entries(workflowAndActionFiles)) {
  for (const staleActionPin of ['actions/checkout@v4', 'actions/upload-artifact@v4', 'actions/setup-node@v4', 'configure-aws-credentials@v4']) {
    if (content.includes(staleActionPin)) {
      fail(`${file} must not pin the superseded ${staleActionPin}`);
    }
  }
}
for (const [file, content] of Object.entries(workflowAndActionFiles)) {
  for (const invocation of multiFileBashSyntaxChecks(content)) {
    fail(`${file} must pass \`bash -n\` exactly one file (found \`${invocation}\`); bash checks only the first of several`);
  }
}

// The run logs are public. The OIDC login masks the account id in every log
// line that follows (configure-aws-credentials' mask-aws-account-id input),
// and its identity check proves the credentials work without printing whose
// they are: the call is projected, its output goes to /dev/null, its stderr
// is discarded (AWS error text names the account and the role), and the step
// prints one fixed line or fails. No workflow or action calls
// get-caller-identity any other way, apart from the two artifact scrubs in
// _reusable-deploy.yml: they keep the projected account id in a variable they
// never print, and are pinned on their own above, so the scan below leaves
// their steps out.
requireMatches(
  '.github/actions/aws-oidc-login/action.yml',
  awsLogin,
  /\n {6}uses: aws-actions\/configure-aws-credentials@v6\n {6}with:\n(?: {8}.*\n| *#.*\n)*? {8}mask-aws-account-id: true\n/,
  'mask-aws-account-id: true in the configure-aws-credentials step',
);
requireIncludes('.github/actions/aws-oidc-login/action.yml', awsLogin, [
  '',
  "        if ! aws sts get-caller-identity --query 'length(Account)' --output text > /dev/null 2>&1; then",
  '          echo "::error::The AWS credentials could not be confirmed."',
  '          exit 1',
  '        fi',
  '        echo "AWS identity: confirmed"',
  '',
].join('\n'));
for (const [file, content] of Object.entries(workflowAndActionFiles)) {
  const scanned = file === '.github/workflows/_reusable-deploy.yml'
    ? scrubBlocks.reduce((remaining, block) => remaining.replace(block, ''), content)
    : content;
  for (const line of scanned.split('\n')) {
    if (line.trimStart().startsWith('#') || !/\bget-caller-identity\b/.test(line)) continue;
    const projected = / --query \S/.test(line);
    const quiet = /\s>\s*\/dev\/null\s+2>&1(\s|;|$)/.test(line) || (/\s>\s*\/dev\/null(\s|;|$)/.test(line) && /\s2>\s*\/dev\/null(\s|;|$)/.test(line));
    if (!projected || !quiet) {
      fail(`${file} must call get-caller-identity only with a --query projection, its output to /dev/null and its stderr discarded`);
    }
  }
}
const allWorkflowAndActionContent = Object.values(workflowAndActionFiles).join('\n');
const checkoutV7Count = (allWorkflowAndActionContent.match(/actions\/checkout@v7/g) ?? []).length;
if (checkoutV7Count < 9) {
  fail(`expected at least 9 actions/checkout@v7 sites across workflows, found ${checkoutV7Count}`);
}
const uploadArtifactV7Count = (allWorkflowAndActionContent.match(/actions\/upload-artifact@v7/g) ?? []).length;
if (uploadArtifactV7Count < 4) {
  fail(`expected at least 4 actions/upload-artifact@v7 sites across workflows, found ${uploadArtifactV7Count}`);
}

for (const ownerPath of ['.github/', 'infra/', 'infra/db/migrations/', 'scripts/run-migrations*']) {
  requireIncludes('.github/CODEOWNERS', codeowners, ownerPath);
}

for (const file of [
  '.github/workflows/pr-validate.yml',
  '.github/workflows/deploy-production.yml',
  '.github/workflows/_reusable-validate.yml',
  '.github/workflows/_reusable-deploy.yml',
]) {
  const content = readRequired(file);
  if (content.includes('pull_request_target')) {
    fail(`${file} must not use pull_request_target`);
  }
}

for (const deprecatedFile of ['.github/workflows/deploy-dev.yml', '.github/workflows/deploy-prod.yml']) {
  if (existsSync(join(root, deprecatedFile))) {
    fail(`${deprecatedFile} must not exist; production deploys use deploy-production.yml`);
  }
}
