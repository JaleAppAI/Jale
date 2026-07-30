import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseRepairArgs,
  runInspect,
  runRepair,
  WORKFLOW_STEP_KEYS,
  REPAIR_SETTABLE_STEP_KEYS,
  type Queryable,
} from '../../../scripts/repair-whatsapp-onboarding-v2';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000002';
const PHONE = '+19152272188';
const REASON = 'unwedge run stuck at profile.location after saveLocation fix';

/** Records every {text, values} call and answers deterministically by SQL shape. */
function makeFakeClient(opts: {
  userResolves?: boolean;
  activeRun?: { id: string; current_step_key: string; status: string; lock_version: number } | null;
  updateSucceeds?: boolean;
} = {}): {
  client: Queryable;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const userResolves = opts.userResolves ?? true;
  const activeRun = opts.activeRun === undefined
    ? { id: 'run-1', current_step_key: 'profile.location', status: 'active', lock_version: 7 }
    : opts.activeRun;
  const updateSucceeds = opts.updateSucceeds ?? true;

  const client: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });

      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM users WHERE id = \$1 AND user_type = 'worker' AND whatsapp_number = \$2/.test(text)) {
        return { rows: userResolves ? [{ id: USER_ID }] : [], rowCount: userResolves ? 1 : 0 };
      }
      if (/FROM worker_workflow_runs[\s\S]*FOR UPDATE/.test(text)) {
        return { rows: activeRun ? [activeRun] : [], rowCount: activeRun ? 1 : 0 };
      }
      if (/^\s*UPDATE worker_workflow_runs/.test(text)) {
        return updateSucceeds
          ? { rows: [{ lock_version: (activeRun?.lock_version ?? 0) + 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO worker_workflow_transitions/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/FROM worker_onboarding_state/.test(text)) {
        return { rows: [{ lifecycle: 'onboarding' }], rowCount: 1 };
      }
      if (/FROM worker_workflow_runs/.test(text)) {
        return { rows: activeRun ? [activeRun] : [], rowCount: activeRun ? 1 : 0 };
      }
      if (/full_name IS NOT NULL/.test(text)) {
        return { rows: [{ full_name: true, city: false }], rowCount: 1 };
      }
      if (/FROM worker_identity_challenges/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM worker_workflow_transitions/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/LIKE '%#err'/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { client, calls };
}

describe('WORKFLOW_STEP_KEYS mirror', () => {
  it('exactly matches the WorkflowStepKey union in onboarding-types.ts (no silent drift)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../lambda/whatsapp/lib/onboarding-types.ts'),
      'utf8',
    );
    const union = source.match(/export type WorkflowStepKey =([\s\S]*?);/);
    expect(union).not.toBeNull();
    const typeKeys = [...union![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...WORKFLOW_STEP_KEYS].sort()).toEqual([...typeKeys].sort());
  });
});

