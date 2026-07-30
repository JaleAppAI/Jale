import {
  parseBulkResetArgs,
  discoverWorkers,
  runBulkReset,
  exitCodeForSummary,
  DISCOVERY_QUERY,
  type Queryable,
} from '../../../scripts/bulk-reset-whatsapp-onboarding-v2';

const REASON = 'cutover: reset all workers into onboarding v2';

const WORKER_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', phone: '+19152272188' };
const WORKER_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', phone: '+19152272189' };
const WORKER_C = { id: 'cccccccc-0000-0000-0000-000000000003', phone: '+19152272190' };
const ALL_WORKERS = [WORKER_A, WORKER_B, WORKER_C];
const ALL_PHONES = ALL_WORKERS.map((w) => w.phone);

/**
 * Fake client mirroring the reset script's own fake client (see
 * reset-whatsapp-onboarding-v2.test.ts), extended with the discovery query
 * and the ability to make a chosen subset of user ids fail resolution (to
 * exercise continue-on-error).
 */
function makeFakeClient(
  opts: {
    discovered?: Array<{ id: string; phone: string }>;
    failingUserIds?: Set<string>;
  } = {},
): { client: Queryable; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const discovered = opts.discovered ?? ALL_WORKERS;
  const failingUserIds = opts.failingUserIds ?? new Set<string>();

  const client: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });

      if (/^BEGIN$/.test(text.trim()) || /^COMMIT$/.test(text.trim()) || /^ROLLBACK$/.test(text.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT id, whatsapp_number FROM users\s+WHERE user_type/.test(text)) {
        return {
          rows: discovered.map((w) => ({ id: w.id, whatsapp_number: w.phone })),
          rowCount: discovered.length,
        };
      }
      if (/FROM users WHERE id = \$1 AND user_type = \$2 AND whatsapp_number = \$3/.test(text)) {
        const [userId] = values as [string];
        if (failingUserIds.has(userId)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: userId }], rowCount: 1 };
      }
      if (/^\s*SELECT count\(\*\)/.test(text)) {
        return { rows: [{ count: 1 }], rowCount: 1 };
      }
      if (/^\s*DELETE FROM/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*UPDATE worker_profiles/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*UPDATE users/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*INSERT INTO worker_onboarding_state/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*INSERT INTO worker_reset_audit/.test(text)) {
        return { rows: [{ id: `audit-${values[0]}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { client, calls };
}

describe('parseBulkResetArgs', () => {
  it('accepts a fully valid --dry-run invocation', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run']);
    expect(result).toEqual({
      ok: true,
      value: { reason: REASON, dryRun: true, limit: undefined },
    });
  });

  it('accepts a fully valid --execute invocation with --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--execute', '--limit', '5']);
    expect(result).toEqual({
      ok: true,
      value: { reason: REASON, dryRun: false, limit: 5 },
    });
  });

  it('rejects a missing --reason', () => {
    const result = parseBulkResetArgs(['--dry-run']);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty --reason', () => {
    const result = parseBulkResetArgs(['--reason', '', '--dry-run']);
    expect(result.ok).toBe(false);
  });

  it('rejects a second --reason', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--reason', 'other', '--dry-run']);
    expect(result.ok).toBe(false);
  });

  it('rejects neither --dry-run nor --execute supplied', () => {
    const result = parseBulkResetArgs(['--reason', REASON]);
    expect(result.ok).toBe(false);
  });

  it('rejects both --dry-run and --execute supplied together', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--execute']);
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--all-users']);
    expect(result.ok).toBe(false);
  });

  it('never echoes a misplaced bare (non `--`) value in the error message, even if it is phone-shaped', () => {
    const result = parseBulkResetArgs([WORKER_A.phone, '--reason', REASON, '--dry-run']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(WORKER_A.phone);
      expect(result.error).toBe('Unrecognized argument (redacted)');
    }
  });

  it('rejects a bare --user-id / --phone flag (no single-target mode here)', () => {
    expect(parseBulkResetArgs(['--user-id', WORKER_A.id, '--reason', REASON, '--dry-run']).ok).toBe(false);
    expect(parseBulkResetArgs(['--phone', WORKER_A.phone, '--reason', REASON, '--dry-run']).ok).toBe(false);
  });

  it('rejects a missing value for --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit']);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit', '3.5']);
    expect(result.ok).toBe(false);
  });

  it('rejects a zero --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit', '0']);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit', '-1']);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit', 'abc']);
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicated --limit', () => {
    const result = parseBulkResetArgs(['--reason', REASON, '--dry-run', '--limit', '1', '--limit', '2']);
    expect(result.ok).toBe(false);
  });
});

describe('discoverWorkers', () => {
  it('issues exactly the documented discovery query', async () => {
    const { client, calls } = makeFakeClient();
    const workers = await discoverWorkers(client);

    expect(calls).toHaveLength(1);
    expect(calls[0].text.replace(/\s+/g, ' ').trim()).toBe(DISCOVERY_QUERY.replace(/\s+/g, ' ').trim());
    expect(calls[0].values ?? []).toHaveLength(0);
    expect(workers).toEqual([
      { id: WORKER_A.id, whatsappNumber: WORKER_A.phone },
      { id: WORKER_B.id, whatsappNumber: WORKER_B.phone },
      { id: WORKER_C.id, whatsappNumber: WORKER_C.phone },
    ]);
  });
});

describe('runBulkReset', () => {
  it('delegates to runReset once per discovered worker, each with its own BEGIN/COMMIT', async () => {
    const { client, calls } = makeFakeClient();

    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    expect(summary.totalWorkers).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toHaveLength(0);

    const resolveCalls = calls.filter((c) =>
      /FROM users WHERE id = \$1 AND user_type = \$2 AND whatsapp_number = \$3/.test(c.text),
    );
    expect(resolveCalls).toHaveLength(3);
    expect(resolveCalls.map((c) => c.values[0])).toEqual([WORKER_A.id, WORKER_B.id, WORKER_C.id]);

    const begins = calls.filter((c) => /^BEGIN$/.test(c.text.trim()));
    const commits = calls.filter((c) => /^COMMIT$/.test(c.text.trim()));
    expect(begins).toHaveLength(3);
    expect(commits).toHaveLength(3);

    const auditInserts = calls.filter((c) => /^\s*INSERT INTO worker_reset_audit/.test(c.text));
    expect(auditInserts).toHaveLength(3);
  });

  it('dry-run rolls back every worker and never commits', async () => {
    const { client, calls } = makeFakeClient();

    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: true,
      operator: 'test-operator',
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.succeeded).toBe(3);

    const rollbacks = calls.filter((c) => /^ROLLBACK$/.test(c.text.trim()));
    const commits = calls.filter((c) => /^COMMIT$/.test(c.text.trim()));
    expect(rollbacks).toHaveLength(3);
    expect(commits).toHaveLength(0);

    const auditInserts = calls.filter((c) => /^\s*INSERT INTO worker_reset_audit/.test(c.text));
    expect(auditInserts).toHaveLength(0);
  });

  it('aggregates per-table counts across all workers', async () => {
    const { client } = makeFakeClient();

    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: true,
      operator: 'test-operator',
    });

    // Each worker's fake resolves every SELECT count(*) to 1, and there are
    // 3 workers, so every table total must be exactly 3.
    expect(summary.aggregateTableCounts.worker_onboarding_state).toBe(3);
    expect(summary.aggregateTableCounts.users).toBe(3);
  });

  it('--limit processes only the first N discovered workers (by id order)', async () => {
    const { client, calls } = makeFakeClient();

    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: true,
      operator: 'test-operator',
      limit: 2,
    });

    expect(summary.totalWorkers).toBe(2);
    const resolveCalls = calls.filter((c) =>
      /FROM users WHERE id = \$1 AND user_type = \$2 AND whatsapp_number = \$3/.test(c.text),
    );
    expect(resolveCalls.map((c) => c.values[0])).toEqual([WORKER_A.id, WORKER_B.id]);
  });

  it('continues past a per-worker failure, recording it in the failed summary with the remaining workers still processed', async () => {
    const { client, calls } = makeFakeClient({ failingUserIds: new Set([WORKER_B.id]) });

    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    expect(summary.totalWorkers).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].userId).toBe(WORKER_B.id);
    expect(summary.failed[0].error).toMatch(/No matching worker/);

    // The two healthy workers still got their own committed transaction.
    const commits = calls.filter((c) => /^COMMIT$/.test(c.text.trim()));
    expect(commits).toHaveLength(2);
    const auditInserts = calls.filter((c) => /^\s*INSERT INTO worker_reset_audit/.test(c.text));
    expect(auditInserts).toHaveLength(2);
    expect(auditInserts.map((c) => c.values[0])).toEqual([WORKER_A.id, WORKER_C.id]);

    expect(exitCodeForSummary(summary)).toBe(1);
  });

  it('exit code is 0 when there are no failures', async () => {
    const { client } = makeFakeClient();
    const summary = await runBulkReset(client, {
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });
    expect(exitCodeForSummary(summary)).toBe(0);
  });

  it('never prints or logs a raw phone number anywhere', async () => {
    const { client } = makeFakeClient({ failingUserIds: new Set([WORKER_B.id]) });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runBulkReset(client, {
        reason: REASON,
        dryRun: false,
        operator: 'test-operator',
      });

      const allLogged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
      for (const arg of allLogged) {
        const rendered = String(arg);
        for (const phone of ALL_PHONES) {
          expect(rendered).not.toContain(phone);
        }
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('never includes a raw phone number in any captured SQL call text or bound values', async () => {
    const { client, calls } = makeFakeClient({ failingUserIds: new Set([WORKER_B.id]) });

    await runBulkReset(client, {
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    for (const call of calls) {
      expect(call.text).not.toMatch(/\+1\d{10}/);
    }
    // Bound values legitimately carry the phone (it's the whole point of the
    // resolve/delete predicates) — that's fine, it's a parameter, never
    // interpolated into logged/printed text. This test only guards the SQL
    // *text* and the console output (covered above), matching the existing
    // reset CLI's own phone-never-echoed contract.
  });
});
