import {
  filterReusableDefaults,
  loadWorkerApplicationDefaults,
  upsertWorkerApplicationDefaults,
} from '../../../../lambda/lib/worker-application-defaults';

const makeClient = (query: jest.Mock) => ({ query }) as any;

describe('upsertWorkerApplicationDefaults', () => {
  it('issues an INSERT ... ON CONFLICT DO UPDATE with jsonb merge semantics, never a replace', async () => {
    const query = jest.fn().mockResolvedValue({});
    await upsertWorkerApplicationDefaults(makeClient(query), 'worker-1', { work_authorization: true });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO worker_application_defaults');
    expect(sql).toContain('ON CONFLICT (worker_id) DO UPDATE');
    // The merge operator, not an overwrite -- an existing key not present
    // in this write's `answers` must survive untouched.
    expect(sql).toContain('worker_application_defaults.answers || EXCLUDED.answers');
    expect(sql).not.toMatch(/SET\s+answers\s*=\s*EXCLUDED\.answers\s*,/);
    expect(sql).toContain('updated_at = now()');
    expect(params).toEqual(['worker-1', JSON.stringify({ work_authorization: true })]);
  });

  // L3 defence in depth: even if a caller forgets to filter, this table can
  // never accumulate a per_application answer -- the incident's mechanism 2
  // (`mergeFieldAnswers` wrote back EVERY answered field of EVERY
  // application) had exactly one guard, and it was in the caller.
  it('drops per_application keys before writing, keeping only the stable ones', async () => {
    const query = jest.fn().mockResolvedValue({});
    await upsertWorkerApplicationDefaults(makeClient(query), 'worker-1', {
      work_authorization: true,
      home_address: { street: '1 Main St' },
      worked_here_before: true,
      date_available: '2026-09-10',
      desired_pay: { amount: 25, interval: 'hourly' },
      emergency_contact: { name: 'Maria Lopez', phone: '5551234567' },
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(query.mock.calls[0][1][1]))).toEqual({
      work_authorization: true,
      home_address: { street: '1 Main St' },
    });
  });

  it('issues NO query at all when every key is per_application (no pointless {} merge)', async () => {
    const query = jest.fn().mockResolvedValue({});
    await upsertWorkerApplicationDefaults(makeClient(query), 'worker-1', {
      worked_here_before: false,
      date_available: '2026-09-10',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('drops the reserved certifications key itself, instead of trusting the caller to strip it', async () => {
    const query = jest.fn().mockResolvedValue({});
    await upsertWorkerApplicationDefaults(makeClient(query), 'worker-1', {
      certifications: [{ name: 'OSHA 10' }],
      education: { level: 'high_school' },
    });
    expect(JSON.parse(String(query.mock.calls[0][1][1]))).toEqual({ education: { level: 'high_school' } });
  });

  it('propagates a query failure rather than swallowing it (caller must roll back)', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      upsertWorkerApplicationDefaults(makeClient(query), 'worker-1', { work_authorization: true }),
    ).rejects.toThrow('db down');
  });
});

describe('loadWorkerApplicationDefaults', () => {
  it('reads the single row keyed on worker_id and returns its answers object', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ answers: { work_authorization: true } }] });
    const answers = await loadWorkerApplicationDefaults(makeClient(query), 'worker-1');

    expect(answers).toEqual({ work_authorization: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SELECT answers FROM worker_application_defaults WHERE worker_id = $1');
    expect(params).toEqual(['worker-1']);
  });

  it('returns an empty object when the worker has no defaults row yet (first application)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await loadWorkerApplicationDefaults(makeClient(query), 'worker-1')).toEqual({});
  });

  it('returns an empty object for a row whose answers column is NULL', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ answers: null }] });
    expect(await loadWorkerApplicationDefaults(makeClient(query), 'worker-1')).toEqual({});
  });

  it('does not set the RLS GUC itself -- the caller owns that (worker_application_defaults is FORCE RLS)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await loadWorkerApplicationDefaults(makeClient(query), 'worker-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).not.toContain('set_config');
  });

  // Deliberately UNFILTERED on read: a legacy row written before the policy
  // existed still holds per_application keys, and `seedAnswersFromDefaults`
  // is the place that refuses them -- with a `seed_skipped/per_application`
  // log line. Filtering here would silently erase that signal.
  it('returns per_application keys a legacy row still holds, so the seed can log its refusal', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ answers: { work_authorization: true, worked_here_before: true } }],
    });
    expect(await loadWorkerApplicationDefaults(makeClient(query), 'worker-1')).toEqual({
      work_authorization: true,
      worked_here_before: true,
    });
  });
});

// ── L3 ──────────────────────────────────────────────────────────────────
describe('filterReusableDefaults', () => {
  it('keeps stable keys and drops per_application ones', () => {
    expect(filterReusableDefaults({
      work_authorization: true,
      date_of_birth: '1990-04-03',
      education: { level: 'ged' },
      military_service: false,
      work_history: [{ company: 'ABC' }],
      references: [{ name: 'Juan' }],
      home_address: { street: '1 Main St' },
      date_available: '2026-09-10',
      desired_pay: { amount: 25 },
      worked_here_before: true,
      emergency_contact: { name: 'Maria' },
    })).toEqual({
      work_authorization: true,
      date_of_birth: '1990-04-03',
      education: { level: 'ged' },
      military_service: false,
      work_history: [{ company: 'ABC' }],
      references: [{ name: 'Juan' }],
      home_address: { street: '1 Main St' },
    });
  });

  it('keeps a falsy stable answer -- a stored false/null is an ANSWER, not an absence', () => {
    expect(filterReusableDefaults({ military_service: false, work_authorization: null })).toEqual({
      military_service: false,
      work_authorization: null,
    });
  });

  it('drops unknown, reserved and prototype-shaped keys without polluting Object.prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": 1, "toString": 2, "ssn": "x", "certifications": [], "education": {"level": "ged"}}',
    );
    expect(filterReusableDefaults(hostile)).toEqual({ education: { level: 'ged' } });
    expect(({} as any).polluted).toBeUndefined();
  });

  it('tolerates a null/undefined answers column (a row whose answers is NULL)', () => {
    expect(filterReusableDefaults(null as any)).toEqual({});
    expect(filterReusableDefaults(undefined as any)).toEqual({});
  });
});
