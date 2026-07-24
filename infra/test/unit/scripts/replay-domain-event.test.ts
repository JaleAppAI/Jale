import {
  parseReplayArgs,
  replayDomainEvent,
  type Queryable,
} from '../../../scripts/replay-domain-event';

const ROW_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EVENT_KEY = 'worker.ready:aaaaaaaa-0000-0000-0000-000000000001:1';
const AGGREGATE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER_ROW_ID = 'cccccccc-0000-0000-0000-000000000003';
const OTHER_EVENT_KEY = 'worker.ready:cccccccc-0000-0000-0000-000000000003:9';
const PHONE = '+19152272188';
const BODY = 'Hey, are you available for the plumbing job on 5th street tomorrow at noon?';
const OTP = '482913';
const DB_URL = 'postgres://jale_admin:supersecret@db.internal:5432/jale';

interface OutboxRow {
  [key: string]: unknown;
  id: string;
  event_type: string;
  aggregate_id: string;
  event_key: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  leased_until: string | null;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: ROW_ID,
    event_type: 'worker.ready',
    aggregate_id: AGGREGATE_ID,
    event_key: EVENT_KEY,
    payload: { phone: PHONE, body: BODY, otp: OTP, dbUrl: DB_URL, count: 3 },
    status: 'pending',
    attempts: 0,
    next_attempt_at: '2026-07-22T12:00:00.000Z',
    last_error: null,
    leased_until: null,
    lease_token: null,
    created_at: '2026-07-22T11:00:00.000Z',
    updated_at: '2026-07-22T11:00:00.000Z',
    ...overrides,
  };
}

