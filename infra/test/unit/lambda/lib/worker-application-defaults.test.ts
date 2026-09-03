import {
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
});
