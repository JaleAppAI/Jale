import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-posts';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
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
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: EMPLOYER_ID }] };
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM worker_posts')) return { rows: [POST_A] };
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

  it('sets the internal RLS context to the employer id, not the worker id', async () => {
    await handler(makeEvent());
    expect(setInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);
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
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM worker_posts')) return { rows: [] };
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
      if (text.includes('FROM job_applications')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM worker_posts')) return { rows: [POST_A] };
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
});