describe('parseRepairArgs', () => {
  it('accepts a valid inspect invocation (no --set-step, no mode flags)', () => {
    const parsed = parseRepairArgs(['--user-id', USER_ID, '--phone', PHONE]);
    expect(parsed).toEqual({
      ok: true,
      value: { userId: USER_ID, phone: PHONE, setStep: null, reason: null, dryRun: false },
    });
  });

  it('accepts a valid repair --dry-run invocation', () => {
    const parsed = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', 'profile.trade', '--reason', REASON, '--dry-run',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.setStep).toBe('profile.trade');
      expect(parsed.value.dryRun).toBe(true);
    }
  });

  it('rejects an unknown step key, listing the valid ones', () => {
    const parsed = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', 'profile.nonsense', '--reason', REASON, '--execute',
    ]);
    expect(parsed).toEqual({
      ok: false,
      error: expect.stringContaining('profile.location'),
    });
  });

  // Task 6/B4: neither the two voice holding steps (no prompt of their own)
  // nor the three pre-auth/bind keys (no bound run's state context for this
  // repair's advanceWorkflow-shaped UPDATE to act on) may ever be a
  // `--set-step` target — landing a repair there would strand the worker
  // exactly as badly as the defect this tool exists to fix.
  it.each([
    'profile.voice_choice',
    'profile.voice_processing',
    'start.choose_language',
    'identity.verify_otp',
    'legal.review',
  ])('rejects --set-step %s (excluded holding/pre-auth class), naming the rejected key and listing the permitted ones', (excluded) => {
    const parsed = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', excluded, '--reason', REASON, '--execute',
    ]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(excluded);
      expect(parsed.error).toContain('profile.trade'); // a genuinely settable key
      // Every listed permitted key must itself be settable.
      for (const key of REPAIR_SETTABLE_STEP_KEYS) {
        expect(parsed.error).toContain(key);
      }
    }
  });

  it('REPAIR_SETTABLE_STEP_KEYS excludes exactly the two voice holding steps and the three pre-auth keys', () => {
    const excluded = ['profile.voice_choice', 'profile.voice_processing', 'start.choose_language', 'identity.verify_otp', 'legal.review'];
    for (const key of excluded) {
      expect(REPAIR_SETTABLE_STEP_KEYS).not.toContain(key);
    }
    expect(REPAIR_SETTABLE_STEP_KEYS).toHaveLength(WORKFLOW_STEP_KEYS.length - excluded.length);
  });

  it('accepts every REPAIR_SETTABLE_STEP_KEYS member', () => {
    for (const key of REPAIR_SETTABLE_STEP_KEYS) {
      const parsed = parseRepairArgs([
        '--user-id', USER_ID, '--phone', PHONE,
        '--set-step', key, '--reason', REASON, '--execute',
      ]);
      expect(parsed.ok).toBe(true);
    }
  });

  it('rejects --set-step without --reason', () => {
    const parsed = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', 'profile.trade', '--execute',
    ]);
    expect(parsed).toEqual({ ok: false, error: 'Missing required flag: --reason' });
  });

  it('rejects --set-step with both or neither of --dry-run/--execute', () => {
    const both = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', 'profile.trade', '--reason', REASON, '--dry-run', '--execute',
    ]);
    const neither = parseRepairArgs([
      '--user-id', USER_ID, '--phone', PHONE,
      '--set-step', 'profile.trade', '--reason', REASON,
    ]);
    expect(both.ok).toBe(false);
    expect(neither.ok).toBe(false);
  });

  it('rejects mode flags and --reason in inspect mode (read-only means read-only)', () => {
    expect(parseRepairArgs(['--user-id', USER_ID, '--phone', PHONE, '--execute']).ok).toBe(false);
    expect(parseRepairArgs(['--user-id', USER_ID, '--phone', PHONE, '--dry-run']).ok).toBe(false);
    expect(parseRepairArgs(['--user-id', USER_ID, '--phone', PHONE, '--reason', REASON]).ok).toBe(false);
  });

  it('rejects a non-UUID --user-id', () => {
    const parsed = parseRepairArgs(['--user-id', 'not-a-uuid', '--phone', PHONE]);
    expect(parsed).toEqual({ ok: false, error: '--user-id must be a syntactic UUID' });
  });

  it('never echoes a misplaced bare value in the error message, even if it is phone-shaped', () => {
    const parsed = parseRepairArgs(['--user-id', USER_ID, PHONE]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).not.toContain(PHONE);
      expect(parsed.error).toContain('redacted');
    }
  });
});