function makeFakeClient(opts: {
  rows?: OutboxRow[];
  lifecycle?: string | null;
  intentCounts?: Array<{ status: string; count: number }>;
} = {}): { client: Queryable; calls: Array<{ text: string; values: unknown[] }> } {
  const rows = opts.rows ?? [makeRow()];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });

      if (/UPDATE\s+worker_domain_outbox/i.test(text)) {
        const id = values[0] as string;
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.status = 'pending';
          row.leased_until = null;
          row.lease_token = null;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (/FROM\s+worker_domain_outbox/i.test(text)) {
        const identifier = values[0] as string;
        const matches = rows.filter((r) => r.id === identifier || r.event_key === identifier);
        return { rows: matches, rowCount: matches.length };
      }

      if (/FROM\s+worker_onboarding_state/i.test(text)) {
        if (opts.lifecycle === null || opts.lifecycle === undefined) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ lifecycle: opts.lifecycle }], rowCount: 1 };
      }

      if (/FROM\s+worker_message_intents/i.test(text)) {
        const counts = opts.intentCounts ?? [];
        return { rows: counts.map((c) => ({ status: c.status, count: c.count })), rowCount: counts.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

describe('parseReplayArgs', () => {
  it('accepts a single uuid id with no flags (dry-run default)', () => {
    const result = parseReplayArgs([ROW_ID]);
    expect(result).toEqual({ ok: true, value: { kind: 'replay', identifier: ROW_ID, execute: false } });
  });

  it('accepts a single event_key id with --execute', () => {
    const result = parseReplayArgs([EVENT_KEY, '--execute']);
    expect(result).toEqual({ ok: true, value: { kind: 'replay', identifier: EVENT_KEY, execute: true } });
  });

  it('rejects zero ids', () => {
    const result = parseReplayArgs([]);
    expect(result.ok).toBe(false);
  });

  it('rejects zero ids when only --execute is given', () => {
    const result = parseReplayArgs(['--execute']);
    expect(result.ok).toBe(false);
  });

  it('rejects more than one id', () => {
    const result = parseReplayArgs([ROW_ID, OTHER_ROW_ID]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(ROW_ID);
      expect(result.error).not.toContain(OTHER_ROW_ID);
    }
  });

  it('rejects a comma-separated id list', () => {
    const result = parseReplayArgs([`${ROW_ID},${OTHER_ROW_ID}`]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(ROW_ID);
    }
  });

  it('rejects wildcard characters (*)', () => {
    const result = parseReplayArgs(['worker.ready:*']);
    expect(result.ok).toBe(false);
  });

  it('rejects wildcard characters (%)', () => {
    const result = parseReplayArgs(['worker.ready:%']);
    expect(result.ok).toBe(false);
  });

  it('rejects glob bracket characters', () => {
    const result = parseReplayArgs(['worker.ready:[0-9]']);
    expect(result.ok).toBe(false);
  });

  it('rejects range syntax', () => {
    const result = parseReplayArgs([`${ROW_ID}..${OTHER_ROW_ID}`]);
    expect(result.ok).toBe(false);
  });

  it('rejects a --all bulk flag', () => {
    const result = parseReplayArgs(['--all']);
    expect(result.ok).toBe(false);
  });

  it('rejects a --bulk flag even alongside a valid id', () => {
    const result = parseReplayArgs([ROW_ID, '--bulk']);
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    const result = parseReplayArgs([ROW_ID, '--force']);
    expect(result.ok).toBe(false);
  });

  it('never echoes a bare non `--` positional in any error message', () => {
    const results = [
      parseReplayArgs([ROW_ID, OTHER_ROW_ID]),
      parseReplayArgs([`${ROW_ID},${OTHER_ROW_ID}`]),
      parseReplayArgs(['worker.ready:*']),
      parseReplayArgs([`${ROW_ID}..${OTHER_ROW_ID}`]),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(ROW_ID);
        expect(result.error).not.toContain(OTHER_ROW_ID);
      }
    }
  });

  it('dry-run is the default (execute=false) when --execute is omitted', () => {
    const result = parseReplayArgs([EVENT_KEY]);
    expect(result).toEqual({ ok: true, value: { kind: 'replay', identifier: EVENT_KEY, execute: false } });
  });
});

describe('replayDomainEvent — authorization boundary', () => {
  it('the only mutating statement (on --execute) is an UPDATE against worker_domain_outbox', async () => {
    const { client, calls } = makeFakeClient({ rows: [makeRow({ status: 'pending' })] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await replayDomainEvent(client, ROW_ID, true);
    } finally {
      logSpy.mockRestore();
    }
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(1);
    expect(mutating[0].text).toMatch(/UPDATE\s+worker_domain_outbox/i);
    for (const c of mutating) {
      expect(c.text).not.toMatch(/worker_onboarding_state|worker_message_intents/i);
    }
  });

  it('dry-run (no --execute) issues zero mutating statements', async () => {
    const { client, calls } = makeFakeClient({ rows: [makeRow({ status: 'pending' })] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await replayDomainEvent(client, ROW_ID, false);
    } finally {
      logSpy.mockRestore();
    }
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
  });
});

describe('replayDomainEvent — idempotency', () => {
  it('replay reuses the original event_key and payload (UPDATE does not alter them)', async () => {
    const { client, calls } = makeFakeClient({ rows: [makeRow({ status: 'failed' })] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await replayDomainEvent(client, ROW_ID, true);
    } finally {
      logSpy.mockRestore();
    }
    const update = calls.find((c) => /UPDATE\s+worker_domain_outbox/i.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).not.toMatch(/event_key\s*=/i);
    expect(update!.text).not.toMatch(/payload\s*=/i);
    expect(update!.values).not.toContain(EVENT_KEY);
  });

  it('a completed event is a safe no-op: no mutation, exit success', async () => {
    const { client, calls } = makeFakeClient({ rows: [makeRow({ status: 'completed' })] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let result;
    try {
      result = await replayDomainEvent(client, ROW_ID, true);
    } finally {
      logSpy.mockRestore();
    }
    expect(result.kind).toBe('already_completed');
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
  });
});

describe('replayDomainEvent — replay state', () => {
  it('displays state (event_type, status, attempts, aggregate_id, created_at, last_error presence) before any mutation', async () => {
    const { client } = makeFakeClient({
      rows: [makeRow({ status: 'failed', attempts: 2, last_error: 'boom' })],
      lifecycle: 'ready',
      intentCounts: [{ status: 'deferred', count: 4 }, { status: 'released', count: 1 }],
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      await replayDomainEvent(client, ROW_ID, true);
      printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
    }
    expect(printed).toContain('worker.ready');
    expect(printed).toContain('failed');
    expect(printed).toContain('2'); // attempts
    expect(printed).toContain(AGGREGATE_ID);
    expect(printed).toContain('2026-07-22T11:00:00.000Z');
    expect(printed).toMatch(/last_error.*true/i);
    expect(printed).toContain('ready');
    expect(printed).toContain('4');
    expect(printed).toContain('1');
  });

  it('rejects an unexpired lease as event_in_flight and mutates nothing', async () => {
    const future = new Date('2999-01-01T00:00:00.000Z').toISOString();
    const { client, calls } = makeFakeClient({
      rows: [makeRow({ status: 'processing', leased_until: future, lease_token: 'tok-1' })],
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let result;
    let printedErrors = '';
    try {
      result = await replayDomainEvent(client, ROW_ID, true, { now: () => new Date('2026-07-22T12:00:00.000Z') });
      printedErrors = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(result.kind).toBe('event_in_flight');
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
    expect(printedErrors).toMatch(/event_in_flight/);
  });

  it('replays an expired-lease processing event on --execute', async () => {
    const past = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const { client, calls } = makeFakeClient({
      rows: [makeRow({ status: 'processing', leased_until: past, lease_token: 'tok-1' })],
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let result;
    try {
      result = await replayDomainEvent(client, ROW_ID, true, { now: () => new Date('2026-07-22T12:00:00.000Z') });
    } finally {
      logSpy.mockRestore();
    }
    expect(result.kind).toBe('executed');
    const update = calls.find((c) => /UPDATE\s+worker_domain_outbox/i.test(c.text));
    expect(update).toBeDefined();
  });

  it('returns event_not_found for an id matching nothing', async () => {
    const { client } = makeFakeClient({ rows: [] });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let result;
    let printedErrors = '';
    try {
      result = await replayDomainEvent(client, 'zzzzzzzz-0000-0000-0000-000000000099', true);
      printedErrors = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      errorSpy.mockRestore();
    }
    expect(result.kind).toBe('not_found');
    expect(printedErrors).toMatch(/event_not_found/);
  });

  it('returns ambiguous_id when the identifier matches two different rows (one by id, one by event_key)', async () => {
    const rowA = makeRow({ id: ROW_ID, event_key: EVENT_KEY });
    const rowB = makeRow({ id: OTHER_ROW_ID, event_key: ROW_ID }); // rowB's event_key collides with rowA's id
    const { client, calls } = makeFakeClient({ rows: [rowA, rowB] });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let result;
    let printedErrors = '';
    try {
      result = await replayDomainEvent(client, ROW_ID, true);
      printedErrors = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      errorSpy.mockRestore();
    }
    expect(result.kind).toBe('ambiguous_id');
    expect(printedErrors).toMatch(/ambiguous_id/);
    const mutating = calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.text));
    expect(mutating).toHaveLength(0);
  });

  it('never prints the raw phone, OTP, message body, or db URL from the payload', async () => {
    const { client } = makeFakeClient({ rows: [makeRow({ status: 'pending' })] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let printed = '';
    try {
      await replayDomainEvent(client, ROW_ID, true);
      printed = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(printed).not.toContain(PHONE);
    expect(printed).not.toContain(BODY);
    expect(printed).not.toContain(OTP);
    expect(printed).not.toContain(DB_URL);
    // Redacted payload summary should mention key names + types only.
    expect(printed).toMatch(/phone/);
    expect(printed).toMatch(/string/);
  });
});
