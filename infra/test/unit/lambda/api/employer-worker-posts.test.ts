import type { APIGatewayProxyEvent } from 'aws-lambda';
import { MEDIA_LINK_TTL_SECONDS, handler } from '../../../../lambda/api/employer-worker-posts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import {
  callerFor, expectAttemptAfter, expectRecordedInsideTransaction, queryOrder, withRequestId,
} from './audit-expectations';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example/get'),
}));

const mockGetObjectCommand = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input) => {
    mockGetObjectCommand(input);
    return { input };
  }),
}));

import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FOREMAN_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const actorResult = (userId: string, scopeUserIds: string[] = [userId]) => ({
  ok: true as const,
  actor: { userId, organizationId: ORG_ID, role: 'owner' as const, scopeUserIds },
});

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const WORKER_ID = '44444444-4444-4444-8444-444444444444';
const EMPLOYER_ID = '55555555-5555-4555-8555-555555555555';

const makeEvent = (worker_id = WORKER_ID, queryStringParameters?: Record<string, string>) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { worker_id },
  queryStringParameters,
} as unknown as APIGatewayProxyEvent);

const POST_A = { id: 'p1', caption: 'ok', source: 'web', created_at: '2026-08-22T01:00:00Z' };

describe('employer-worker-posts Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.MEDIA_BUCKET = 'jale-worker-media-test';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    });
    (setRlsContext as jest.Mock).mockResolvedValue(undefined);
    (setInternalUserRlsContext as jest.Mock).mockResolvedValue(undefined);
    (checkCompliance as jest.Mock).mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(actorResult(EMPLOYER_ID));
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
      if (text.includes('FROM worker_posts')) return { rows: [POST_A] };
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM worker_post_media')) {
        return { rows: [
          { id: 'm1', post_id: 'p1', s3_key: 'k1', s3_version_id: 'v1', sort_order: 0, moderation_status: 'approved' },
        ] };
      }
      return { rows: [] };
    });
  });

  it('rejects an invalid worker_id', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 without an application relationship', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
      if (text.includes('FROM job_applications')) return { rows: [] };
      return { rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('resolves the caller as the employer (which binds the internal id), and never binds the worker id itself', async () => {
    await handler(makeEvent());
    expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'employer-sub');
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('returns published posts with approved media only, excluding all-flagged posts via SQL', async () => {
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].id).toBe('p1');

    const postsSql = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM worker_posts'))?.[0];
    expect(postsSql).toContain('EXISTS');
    expect(postsSql).toContain(`moderation_status = 'approved'`);

    const mediaSql = mockQuery.mock.calls.find(([sql]) => String(sql).includes('ORDER BY sort_order'))?.[0];
    expect(mediaSql).toContain(`moderation_status = 'approved'`);
  });

  it('the posts read names the caller itself: the worker must have applied to one of this employer\'s jobs', async () => {
    await handler(makeEvent());
    const postsCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM worker_posts'));
    expect(postsCall).toBeDefined();
    const [postsSql, postsParams] = postsCall as [string, unknown[]];
    expect(postsSql).toMatch(
      /AND EXISTS \(SELECT 1\s+FROM job_applications ja\s+JOIN jobs j ON j\.id = ja\.job_id\s+WHERE ja\.worker_id = p\.worker_id\s+AND j\.employer_id = ANY\(\$5::uuid\[\]\)\)/,
    );
    expect(postsParams).toEqual([WORKER_ID, null, null, 24, [EMPLOYER_ID]]);
  });

  it('pins the presigned GET to the media s3_version_id', async () => {
    await handler(makeEvent());
    expect(mockGetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'jale-worker-media-test', Key: 'k1', VersionId: 'v1' }),
    );
  });

  it('skips the media query when there are zero posts', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
      if (text.includes('FROM worker_posts')) return { rows: [] };
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.posts).toEqual([]);
    // The posts query itself references worker_post_media inside its EXISTS
    // clause, so match on the media query's distinguishing ORDER BY instead.
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('ORDER BY sort_order'))).toBe(false);
  });

  it('paginates with a composite keyset cursor computed from the unfiltered page', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
      if (text.includes('FROM worker_posts')) return { rows: [POST_A] };
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM worker_post_media')) {
        return { rows: [
          { id: 'm1', post_id: 'p1', s3_key: 'k1', s3_version_id: 'v1', sort_order: 0, moderation_status: 'approved' },
        ] };
      }
      return { rows: [] };
    });
    const res = await handler(makeEvent(WORKER_ID, { limit: '1' }));
    const body = JSON.parse(res.body);
    expect(body.next_before).toBe(POST_A.created_at);
    expect(body.next_before_id).toBe(POST_A.id);
  });

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const employer = callerFor('employer', EMPLOYER_ID);
    const client = expect.objectContaining({ query: mockQuery });
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
      (getSignedUrl as jest.Mock).mockResolvedValue('https://s3.example/get');
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    });
    afterEach(() => nowSpy.mockRestore());

    it('records the posts it returns before COMMIT, with the media link expiry', async () => {
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      const { posts } = JSON.parse(res.body);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.worker_posts',
        subjectUserIds: [WORKER_ID],
        recordIds: ['p1'],
        resultCount: 1,
        fieldNames: Object.keys(posts[0]).sort(),
        linkExpiresAt: new Date(now + MEDIA_LINK_TTL_SECONDS * 1000),
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /FROM worker_post_media/);
      expect(MEDIA_LINK_TTL_SECONDS).toBe(900);
      expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: MEDIA_LINK_TTL_SECONDS });
      expect((getSignedUrl as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(queryOrder(mockQuery, 'COMMIT'));
    });

    it('states no link expiry when there is nothing to sign', async () => {
      mockQuery.mockImplementation((sql: string) => {
        const text = String(sql);
        if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
        if (text.includes('FROM worker_posts')) return { rows: [] };
        if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
        return { rows: [] };
      });
      await handler(withRequestId(makeEvent()));
      expect(mockRecordAccess.mock.calls[0][2]).toMatchObject({ recordIds: [], resultCount: 0, linkExpiresAt: null });
    });

    it('answers 500 with no posts and signs nothing when the record cannot be written', async () => {
      mockRecordAccess.mockRejectedValue(new Error('audit: the access record could not be written'));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(getSignedUrl).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
        surface: 'employer.worker_posts', outcome: 'failed', subjectUserIds: [WORKER_ID],
      });
    });

    it('records a denied attempt after the 403 commits', async () => {
      mockQuery.mockImplementation((sql: string) => {
        const text = String(sql);
        if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
        return { rows: [] };
      });
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(403);
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'COMMIT');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.worker_posts', outcome: 'denied', subjectUserIds: [WORKER_ID],
      });
    });
  });

  describe('caller scope (employer organizations)', () => {
    it('answers the actor failure after COMMIT and checks no relationship', async () => {
      mockResolveEmployerActor.mockResolvedValueOnce({ ok: false, status: 403, error: 'membership_inactive' });
      const res = await handler(makeEvent());
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
      expect(recordAttempt).not.toHaveBeenCalled();
    });

    it("checks the relationship and reads the posts against an owner's whole scope", async () => {
      mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, [OWNER_ID, FOREMAN_ID]));
      expect((await handler(makeEvent())).statusCode).toBe(200);
      const relationship = mockQuery.mock.calls.find(([sql]) =>
        String(sql).includes('FROM job_applications ja') && !String(sql).includes('FROM worker_posts'))!;
      expect(String(relationship[0])).toContain('j.employer_id = ANY($2::uuid[])');
      expect(String(relationship[0])).not.toContain('cognito_sub');
      expect(relationship[1]).toEqual([WORKER_ID, [OWNER_ID, FOREMAN_ID]]);
      const posts = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM worker_posts'))!;
      expect(posts[1]).toEqual([WORKER_ID, null, null, 24, [OWNER_ID, FOREMAN_ID]]);
    });
  });
});
