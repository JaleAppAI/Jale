import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * scripts/ops/employer-pool-enable-all.sh — the Phase 3 rollback step: if
 * BillingStack rolls back to Phase 2 code (Release step 8), nothing converges
 * member access any more, so every disabled employer-pool user is enabled
 * again. Dry run by default; --apply enables.
 *
 * Harness (person-tools.test.ts's pattern): a fake `aws` first on PATH that
 * records every call, answers sts get-caller-identity, serves list-users from
 * page files keyed by the pagination token, and fails on demand
 * (FAKE_FAIL_LIST, FAKE_FAIL_ENABLE=<username>). jq is the real one.
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'ops', 'employer-pool-enable-all.sh');
const POOL_ID = 'us-east-2_AbCdEf123';
const ACCOUNT = '123456789012';

interface Harness { dir: string; bin: string; state: string }

const FAKE_AWS = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/calls.log"
if [[ "$1 $2" == "sts get-caller-identity" ]]; then
  echo "${ACCOUNT}"
  exit 0
fi
if [[ "$1 $2" == "cognito-idp list-users" ]]; then
  if [[ -n "\${FAKE_FAIL_LIST:-}" ]]; then echo "An error occurred (AccessDeniedException)" >&2; exit 254; fi
  token="first"
  args=("$@")
  for ((i = 0; i < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--pagination-token" ]]; then token="\${args[$((i + 1))]}"; fi
  done
  cat "$FAKE_STATE/page-$token.json"
  exit 0
fi
if [[ "$1 $2" == "cognito-idp admin-enable-user" ]]; then
  if [[ -n "\${FAKE_FAIL_ENABLE:-}" && " $* " == *" --username \${FAKE_FAIL_ENABLE} "* ]]; then
    echo "An error occurred (TooManyRequestsException)" >&2
    exit 254
  fi
  exit 0
fi
echo "fake aws: unsupported $1 $2" >&2
exit 1
`;

function user(username: string, enabled: boolean) {
  return { Username: username, Enabled: enabled, UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: username }] };
}

type Pages = Record<string, { Users: unknown[]; PaginationToken?: string }>;

function makeHarness(pages: Pages): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-enable-all-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(bin, 'aws'), FAKE_AWS, { mode: 0o755 });
  for (const [token, page] of Object.entries(pages)) {
    fs.writeFileSync(path.join(state, `page-${token}.json`), JSON.stringify(page));
  }
  return { dir, bin, state };
}

function run(h: Harness, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${h.bin}:${process.env.PATH ?? ''}`, FAKE_STATE: h.state, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function calls(h: Harness): string[] {
  const f = path.join(h.state, 'calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

/** Two pages: three disabled users across them, two enabled ones. */
const PAGES: Pages = {
  first: { Users: [user('sub-1', true), user('sub-2', false)], PaginationToken: 'tok2' },
  tok2: { Users: [user('sub-3', false), user('sub-4', true), user('sub-5', false)] },
};

describe('scripts/ops/employer-pool-enable-all.sh', () => {
  const harnesses: Harness[] = [];
  const harness = (pages: Pages) => {
    const h = makeHarness(pages);
    harnesses.push(h);
    return h;
  };

  afterAll(() => {
    for (const h of harnesses) fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('warns in its header never to run with Phase 3 deployed and to review the dry-run list', () => {
    const header = fs.readFileSync(SCRIPT, 'utf8').split('# ---')[0];
    expect(header).toContain('Never run while Phase 3 code is deployed');
    expect(header).toContain('Review the dry-run list for users disabled on purpose; this enables every disabled user.');
    expect(header).toContain(`AWS_PROFILE=IvanJale bash scripts/ops/employer-pool-enable-all.sh --user-pool-id`);
  });

  it('dry run lists disabled users across pages and enables nobody', () => {
    const h = harness(PAGES);
    const r = run(h, ['--user-pool-id', POOL_ID]);

    expect(r.status).toBe(0);
    const made = calls(h);
    const lists = made.filter((c) => c.startsWith('cognito-idp list-users'));
    expect(lists).toHaveLength(2);
    expect(lists[0]).toContain(`--user-pool-id ${POOL_ID}`);
    expect(lists[1]).toContain('--pagination-token tok2');
    expect(made.some((c) => c.includes('admin-enable-user'))).toBe(false);
    expect(r.stdout).toContain('3 disabled');
    for (const sub of ['sub-2', 'sub-3', 'sub-5']) expect(r.stdout).toContain(sub);
    for (const sub of ['sub-1', 'sub-4']) expect(r.stdout).not.toContain(sub);
    expect(r.stdout).toContain('--apply');
  });

  it('takes the region from the pool id unless --region is given', () => {
    const h = harness(PAGES);
    expect(run(h, ['--user-pool-id', POOL_ID], { AWS_REGION: 'us-west-1' }).status).toBe(0);
    for (const c of calls(h)) expect(c).toContain('--region us-east-2');

    const explicit = harness(PAGES);
    expect(run(explicit, ['--user-pool-id', POOL_ID, '--region', 'us-west-1']).status).toBe(0);
    for (const c of calls(explicit)) expect(c).toContain('--region us-west-1');
  });

  it('prints the AWS account before enabling anyone', () => {
    const h = harness(PAGES);
    const r = run(h, ['--user-pool-id', POOL_ID, '--apply']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`account ${ACCOUNT}`);
    const made = calls(h);
    const stsAt = made.findIndex((c) => c.startsWith('sts get-caller-identity'));
    const firstEnable = made.findIndex((c) => c.startsWith('cognito-idp admin-enable-user'));
    expect(stsAt).toBeGreaterThan(-1);
    expect(stsAt).toBeLessThan(firstEnable);
    expect(r.stdout.indexOf(`account ${ACCOUNT}`)).toBeLessThan(r.stdout.indexOf('enabled '));
  });

  it('--apply enables exactly the disabled users', () => {
    const h = harness(PAGES);
    const r = run(h, ['--user-pool-id', POOL_ID, '--apply']);

    expect(r.status).toBe(0);
    const enables = calls(h).filter((c) => c.startsWith('cognito-idp admin-enable-user'));
    expect(enables).toEqual(['sub-2', 'sub-3', 'sub-5'].map(
      (sub) => `cognito-idp admin-enable-user --region us-east-2 --user-pool-id ${POOL_ID} --username ${sub}`,
    ));
    expect(r.stdout).toContain('enabled 3, failed 0');
  });

  it('--apply keeps going past a failed admin-enable-user and exits 1', () => {
    const h = harness(PAGES);
    const r = run(h, ['--user-pool-id', POOL_ID, '--apply'], { FAKE_FAIL_ENABLE: 'sub-3' });

    expect(r.status).toBe(1);
    const enables = calls(h).filter((c) => c.startsWith('cognito-idp admin-enable-user'));
    expect(enables.map((c) => c.split(' ').pop())).toEqual(['sub-2', 'sub-3', 'sub-5']);
    expect(r.stdout).toContain('enabled 2, failed 1');
    expect(r.stderr).toContain('sub-3');
  });

  it('a list-users failure stops the script before anything is enabled', () => {
    const h = harness(PAGES);
    const r = run(h, ['--user-pool-id', POOL_ID, '--apply'], { FAKE_FAIL_LIST: '1' });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('list-users failed');
    expect(calls(h).some((c) => c.includes('admin-enable-user'))).toBe(false);
    expect(r.stdout).not.toContain('disabled user');
  });

  it('--apply with nobody disabled enables nobody', () => {
    const h = harness({ first: { Users: [user('sub-1', true)] } });
    const r = run(h, ['--user-pool-id', POOL_ID, '--apply']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 disabled');
    expect(calls(h).some((c) => c.includes('admin-enable-user'))).toBe(false);
  });

  it('refuses without --user-pool-id', () => {
    const h = harness(PAGES);
    for (const args of [[], ['--apply'], ['--user-pool-id'], ['--user-pool-id', 'not a pool id']]) {
      const r = run(h, args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/user-pool-id/);
    }
    expect(calls(h)).toEqual([]);
  });
});