describe('runInspect', () => {
  it('is strictly read-only: no BEGIN, no INSERT/UPDATE/DELETE', async () => {
    const { client, calls } = makeFakeClient();

    await runInspect(client, { userId: USER_ID, phone: PHONE });

    for (const call of calls) {
      expect(call.text).not.toMatch(/^\s*(BEGIN|INSERT|UPDATE|DELETE)/i);
    }
  });

  it('aborts on a phone/user mismatch without leaking the raw phone', async () => {
    const { client } = makeFakeClient({ userResolves: false });

    await expect(runInspect(client, { userId: USER_ID, phone: PHONE }))
      .rejects.toThrow(/No matching worker/);
    try {
      await runInspect(client, { userId: USER_ID, phone: PHONE });
    } catch (err) {
      expect((err as Error).message).not.toContain(PHONE);
    }
  });

  it('reports the phone as a 64-hex hash, never raw', async () => {
    const { client } = makeFakeClient();

    const report = await runInspect(client, { userId: USER_ID, phone: PHONE });

    expect(report.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toContain(PHONE.slice(1)); // digits alone
  });
});

describe('runRepair', () => {
  it('dry-run resolves the run, prints the would-be move, and ROLLBACKs without any UPDATE', async () => {
    const { client, calls } = makeFakeClient();

    const outcome = await runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.trade',
      reason: REASON, dryRun: true, operator: 'op-1',
    });

    expect(outcome).toEqual({
      dryRun: true,
      runId: 'run-1',
      fromStepKey: 'profile.location',
      toStepKey: 'profile.trade',
    });
    expect(calls.some((c) => /^ROLLBACK$/.test(c.text.trim()))).toBe(true);
    expect(calls.some((c) => /^COMMIT$/.test(c.text.trim()))).toBe(false);
    expect(calls.some((c) => /^\s*UPDATE/i.test(c.text))).toBe(false);
    expect(calls.some((c) => /INSERT INTO worker_workflow_transitions/.test(c.text))).toBe(false);
  });

  it('execute moves the step with an optimistic lock_version check and records a transition row', async () => {
    const { client, calls } = makeFakeClient();

    const outcome = await runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.trade',
      reason: REASON, dryRun: false, operator: 'op-1',
    });

    expect(outcome).toEqual({
      dryRun: false,
      runId: 'run-1',
      fromStepKey: 'profile.location',
      toStepKey: 'profile.trade',
      newLockVersion: 8,
    });

    const update = calls.find((c) => /^\s*UPDATE worker_workflow_runs/.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/lock_version = lock_version \+ 1/);
    expect(update!.text).toMatch(/WHERE id = \$2 AND lock_version = \$3/);
    expect(update!.values).toEqual(['profile.trade', 'run-1', 7]);

    const transition = calls.find((c) => /INSERT INTO worker_workflow_transitions/.test(c.text));
    expect(transition).toBeDefined();
    expect(transition!.values[1]).toBe('profile.location');
    expect(transition!.values[2]).toBe('profile.trade');
    expect(String(transition!.values[3])).toContain('operator_repair');
    expect(String(transition!.values[4])).toContain('op-1');

    expect(calls.some((c) => /^COMMIT$/.test(c.text.trim()))).toBe(true);
  });

  it('refuses when there is no ACTIVE run (completed/declined workers are reset territory)', async () => {
    const { client } = makeFakeClient({ activeRun: null });

    await expect(runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.trade',
      reason: REASON, dryRun: false, operator: 'op-1',
    })).rejects.toThrow(/No ACTIVE workflow run/);
  });

  it('refuses a no-op repair to the current step', async () => {
    const { client } = makeFakeClient();

    await expect(runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.location',
      reason: REASON, dryRun: false, operator: 'op-1',
    })).rejects.toThrow(/already at profile\.location/);
  });

  it('surfaces a concurrent lock_version move instead of silently succeeding', async () => {
    const { client } = makeFakeClient({ updateSucceeds: false });

    await expect(runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.trade',
      reason: REASON, dryRun: false, operator: 'op-1',
    })).rejects.toThrow(/Concurrent modification/);
  });

  it('aborts on a phone/user mismatch before touching any run', async () => {
    const { client, calls } = makeFakeClient({ userResolves: false });

    await expect(runRepair(client, {
      userId: USER_ID, phone: PHONE, setStep: 'profile.trade',
      reason: REASON, dryRun: false, operator: 'op-1',
    })).rejects.toThrow(/No matching worker/);

    expect(calls.some((c) => /worker_workflow_runs/.test(c.text) && /UPDATE/i.test(c.text))).toBe(false);
    expect(calls.some((c) => /^ROLLBACK$/.test(c.text.trim()))).toBe(true);
  });
});
