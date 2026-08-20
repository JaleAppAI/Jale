import { upsertWorkerApplicationDefaults } from '../../../../lambda/lib/worker-application-defaults';

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
