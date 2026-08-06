import { writeAttribution, writeWebAttribution } from '../../../../lambda/lib/referral-attribution';

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const WORKER_REFERRER_ID = 'cccccccc-0000-0000-0000-000000000001';
const EMPLOYER_REFERRER_ID = 'dddddddd-0000-0000-0000-000000000001';
const SHARE_CODE = 'SHARECOD';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function makeClient() {
  const query = jest.fn();
  return { query, client: { query } as any };
}

describe('writeAttribution', () => {
  it('populates first_referrer_employer_id (and leaves the worker referrer null) for an employer-sourced touch', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await writeAttribution(
      client,
      WORKER_ID,
      {
        jobId: JOB_ID,
        channel: 'copy_link',
        shareCode: SHARE_CODE,
        referrerWorkerId: null,
        referrerEmployerId: EMPLOYER_REFERRER_ID,
      },
      NOW,
      'TestMetric',
    );

    expect(result).toEqual({ written: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/first_referrer_worker_id/);
    expect(sql).toMatch(/first_referrer_employer_id/);
    expect(sql).toMatch(/latest_referrer_worker_id/);
    expect(sql).toMatch(/latest_referrer_employer_id/);
    // params: [worker_id, share_code, channel, job_id, referrer_worker_id, referrer_employer_id, now]
    expect(params).toEqual([WORKER_ID, SHARE_CODE, 'copy_link', JOB_ID, null, EMPLOYER_REFERRER_ID, NOW.toISOString()]);
  });

  it('populates first_referrer_worker_id (and leaves the employer referrer null) for a worker-sourced touch, preserving lane symmetry', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 1 });

    await writeAttribution(
      client,
      WORKER_ID,
      {
        jobId: JOB_ID,
        channel: 'whatsapp',
        shareCode: SHARE_CODE,
        referrerWorkerId: WORKER_REFERRER_ID,
        referrerEmployerId: null,
      },
      NOW,
      'TestMetric',
    );

    const [, params] = query.mock.calls[0];
    expect(params).toEqual([WORKER_ID, SHARE_CODE, 'whatsapp', JOB_ID, WORKER_REFERRER_ID, null, NOW.toISOString()]);
  });

  it('the DO UPDATE SET list never mentions any first_* column, for either referrer kind', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 1 });

    await writeAttribution(
      client,
      WORKER_ID,
      {
        jobId: JOB_ID,
        channel: 'facebook',
        shareCode: SHARE_CODE,
        referrerWorkerId: null,
        referrerEmployerId: EMPLOYER_REFERRER_ID,
      },
      NOW,
      'TestMetric',
    );

    const [sql] = query.mock.calls[0];
    const setClauseMatch = sql.match(/DO UPDATE\s+SET([\s\S]*)$/);
    expect(setClauseMatch).not.toBeNull();
    const setClause = setClauseMatch![1];
    expect(setClause).not.toMatch(/first_share_code/);
    expect(setClause).not.toMatch(/first_channel/);
    expect(setClause).not.toMatch(/first_job_id/);
    expect(setClause).not.toMatch(/first_referrer_worker_id/);
    expect(setClause).not.toMatch(/first_referrer_employer_id/);
    expect(setClause).not.toMatch(/first_seen_at/);
    expect(setClause).toMatch(/latest_referrer_employer_id\s*=\s*EXCLUDED\.latest_referrer_employer_id/);
  });

  it('logs the metric and reports written:false on a silently RLS-filtered zero-row write', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 0 });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await writeAttribution(
      client,
      WORKER_ID,
      {
        jobId: JOB_ID,
        channel: 'sms',
        shareCode: SHARE_CODE,
        referrerWorkerId: null,
        referrerEmployerId: EMPLOYER_REFERRER_ID,
      },
      NOW,
      'EmployerAttributionNotPersisted',
    );

    expect(result).toEqual({ written: false });
    expect(consoleErrorSpy).toHaveBeenCalledWith(JSON.stringify({ metric: 'EmployerAttributionNotPersisted', workerId: WORKER_ID }));
    consoleErrorSpy.mockRestore();
  });
});

