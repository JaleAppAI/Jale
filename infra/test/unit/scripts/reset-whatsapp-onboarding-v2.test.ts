import { createHash } from 'node:crypto';

import {
  parseResetArgs,
  runReset,
  WHATSAPP_V2_WORKFLOW_VERSION,
  type Queryable,
} from '../../../scripts/reset-whatsapp-onboarding-v2';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PHONE = '+19152272188';
const REASON = 'retest onboarding v2 gate';

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.trim()).digest('hex');
}

const DELETE_ORDER = [
  'worker_message_intents',
  'worker_domain_outbox',
  'worker_workflow_transitions',
  'worker_workflow_runs',
  'worker_identity_challenges',
  'worker_onboarding_state',
  'whatsapp_outbox',
  'whatsapp_processed_messages',
  'whatsapp_conversations',
  'job_conversation_messages',
  'job_message_outbox',
  'job_conversations',
  'job_applications',
  'worker_job_impressions',
  'worker_match_log',
  'job_candidates',
  'worker_trust_assessments',
  'worker_profile_ai_extractions',
  'worker_profile_media',
  'worker_skills',
];

/** Records every {text, values} call and answers deterministically by SQL shape. */
function makeFakeClient(opts: { userResolves?: boolean } = {}): {
  client: Queryable;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const userResolves = opts.userResolves ?? true;

  const client: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });

      if (/^BEGIN$/.test(text.trim()) || /^COMMIT$/.test(text.trim()) || /^ROLLBACK$/.test(text.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM users WHERE id = \$1 AND user_type = \$2 AND whatsapp_number = \$3/.test(text)) {
        return { rows: userResolves ? [{ id: USER_ID }] : [], rowCount: userResolves ? 1 : 0 };
      }
      if (/^\s*SELECT count\(\*\)/.test(text)) {
        return { rows: [{ count: 2 }], rowCount: 1 };
      }
      if (/^\s*DELETE FROM/.test(text)) {
        return { rows: [], rowCount: 2 };
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
      if (/^\s*INSERT INTO worker_workflow_runs/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*INSERT INTO worker_reset_audit/.test(text)) {
        return { rows: [{ id: 'audit-row-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { client, calls };
}

describe('parseResetArgs', () => {
  it('accepts a fully valid --dry-run invocation', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', REASON,
      '--dry-run',
    ]);
    expect(result).toEqual({
      ok: true,
      value: { userId: USER_ID, phone: PHONE, reason: REASON, dryRun: true },
    });
  });

  it('accepts a fully valid --execute invocation', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', REASON,
      '--execute',
    ]);
    expect(result).toEqual({
      ok: true,
      value: { userId: USER_ID, phone: PHONE, reason: REASON, dryRun: false },
    });
  });

  it('rejects a missing --user-id', () => {
    const result = parseResetArgs(['--phone', PHONE, '--reason', REASON, '--dry-run']);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty --reason', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', '',
      '--dry-run',
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-UUID --user-id', () => {
    const result = parseResetArgs([
      '--user-id', 'not-a-uuid',
      '--phone', PHONE,
      '--reason', REASON,
      '--dry-run',
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', REASON,
      '--dry-run',
      '--all-users',
    ]);
    expect(result.ok).toBe(false);
  });

  it('never echoes a misplaced bare (non `--`) value in the error message, even if it is phone-shaped', () => {
    const result = parseResetArgs([PHONE, '--reason', REASON, '--dry-run']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(PHONE);
      expect(result.error).toBe('Unrecognized argument (redacted)');
    }
  });

  it('rejects a second --user-id', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--user-id', 'bbbbbbbb-0000-0000-0000-000000000002',
      '--phone', PHONE,
      '--reason', REASON,
      '--dry-run',
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects both --dry-run and --execute supplied together', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', REASON,
      '--dry-run',
      '--execute',
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects neither --dry-run nor --execute supplied', () => {
    const result = parseResetArgs([
      '--user-id', USER_ID,
      '--phone', PHONE,
      '--reason', REASON,
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('runReset', () => {
  it('dry-run issues only scoped SELECT count(*) per table, then ROLLBACK — no insert/update/delete, no audit row', async () => {
    const { client, calls } = makeFakeClient();

    const outcome = await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: true,
      operator: 'test-operator',
    });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.auditId).toBeUndefined();

    const mutating = calls.filter((c) =>
      /^\s*(DELETE|INSERT|UPDATE)\b/i.test(c.text),
    );
    expect(mutating).toHaveLength(0);

    expect(calls.some((c) => /^ROLLBACK$/.test(c.text.trim()))).toBe(true);
    expect(calls.some((c) => /^COMMIT$/.test(c.text.trim()))).toBe(false);

    for (const table of DELETE_ORDER) {
      expect(
        calls.some(
          (c) =>
            new RegExp(`^\\s*SELECT count\\(\\*\\)::int AS count FROM ${table} WHERE`).test(c.text),
        ),
      ).toBe(true);
    }
  });

  it('--phone mismatch aborts before any DELETE (and before any mutation)', async () => {
    const { client, calls } = makeFakeClient({ userResolves: false });

    await expect(
      runReset(client, {
        userId: USER_ID,
        phone: PHONE,
        reason: REASON,
        dryRun: false,
        operator: 'test-operator',
      }),
    ).rejects.toThrow();

    const mutating = calls.filter((c) => /^\s*(DELETE|INSERT|UPDATE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
    expect(calls.some((c) => /^ROLLBACK$/.test(c.text.trim()))).toBe(true);
  });

  it('never leaks the raw phone in any thrown error message', async () => {
    const { client } = makeFakeClient({ userResolves: false });

    try {
      await runReset(client, {
        userId: USER_ID,
        phone: PHONE,
        reason: REASON,
        dryRun: false,
        operator: 'test-operator',
      });
      throw new Error('expected runReset to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(PHONE);
    }
  });

  it('--execute issues deletes in exactly the table order above, each WHERE-bound to the target', async () => {
    const { client, calls } = makeFakeClient();

    await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const deletes = calls.filter((c) => /^\s*DELETE FROM/.test(c.text));
    expect(deletes).toHaveLength(DELETE_ORDER.length);
    deletes.forEach((call, i) => {
      expect(call.text).toContain(`DELETE FROM ${DELETE_ORDER[i]}`);
      expect(call.text).toMatch(/WHERE/);
      expect(call.values).toEqual([USER_ID, PHONE, hashPhone(PHONE)]);
    });
  });

  it('never issues DELETE FROM users or DELETE FROM legal_consent_log', async () => {
    const { client, calls } = makeFakeClient();

    await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    expect(calls.some((c) => /DELETE FROM users\b/.test(c.text))).toBe(false);
    expect(calls.some((c) => /DELETE FROM legal_consent_log\b/.test(c.text))).toBe(false);
  });

  it('never issues a bare DELETE FROM <table> without a WHERE clause', async () => {
    const { client, calls } = makeFakeClient();

    await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const deletes = calls.filter((c) => /^\s*DELETE FROM/.test(c.text));
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      expect(del.text).toMatch(/WHERE/i);
    }
  });

  it('the users and worker_profiles steps are UPDATEs that keep the row (never a DELETE)', async () => {
    const { client, calls } = makeFakeClient();

    await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const profileUpdate = calls.find((c) => /^\s*UPDATE worker_profiles/.test(c.text));
    const usersUpdate = calls.find((c) => /^\s*UPDATE users/.test(c.text));
    expect(profileUpdate).toBeDefined();
    expect(usersUpdate).toBeDefined();
    expect(profileUpdate!.text).toContain('WHERE user_id = $1');
    expect(usersUpdate!.text).toContain('WHERE id = $1');

    // Preserved columns must never appear on the left of a SET assignment
    // (the SET clause is everything between SET and WHERE).
    const usersSetClause = usersUpdate!.text.split(/\bWHERE\b/)[0];
    const profileSetClause = profileUpdate!.text.split(/\bWHERE\b/)[0];
    for (const preserved of ['id =', 'cognito_sub =', 'phone =', 'whatsapp_number =', 'user_type =', 'tenant_id =', 'created_at =', 'email =', 'tos_accepted_at =', 'tos_version =', 'privacy_accepted_at =', 'privacy_version =', 'whatsapp_linked_at =']) {
      expect(usersSetClause).not.toContain(preserved);
    }
    for (const preserved of ['user_id =', 'phone =']) {
      expect(profileSetClause).not.toContain(preserved);
    }
  });

  it('creates exactly one worker_onboarding_state row (onboarding) and one worker_workflow_runs row (active, start.choose_language, version 1)', async () => {
    const { client, calls } = makeFakeClient();

    await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const stateInserts = calls.filter((c) => /^\s*INSERT INTO worker_onboarding_state/.test(c.text));
    const runInserts = calls.filter((c) => /^\s*INSERT INTO worker_workflow_runs/.test(c.text));
    expect(stateInserts).toHaveLength(1);
    expect(runInserts).toHaveLength(1);
    expect(stateInserts[0].text).toContain("'onboarding'");
    expect(runInserts[0].text).toContain("'start.choose_language'");
    expect(runInserts[0].text).toContain("'active'");
    expect(runInserts[0].values).toContain(WHATSAPP_V2_WORKFLOW_VERSION);
    expect(WHATSAPP_V2_WORKFLOW_VERSION).toBe(1);
  });

  it('each execute writes exactly one audit row with operator, reason, dry_run=false, table_counts, and a 64-hex phone_hash', async () => {
    const { client, calls } = makeFakeClient();

    const outcome = await runReset(client, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const auditInserts = calls.filter((c) => /^\s*INSERT INTO worker_reset_audit/.test(c.text));
    expect(auditInserts).toHaveLength(1);
    const [uid, phoneHash, operator, reason, tableCountsJson] = auditInserts[0].values as [
      string, string, string, string, string,
    ];
    expect(uid).toBe(USER_ID);
    expect(phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash).toBe(hashPhone(PHONE));
    expect(operator).toBe('test-operator');
    expect(reason).toBe(REASON);
    expect(() => JSON.parse(tableCountsJson)).not.toThrow();
    expect(outcome.auditId).toBe('audit-row-1');

    expect(calls.some((c) => /^COMMIT$/.test(c.text.trim()))).toBe(true);
  });

  it('running --execute twice produces the same terminal shape and a second committed audit row', async () => {
    const { client: client1 } = makeFakeClient();
    const outcome1 = await runReset(client1, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    const { client: client2, calls: calls2 } = makeFakeClient();
    const outcome2 = await runReset(client2, {
      userId: USER_ID,
      phone: PHONE,
      reason: REASON,
      dryRun: false,
      operator: 'test-operator',
    });

    expect(outcome1.dryRun).toBe(false);
    expect(outcome2.dryRun).toBe(false);
    expect(outcome2.auditId).toBe('audit-row-1');

    const stateInserts = calls2.filter((c) => /^\s*INSERT INTO worker_onboarding_state/.test(c.text));
    const runInserts = calls2.filter((c) => /^\s*INSERT INTO worker_workflow_runs/.test(c.text));
    const auditInserts = calls2.filter((c) => /^\s*INSERT INTO worker_reset_audit/.test(c.text));
    expect(stateInserts).toHaveLength(1);
    expect(runInserts).toHaveLength(1);
    expect(auditInserts).toHaveLength(1);
  });

  it('never prints the raw --phone value to stdout', async () => {
    const { client } = makeFakeClient();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runReset(client, {
        userId: USER_ID,
        phone: PHONE,
        reason: REASON,
        dryRun: false,
        operator: 'test-operator',
      });

      for (const call of logSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(PHONE);
        }
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
