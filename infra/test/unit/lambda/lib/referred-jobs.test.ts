import {
  getReferredJobForOnboarding,
  listOpenReferredJobIds,
  recordReferredJob,
} from '../../../../lambda/lib/referred-jobs';

const WORKER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_JOB_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-01T12:00:00.000Z');

function makeClient() {
  const query = jest.fn();
  return { query, client: { query } as any };
}

/** The SQL with whitespace collapsed, so assertions read statements rather
 * than indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The not-applied predicate must bind the worker explicitly: the statement's
 * own caller predicate is what keeps another worker's application from
 * hiding (or revealing) a job. */
function expectNotAppliedByThisWorker(sql: string): void {
  expect(sql).toContain(
    'NOT EXISTS ( SELECT 1 FROM job_applications ja WHERE ja.job_id = r.job_id AND ja.worker_id = $1 )',
  );
}

describe('recordReferredJob', () => {
  it('upserts only an existing active job, binding worker, job, source and time in order', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(recordReferredJob(client, {
      workerId: WORKER_ID, jobId: JOB_ID, source: 'job_page', now: NOW,
    })).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    const text = flat(sql);
    expect(text).toMatch(
      /^INSERT INTO worker_referred_jobs \(worker_id, job_id, source, first_seen_at, last_seen_at\) SELECT \$1::uuid, j\.id, \$3::text, \$4::timestamptz, \$4::timestamptz FROM jobs j WHERE j\.id = \$2 AND j\.status = 'active' ON CONFLICT/,
    );
    expect(params).toEqual([WORKER_ID, JOB_ID, 'job_page', NOW.toISOString()]);
  });

  it('refreshes last_seen_at and source on a re-record and never touches first_seen_at', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await recordReferredJob(client, { workerId: WORKER_ID, jobId: JOB_ID, source: 'share_link', now: NOW });

    const text = flat(query.mock.calls[0][0]);
    const doUpdate = text.slice(text.indexOf('ON CONFLICT'));
    expect(doUpdate).toBe(
      'ON CONFLICT (worker_id, job_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, source = EXCLUDED.source',
    );
    expect(doUpdate).not.toContain('first_seen_at');
  });

  it('returns false when no active job matched -- an unknown, paused or closed job writes nothing', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(recordReferredJob(client, {
      workerId: WORKER_ID, jobId: JOB_ID, source: 'typed_code', now: NOW,
    })).resolves.toBe(false);
  });

  it('defaults the timestamp to now', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const { query, client } = makeClient();
      query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await recordReferredJob(client, { workerId: WORKER_ID, jobId: JOB_ID, source: 'whatsapp_token' });

      expect(query.mock.calls[0][1]).toEqual([WORKER_ID, JOB_ID, 'whatsapp_token', NOW.toISOString()]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a database error reach the caller, which owns the transaction and any savepoint', async () => {
    const { query, client } = makeClient();
    query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42501' }));

    await expect(recordReferredJob(client, {
      workerId: WORKER_ID, jobId: JOB_ID, source: 'job_page', now: NOW,
    })).rejects.toThrow('boom');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('listOpenReferredJobIds', () => {
  it('returns the open, unapplied referred job ids for this worker only, newest first', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ job_id: OTHER_JOB_ID }, { job_id: JOB_ID }] });

    await expect(listOpenReferredJobIds(client, WORKER_ID, { limit: 5 }))
      .resolves.toEqual([OTHER_JOB_ID, JOB_ID]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    const text = flat(sql);
    expect(text).toMatch(/^SELECT r\.job_id FROM worker_referred_jobs r JOIN jobs j ON j\.id = r\.job_id WHERE/);
    expect(text).toContain('r.worker_id = $1');
    expect(text).toContain("j.status = 'active'");
    expectNotAppliedByThisWorker(text);
    // Deterministic on a last_seen_at tie.
    expect(text).toContain('ORDER BY r.last_seen_at DESC, r.job_id LIMIT $2');
    expect(params).toEqual([WORKER_ID, 5]);
  });

  it('binds a NULL limit -- no cap -- when no limit is given', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    await expect(listOpenReferredJobIds(client, WORKER_ID)).resolves.toEqual([]);
    expect(query.mock.calls[0][1]).toEqual([WORKER_ID, null]);
  });
});

describe('getReferredJobForOnboarding', () => {
  const ROW = {
    id: JOB_ID,
    title: 'Concrete Finisher',
    company: 'NB Construction',
    location: 'El Paso, TX',
    pay_min: 22,
    pay_max: 26,
    pay_interval: 'hourly',
    pay_raw: '$22-$26/hour',
    open: true,
  };

  it("reads this worker's newest unapplied referred job, open ones first, as one row", async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [ROW] });

    await getReferredJobForOnboarding(client, WORKER_ID);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    const text = flat(sql);
    expect(text).toContain(
      "SELECT j.id, j.title, COALESCE(j.company, 'Jale') AS company, j.location, j.pay_min, j.pay_max, "
      + "j.pay_interval, j.pay AS pay_raw, (j.status = 'active') AS open "
      + 'FROM worker_referred_jobs r JOIN jobs j ON j.id = r.job_id',
    );
    expect(text).toContain('r.worker_id = $1');
    expectNotAppliedByThisWorker(text);
    // A closed job is still shown (the Done screen's closed state), so status
    // is a sort key here, not a filter.
    const where = text.slice(text.indexOf(' WHERE '), text.indexOf(' ORDER BY '));
    expect(where).not.toContain('status');
    expect(text).toContain("ORDER BY (j.status = 'active') DESC, r.last_seen_at DESC, r.job_id LIMIT 1");
    // SECURITY DEFINER with a transaction-wide side effect, and jale_whatsapp
    // holds no employer_profiles grant.
    expect(text).not.toContain('employer_display_name');
    expect(text).not.toMatch(/SELECT \*/);
    expect(params).toEqual([WORKER_ID]);
  });

  it('maps the row to the camelCase summary', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [ROW] });

    await expect(getReferredJobForOnboarding(client, WORKER_ID)).resolves.toEqual({
      id: JOB_ID,
      title: 'Concrete Finisher',
      company: 'NB Construction',
      location: 'El Paso, TX',
      payMin: 22,
      payMax: 26,
      payInterval: 'hourly',
      payRaw: '$22-$26/hour',
      open: true,
    });
  });

  it('keeps a closed job and missing pay as they are', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({
      rows: [{ ...ROW, pay_min: null, pay_max: null, pay_interval: null, pay_raw: null, open: false }],
    });

    await expect(getReferredJobForOnboarding(client, WORKER_ID)).resolves.toMatchObject({
      payMin: null, payMax: null, payInterval: null, payRaw: null, open: false,
    });
  });

  it('returns null when the worker has no unapplied referred job', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    await expect(getReferredJobForOnboarding(client, WORKER_ID)).resolves.toBeNull();
  });
});

describe('isolation is the caller\'s', () => {
  it('no statement opens a savepoint or a transaction', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await recordReferredJob(client, { workerId: WORKER_ID, jobId: JOB_ID, source: 'job_page', now: NOW });
    await listOpenReferredJobIds(client, WORKER_ID, { limit: 3 });
    await getReferredJobForOnboarding(client, WORKER_ID);

    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/SAVEPOINT|BEGIN|COMMIT|ROLLBACK/i);
    }
  });
});