describe('writeWebAttribution -- employer-link attribution', () => {
  function mockLinkAndUpsert(
    link: { job_id: string; channel: string; referrer_worker_id: string | null; referrer_employer_id: string | null } | null,
    upsertRowCount = 1,
  ) {
    const { query, client } = makeClient();
    query.mockImplementation((sql: string) => {
      if (typeof sql !== 'string') return Promise.resolve({});
      if (sql.includes('FROM job_share_links')) {
        return Promise.resolve({ rows: link ? [link] : [] });
      }
      if (sql.includes('INSERT INTO worker_attribution')) {
        return Promise.resolve({ rowCount: upsertRowCount });
      }
      return Promise.resolve({});
    });
    return { query, client };
  }

  it('resolves referrer_employer_id from the link and writes it as both first_* and latest_* on first touch', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'facebook',
      referrer_worker_id: null,
      referrer_employer_id: EMPLOYER_REFERRER_ID,
    });

    const result = await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);

    expect(result).toEqual({ written: true });
    const linkCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('FROM job_share_links'));
    expect(linkCall![0]).toMatch(/SELECT job_id, channel, referrer_worker_id, referrer_employer_id/);

    const attributionCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'));
    expect(attributionCall).toBeDefined();
    // [worker_id, share_code, channel, job_id, referrer_worker_id, referrer_employer_id, now]
    expect(attributionCall![1]).toEqual([WORKER_ID, SHARE_CODE, 'facebook', JOB_ID, null, EMPLOYER_REFERRER_ID, NOW.toISOString()]);
  });

  it('a second, later claim moves latest_referrer_employer_id via the same shared upsert (first_* stays immutable at the DB layer)', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'copy_link',
      referrer_worker_id: null,
      referrer_employer_id: EMPLOYER_REFERRER_ID,
    });
    const later = new Date(NOW.getTime() + 1000);

    await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);
    await writeWebAttribution(client, WORKER_ID, SHARE_CODE, later);

    const attributionCalls = query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'));
    expect(attributionCalls).toHaveLength(2);
    expect(attributionCalls[1][1]).toEqual([WORKER_ID, SHARE_CODE, 'copy_link', JOB_ID, null, EMPLOYER_REFERRER_ID, later.toISOString()]);
  });

  it('a worker-referred link leaves referrer_employer_id null in the write -- worker and employer referrer fields never both populate', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'whatsapp',
      referrer_worker_id: WORKER_REFERRER_ID,
      referrer_employer_id: null,
    });

    await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);

    const attributionCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'));
    expect(attributionCall![1]).toEqual([WORKER_ID, SHARE_CODE, 'whatsapp', JOB_ID, WORKER_REFERRER_ID, null, NOW.toISOString()]);
  });

  it('an organic link (both referrer fields null) writes both as null -- no fabricated referrer of either kind', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'device_share',
      referrer_worker_id: null,
      referrer_employer_id: null,
    });

    await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);

    const attributionCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'));
    expect(attributionCall![1]).toEqual([WORKER_ID, SHARE_CODE, 'device_share', JOB_ID, null, null, NOW.toISOString()]);
  });

  it('self-referral-style guard: an employer-link referrer_employer_id equal to the claiming id skips credit -- no attribution write at all', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'sms',
      referrer_worker_id: null,
      referrer_employer_id: WORKER_ID,
    });

    const result = await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);

    expect(result).toEqual({ written: false });
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'))).toBe(false);
  });

  it('the existing worker self-referral guard is unaffected: referrer_worker_id equal to the claiming worker still skips credit', async () => {
    const { query, client } = mockLinkAndUpsert({
      job_id: JOB_ID,
      channel: 'sms',
      referrer_worker_id: WORKER_ID,
      referrer_employer_id: null,
    });

    const result = await writeWebAttribution(client, WORKER_ID, SHARE_CODE, NOW);

    expect(result).toEqual({ written: false });
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_attribution'))).toBe(false);
  });
});
