// Guard tests for scripts/validate-github-workflows.mjs. Run with: node --test scripts/validate-github-workflows.test.mjs
//
// The validator runs over a copy of every file it reads, once as the
// repository holds them (it must pass, silently) and once per mutation of the
// deploy workflow (it must fail, with the pin that catches that mutation). The
// mutations are the ways a later edit could let a deploy past a failed
// database posture gate, or ignore the verification after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(repoRoot, 'scripts', 'validate-github-workflows.mjs');
const DEPLOY = '.github/workflows/_reusable-deploy.yml';
// Every file the validator reads.
const FILES = [
  '.github/CODEOWNERS',
  '.github/actions/setup-node-cache/action.yml',
  '.github/actions/aws-oidc-login/action.yml',
  '.github/workflows/pr-validate.yml',
  '.github/workflows/deploy-production.yml',
  '.github/workflows/_reusable-validate.yml',
  DEPLOY,
  'scripts/run-admin-migration.ps1',
  'scripts/bootstrap-admin-user.ps1',
  'scripts/deploy-bastion.ps1',
  'scripts/deploy-bastion.sh',
  'scripts/run-production-upgrade-020b-040.sh',
  'docs/production-upgrade-020b-040.md',
  'infra/scripts/check-prepared-login-secrets.ts',
  'frontend/package.json',
];

/** Runs the validator over a copy of the files, `target` (the deploy workflow by default) first passed through `mutate`. */
function validate(mutate, target = DEPLOY) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-workflows-'));
  try {
    for (const file of FILES) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(dir, file));
    }
    if (mutate) {
      const before = readFileSync(join(dir, target), 'utf8');
      const after = mutate(before);
      assert.notEqual(after, before, 'the mutation must change the workflow');
      writeFileSync(join(dir, target), after);
    }
    const run = spawnSync(process.execPath, [VALIDATOR], { cwd: dir, encoding: 'utf8' });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds a line to a step, right under its `- name:` line. The step must exist once. */
function addToStep(step, line) {
  return (text) => {
    const at = `\n      - name: ${step}\n`;
    assert.equal(text.split(at).length, 2, `one step named ${step}`);
    return text.replace(at, `${at}        ${line}\n`);
  };
}

/** Replaces exactly one occurrence of `from`. */
function replaceOnce(from, to) {
  return (text) => {
    assert.equal(text.split(from).length, 2, `one occurrence of ${from}`);
    return text.replace(from, to);
  };
}

const GATE_PIN = '(deploy job, Database posture gate) must be exactly the pinned step';
const VERIFICATION_PIN = '(deploy job, Database posture verification) must be exactly the pinned step';
const DEPLOY_PIN = '(deploy job, Deploy CDK stacks) must set only working-directory, shell, env and run';
const ORDER_PIN = 'must run these steps back to back, in this order';
const ONCE_PIN = '(deploy job) must have exactly one step named Database posture gate';

const WRITER_LINE = '          npx --no-install tsx scripts/write-posture-expectation.ts "$RUNNER_TEMP/posture-expected.json"\n';
const GATE_LINE = '          node scripts/db-posture-gate.mjs --phase pre --expected "$RUNNER_TEMP/posture-expected.json"\n';

const ECR_EXISTS_PIN = '(deploy job, Sign in to ECR Public) must exist once';
const ECR_EVERY_PIN = '(deploy job, Sign in to ECR Public) must run on every deploy';
const ECR_RUN_PIN = '(deploy job, Sign in to ECR Public) must run exactly the pinned sign-in';

const GATE_STEP = [
  '      - name: Database posture gate',
  '        working-directory: infra',
  '        shell: bash',
  '        env:',
  '          POSTURE_OVERRIDE: ${{ inputs.posture-override }}',
  '          POSTURE_OVERRIDE_REASON: ${{ inputs.posture-override-reason }}',
  '        run: |',
  '          set -euo pipefail',
  WRITER_LINE + GATE_LINE,
].join('\n');

test('the repository files pass, with no output', () => {
  const run = validate();
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, '');
  assert.equal(run.status, 0);
});

