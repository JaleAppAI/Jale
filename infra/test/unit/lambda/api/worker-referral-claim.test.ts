import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-referral-claim';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
    body: JSON.stringify({ shareCode: 'ABCDEFGH' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

/** A job page's id and a share link's job, both real UUIDs (the link's comes
 * back from the database in canonical lowercase). */
const PAGE_JOB = '0b8d2a3c-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const LINK_JOB = '1c9e3b4d-5f60-4b7c-8d8e-9fa0b1c2d3e4';

describe('worker-referral-claim', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockResolvedValue({});
  });
  afterAll(() => { process.env = env; });

  type LinkRow = { job_id: string; channel: string; referrer_worker_id: string | null; referrer_employer_id?: string | null };

  /** Routes by SQL substring. `activeJobs` are the jobs recordReferredJob's
   * INSERT ... SELECT finds active (anything else is a zero-row record). */
  function mockHappyPath(linkRow: LinkRow | null, activeJobs: string[] = linkRow ? [linkRow.job_id] : []) {
    mockQuery.mockImplementation((q: string, params?: unknown[]) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) {
        return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      }
      if (q.includes('jale_cap.resolve_share_link')) {
        return Promise.resolve({ rows: linkRow ? [linkRow] : [] });
      }
      if (q.includes('INSERT INTO worker_attribution')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (q.includes('INSERT INTO worker_referred_jobs')) {
        return Promise.resolve({ rowCount: activeJobs.includes(String(params?.[1])) ? 1 : 0 });
      }
      return Promise.resolve({});
    });
  }

  /** Every recordReferredJob statement, as [workerId, jobId, source]. */
  function referredJobRecords(): Array<[unknown, unknown, unknown]> {
    return mockQuery.mock.calls
      .filter(([q]) => typeof q === 'string' && q.includes('INSERT INTO worker_referred_jobs'))
      .map(([, params]) => [params[0], params[1], params[2]]);
  }

  function queriesMatching(fragment: string): number {
    return mockQuery.mock.calls.filter(([q]) => typeof q === 'string' && q.includes(fragment)).length;
  }

  function callOrder(fragment: string): number {
    const index = mockQuery.mock.calls.findIndex(([q]) => typeof q === 'string' && q.includes(fragment));
    expect(index).toBeGreaterThanOrEqual(0);
    return mockQuery.mock.invocationCallOrder[index];
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: {} as any }));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_json for malformed body', async () => {
    const res = await handler(makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_json for a body that is valid JSON but not an object -- null was a 500', async () => {
    for (const body of ['null', '[]', '"ABCDEFGH"', '42', 'true']) {
      const res = await handler(makeEvent({ body }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    }
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_request, before any DB access, when neither field is usable', async () => {
    for (const body of [
      {},
      { shareCode: 12345678 },
      { shareCode: '!!!' },
      { jobId: 'not-a-uuid' },
      { jobId: 42 },
      { jobId: `${PAGE_JOB} ` },
      { jobId: 'not-a-uuid', shareCode: '!!!' },
    ]) {
      const res = await handler(makeEvent({ body: JSON.stringify(body) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_request' });
    }
    // A missing body is the empty object.
    const missing = await handler(makeEvent({ body: null }));
    expect(JSON.parse(missing.body)).toEqual({ error: 'invalid_request' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('{ jobId } alone records the job page and never touches attribution', async () => {
    mockHappyPath(null, [PAGE_JOB]);
    const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false, recorded: [PAGE_JOB] });
    expect(referredJobRecords()).toEqual([['worker-id', PAGE_JOB, 'job_page']]);
    expect(queriesMatching('resolve_share_link')).toBe(0);
    expect(queriesMatching('worker_attribution')).toBe(0);
  });

  it('{ shareCode } credits first touch unchanged, then records the link\'s job as share_link', async () => {
    mockHappyPath({ job_id: LINK_JOB, channel: 'whatsapp', referrer_worker_id: 'referrer-1', referrer_employer_id: null });
    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: 'ABCDEFGH' }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: true, recorded: [LINK_JOB] });
    expect(referredJobRecords()).toEqual([['worker-id', LINK_JOB, 'share_link']]);
    expect(callOrder('INSERT INTO worker_attribution')).toBeLessThan(callOrder('INSERT INTO worker_referred_jobs'));
  });

  it('resolves the share code only through jale_cap.resolve_share_link, never by reading job_share_links', async () => {
    mockHappyPath({ job_id: LINK_JOB, channel: 'whatsapp', referrer_worker_id: 'referrer-1', referrer_employer_id: null });
    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: 'ABCDEFGH' }) }));
    expect(res.statusCode).toBe(200);
    const resolutions = mockQuery.mock.calls.filter(([q]) => typeof q === 'string' && q.includes('jale_cap.resolve_share_link'));
    expect(resolutions.length).toBeGreaterThan(0);
    for (const [q, params] of resolutions) {
      expect(q).toMatch(/FROM jale_cap\.resolve_share_link\(\$1\)/);
      expect(params).toEqual(['ABCDEFGH']);
    }
    expect(mockQuery.mock.calls.some(([q]) => typeof q === 'string' && /\bjob_share_links\b/.test(q))).toBe(false);
  });

  it('both fields: the job page is recorded first, so a shared job ends as share_link', async () => {
    mockHappyPath(
      { job_id: LINK_JOB, channel: 'sms', referrer_worker_id: 'referrer-1', referrer_employer_id: null },
      [PAGE_JOB, LINK_JOB],
    );
    const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: 'ABCDEFGH' }) }));
    expect(JSON.parse(res.body)).toEqual({ claimed: true, recorded: [PAGE_JOB, LINK_JOB] });
    expect(referredJobRecords()).toEqual([
      ['worker-id', PAGE_JOB, 'job_page'],
      ['worker-id', LINK_JOB, 'share_link'],
    ]);
  });

  it('both fields naming the same job record it twice but list it once -- an upper-case id included', async () => {
    mockHappyPath({ job_id: PAGE_JOB, channel: 'copy_link', referrer_worker_id: null, referrer_employer_id: null });
    const res = await handler(makeEvent({
      body: JSON.stringify({ jobId: PAGE_JOB.toUpperCase(), shareCode: 'ABCDEFGH' }),
    }));
    expect(JSON.parse(res.body)).toEqual({ claimed: true, recorded: [PAGE_JOB] });
    expect(referredJobRecords()).toEqual([
      ['worker-id', PAGE_JOB, 'job_page'],
      ['worker-id', PAGE_JOB, 'share_link'],
    ]);
  });

  it('an unusable shareCode beside a usable jobId still records the job, without an attribution attempt', async () => {
    mockHappyPath(null, [PAGE_JOB]);
    const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: '!!!' }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false, recorded: [PAGE_JOB] });
    expect(queriesMatching('resolve_share_link')).toBe(0);
  });

  it('an unknown or inactive job is a 200 with recorded: [] -- never a 404, no oracle', async () => {
    mockHappyPath(null, []);
    const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false, recorded: [] });
    expect(referredJobRecords()).toEqual([['worker-id', PAGE_JOB, 'job_page']]);
  });

  it('sets the RLS context before any write, and the user lookup comes before the record', async () => {
    mockHappyPath({ job_id: LINK_JOB, channel: 'facebook', referrer_worker_id: null, referrer_employer_id: null }, [PAGE_JOB, LINK_JOB]);
    await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: 'ABCDEFGH' }) }));
    const rls = mockSetRlsContext.mock.invocationCallOrder[0];
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'w-sub');
    expect(rls).toBeLessThan(callOrder('SELECT id, user_type FROM users'));
    expect(callOrder('SELECT id, user_type FROM users')).toBeLessThan(callOrder('INSERT INTO worker_referred_jobs'));
    expect(rls).toBeLessThan(callOrder('INSERT INTO worker_attribution'));
  });

  it('an employer or an unprovisioned caller records nothing (403 / 409 unchanged)', async () => {
    for (const rows of [[{ id: 'employer-id', user_type: 'employer' }], []]) {
      mockQuery.mockReset();
      mockQuery.mockImplementation((q: string) => {
        if (typeof q === 'string' && q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: 'ABCDEFGH' }) }));
      expect(res.statusCode).toBe(rows.length ? 403 : 409);
      expect(referredJobRecords()).toEqual([]);
      expect(queriesMatching('resolve_share_link')).toBe(0);
    }
  });

  it('a failed record is a 500 that rolls back, and logs neither the job id nor the code', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('INSERT INTO worker_referred_jobs')) return Promise.reject(new Error('relation "worker_referred_jobs" does not exist'));
      return Promise.resolve({});
    });
    const res = await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: 'QRSTVWXY' }) }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.flat().map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
    expect(logged).not.toContain(PAGE_JOB);
    expect(logged).not.toContain('QRSTVWXY');
    consoleErrorSpy.mockRestore();
  });

  it('does NOT gate on ToS compliance -- a fresh post-OTP signup with no tos_version can claim', async () => {
    // Review finding: this endpoint fires seconds after OTP, BEFORE the legal
    // wall has ever been shown; a compliance gate here 403'd every brand-new
    // signup and silently lost the referral. The gate was removed on purpose;
    // this test pins that checkCompliance is never even consulted.
    mockHappyPath({ job_id: 'job-1', channel: 'copy_link', referrer_worker_id: 'referrer-1', referrer_employer_id: null });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: true, recorded: ['job-1'] });
    expect(mockCheckCompliance).not.toHaveBeenCalled();
  });

  it('returns 409 user_not_provisioned when no users row exists for the sub', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q === 'string' && q.includes('SELECT id, user_type FROM users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
  });

  it('returns 403 worker_only when the caller is an employer', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'worker_only' });
  });

  it('happy path: setRlsContext is called with the caller sub before the attribution write, returns { claimed: true, recorded }', async () => {
    mockHappyPath({ job_id: 'job-1', channel: 'whatsapp', referrer_worker_id: 'referrer-1', referrer_employer_id: null });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: true, recorded: ['job-1'] });

    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'w-sub');

    // Jest's invocationCallOrder is a single global counter shared across all
    // mocks, so comparing setRlsContext's order against the INSERT's order
    // directly proves the RLS context was set before the attribution write.
    const rlsCallOrder = mockSetRlsContext.mock.invocationCallOrder[0];
    const insertCallIndex = mockQuery.mock.calls.findIndex(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO worker_attribution'),
    );
    expect(insertCallIndex).toBeGreaterThanOrEqual(0);
    const insertCallOrder = mockQuery.mock.invocationCallOrder[insertCallIndex];
    expect(rlsCallOrder).toBeLessThan(insertCallOrder);
  });

  it('returns { claimed: false, recorded: [] } with a 200 status for an unknown or revoked share code -- not an error', async () => {
    mockHappyPath(null);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false, recorded: [] });
    expect(referredJobRecords()).toEqual([]);
  });

  it('never logs the share code or a job id in any log line', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockHappyPath({ job_id: LINK_JOB, channel: 'facebook', referrer_worker_id: 'referrer-1', referrer_employer_id: null }, [PAGE_JOB, LINK_JOB]);
    await handler(makeEvent({ body: JSON.stringify({ jobId: PAGE_JOB, shareCode: 'ABCDEFGH' }) }));

    const allLoggedText = [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    expect(allLoggedText).not.toContain('ABCDEFGH');
    expect(allLoggedText).not.toContain(PAGE_JOB);
    expect(allLoggedText).not.toContain(LINK_JOB);

    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('never logs the share code even when the write changes no row (rowCount 0) -- and the job is still recorded', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('jale_cap.resolve_share_link')) {
        return Promise.resolve({ rows: [{ job_id: LINK_JOB, channel: 'sms', referrer_worker_id: 'referrer-1', referrer_employer_id: null }] });
      }
      if (q.includes('INSERT INTO worker_attribution')) return Promise.resolve({ rowCount: 0 });
      if (q.includes('INSERT INTO worker_referred_jobs')) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: 'ZYXWVTS9' }) }));
    expect(res.statusCode).toBe(200);
    // The referred-jobs list is not the referral credit: an already-credited
    // (or filtered) worker still gets the shared job recorded.
    expect(JSON.parse(res.body)).toEqual({ claimed: false, recorded: [LINK_JOB] });

    const loggedText = consoleErrorSpy.mock.calls
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    expect(loggedText).not.toContain('ZYXWVTS9');
    expect(loggedText).not.toContain(LINK_JOB);
    expect(loggedText).toContain('WebAttributionNotPersisted');

    consoleErrorSpy.mockRestore();
  });
});
