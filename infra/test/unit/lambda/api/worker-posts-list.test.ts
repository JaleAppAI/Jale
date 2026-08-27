import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-posts-list';
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

const makeEvent = (queryStringParameters?: Record<string, string>) => ({
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  queryStringParameters,
} as unknown as APIGatewayProxyEvent);

const POST_A = { id: 'post-a', caption: 'c', source: 'web', created_at: '2026-08-22T02:00:00Z' };

describe('worker-posts-list Lambda', () => {
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
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('FROM worker_posts')) return { rows: [POST_A] };
      if (text.includes('FROM worker_post_media')) {
        return { rows: [
          { id: 'm1', post_id: 'post-a', s3_key: 'k1', s3_version_id: 'v1', sort_order: 0, moderation_status: 'approved' },
          { id: 'm2', post_id: 'post-a', s3_key: 'k2', s3_version_id: null, sort_order: 1, moderation_status: 'flagged' },
        ] };
      }
      return { rows: [] };
    });
  });

  it('returns own posts with presigned media in sort order, flagged included', async () => {
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].media.map((m: { sort_order: number }) => m.sort_order)).toEqual([0, 1]);
    expect(body.posts[0].media[1].moderation_status).toBe('flagged');
    expect(body.posts[0].media[0].url).toBe('https://s3.example/get');
    expect(body.next_before).toBeNull();
    expect(body.next_before_id).toBeNull();
  });

  it('rejects an invalid before cursor', async () => {
    const res = await handler(makeEvent({ before: 'not-a-date', before_id: '11111111-1111-4111-8111-111111111111' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_before');
  });

  it('rejects before without before_id', async () => {
    const res = await handler(makeEvent({ before: '2026-08-22T03:00:00Z' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_before');
  });

  it('passes limit, before, and before_id into the posts query', async () => {
    await handler(makeEvent({ limit: '5', before: '2026-08-22T03:00:00Z', before_id: '11111111-1111-4111-8111-111111111111' }));
    const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM worker_posts'));
    expect(call?.[0]).toContain('(created_at, id) <');
    expect(call?.[1]).toEqual(expect.arrayContaining([
      'worker-uuid',
      '2026-08-22T03:00:00.000Z',
      '11111111-1111-4111-8111-111111111111',
      5,
    ]));
  });

  it('pins the presigned GET to the media s3_version_id when present', async () => {
    await handler(makeEvent());
    expect(mockGetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'jale-worker-media-test', Key: 'k1', VersionId: 'v1' }),
    );
    const call2 = mockGetObjectCommand.mock.calls.find((c) => c[0].Key === 'k2');
    expect(call2?.[0]).not.toHaveProperty('VersionId');
  });
});