const MUTATIONS = [
  ['a condition that skips the gate', addToStep('Database posture gate', 'if: false'), GATE_PIN],
  ['a condition on the verification', addToStep('Database posture verification', 'if: always()'), VERIFICATION_PIN],
  ['continue-on-error on the gate', addToStep('Database posture gate', 'continue-on-error: true'), GATE_PIN],
  ['continue-on-error on the verification', addToStep('Database posture verification', 'continue-on-error: true'), VERIFICATION_PIN],
  ['a quoted continue-on-error key on the gate', addToStep('Database posture gate', '"continue-on-error": true'), GATE_PIN],
  ['an expression for continue-on-error on the gate', addToStep('Database posture gate', 'continue-on-error: ${{ true }}'), GATE_PIN],
  ['the gate\'s failure swallowed by its command',
    replaceOnce(GATE_LINE, GATE_LINE.replace('\n', ' || true\n')), GATE_PIN],
  ['the writer\'s failure swallowed by its command',
    replaceOnce(WRITER_LINE, WRITER_LINE.replace('\n', ' || true\n')), GATE_PIN],
  ['the gate run without the incoming expectation',
    replaceOnce(GATE_LINE, '          node scripts/db-posture-gate.mjs --phase pre\n'), GATE_PIN],
  ['the writer line removed', replaceOnce(WRITER_LINE, ''), GATE_PIN],
  ['the writer line moved after the gate', replaceOnce(WRITER_LINE + GATE_LINE, GATE_LINE + WRITER_LINE), GATE_PIN],
  ['the gate step\'s set -euo pipefail line removed',
    replaceOnce('        run: |\n          set -euo pipefail\n' + WRITER_LINE, '        run: |\n' + WRITER_LINE), GATE_PIN],
  ['the verification\'s failure swallowed by its command',
    replaceOnce('run: node scripts/db-posture-gate.mjs --phase post\n', 'run: node scripts/db-posture-gate.mjs --phase post; exit 0\n'), VERIFICATION_PIN],
  ['a third environment variable on the gate',
    replaceOnce('          POSTURE_OVERRIDE_REASON: ${{ inputs.posture-override-reason }}\n        run: |\n          set -euo pipefail\n',
      '          POSTURE_OVERRIDE_REASON: ${{ inputs.posture-override-reason }}\n          NODE_OPTIONS: --require ./skip.js\n        run: |\n          set -euo pipefail\n'), GATE_PIN],
  ['a condition that deploys after a failed gate', addToStep('Deploy CDK stacks', 'if: always()'), DEPLOY_PIN],
  ['a quoted condition on the deploy', addToStep('Deploy CDK stacks', '\'if\': ${{ !cancelled() }}'), DEPLOY_PIN],
  ['continue-on-error on the deploy', addToStep('Deploy CDK stacks', 'continue-on-error: true'), DEPLOY_PIN],
  ['the gate after the deploy',
    (text) => replaceOnce(GATE_STEP, '')(text).replace('      - name: Database posture verification\n', `${GATE_STEP}      - name: Database posture verification\n`),
    ORDER_PIN],
  ['the ECR Public sign-in renamed away', replaceOnce('      - name: Sign in to ECR Public\n', '      - name: Sign in to ECR Public later\n'), ECR_EXISTS_PIN],
  ['a condition on the ECR Public sign-in', addToStep('Sign in to ECR Public', 'if: false'), ECR_EVERY_PIN],
  ['continue-on-error on the ECR Public sign-in', addToStep('Sign in to ECR Public', 'continue-on-error: true'), ECR_EVERY_PIN],
  ['the sign-in\'s AWS error text let through',
    replaceOnce('get-login-password --region us-east-1 2>/dev/null |', 'get-login-password --region us-east-1 |'), ECR_RUN_PIN],
  ['a second gate step, later in the job',
    replaceOnce('      - name: Deployment summary\n', `${GATE_STEP}\n      - name: Deployment summary\n`), ONCE_PIN],
];

// The infra unit tests run as jest shards. These are the ways a later edit
// could leave test files in no shard, hide a shard's failure, or run the whole
// suite twice.
const VALIDATE = '.github/workflows/_reusable-validate.yml';
const SHARD_LIST_PIN = '(infra-tests job) must list shards';
const SHARD_RUN_PIN = '(infra-tests job) must run exactly';
const FAIL_FAST_PIN = '(infra-tests job) must set fail-fast: false';
const INFRA_JOB_PIN = '(infra job) must not run the unit tests';
const SHARD_RUN = 'run: npm run test:ci -- --runInBand --shard=${{ matrix.shard }}/3\n';

const VALIDATE_MUTATIONS = [
  ['a shard missing from the list', replaceOnce('shard: [1, 2, 3]\n', 'shard: [1, 2]\n'), SHARD_LIST_PIN],
  ['a shard total above the list', replaceOnce(SHARD_RUN, SHARD_RUN.replace('/3\n', '/4\n')), SHARD_LIST_PIN],
  ['a shard listed twice', replaceOnce('shard: [1, 2, 3]\n', 'shard: [1, 2, 2]\n'), SHARD_LIST_PIN],
  ['a single shard', (text) => replaceOnce(SHARD_RUN, SHARD_RUN.replace('/3\n', '/1\n'))(replaceOnce('shard: [1, 2, 3]\n', 'shard: [1]\n')(text)), SHARD_LIST_PIN],
  ['the shard flag dropped', replaceOnce(SHARD_RUN, 'run: npm run test:ci -- --runInBand\n'), SHARD_RUN_PIN],
  ['a shard\'s failure swallowed by its command', replaceOnce(SHARD_RUN, SHARD_RUN.replace('\n', ' || true\n')), SHARD_RUN_PIN],
  ['fail-fast turned on',
    replaceOnce('even when another shard fails.\n      fail-fast: false\n', 'even when another shard fails.\n      fail-fast: true\n'), FAIL_FAST_PIN],
  ['the unit tests back in the infra job',
    replaceOnce('      - name: Build infra TypeScript\n        working-directory: infra\n        run: npm run build\n',
      '      - name: Build infra TypeScript\n        working-directory: infra\n        run: npm run build\n\n      - name: Run infra unit tests\n        working-directory: infra\n        run: npm run test:ci -- --runInBand\n'),
    INFRA_JOB_PIN],
];

for (const [what, mutate, pin] of VALIDATE_MUTATIONS) {
  test(`fails on ${what} in the validate workflow, with the pin that catches it`, () => {
    const run = validate(mutate, VALIDATE);
    assert.equal(run.status, 1, `exit status for ${what}`);
    const failures = run.stderr.split('\n').filter(Boolean);
    assert.ok(failures.length > 0, 'at least one failure line');
    for (const line of failures) {
      assert.ok(line.includes(pin), `every failure line names the pin "${pin}"; got: ${line}`);
    }
  });
}

for (const [what, mutate, pin] of MUTATIONS) {
  test(`fails on ${what}, with the pin that catches it`, () => {
    const run = validate(mutate);
    assert.equal(run.status, 1, `exit status for ${what}`);
    const failures = run.stderr.split('\n').filter(Boolean);
    assert.ok(failures.length > 0, 'at least one failure line');
    for (const line of failures) {
      assert.ok(line.includes(pin), `every failure line names the pin "${pin}"; got: ${line}`);
    }
  });
}
