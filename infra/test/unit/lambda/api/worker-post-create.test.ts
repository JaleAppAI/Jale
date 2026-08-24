import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-post-create';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { moderateImage } from '../../../../lambda/lib/moderation';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/moderation');

// TDZ-safe: the mock factory below runs before `mockHeadSend` would be
// initialized if referenced directly (jest.mock is hoisted above imports/consts).
// Wrapping the reference in an arrow function defers the read until send() is
// actually invoked, by which point mockHeadSend is assigned.
const mockHeadSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockHeadSend(...a) })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();

const POST_ID = '22222222-2222-4222-8222-222222222222';
const KEY = (n: string) => `worker-uuid/posts/${POST_ID}/${n}`;

const makeEvent = (body: unknown) => ({
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

describe('worker-post-create Lambda', () => {
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
    (moderateImage as jest.Mock).mockResolvedValue('approved');
    mockHeadSend.mockResolvedValue({ ContentLength: 5000, ContentType: 'image/jpeg', VersionId: 'v-abc' });
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('INSERT INTO worker_posts')) {
        return { rows: [{ id: POST_ID, caption: 'my work', source: 'web', created_at: '2026-08-22T00:00:00Z' }] };
      }
      return { rows: [] };
    });
  });

  it('rejects an s3_key outside the caller/post prefix', async () => {
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [{ s3_key: `other-worker/posts/${POST_ID}/a.jpg`, sort_order: 0 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_s3_key');
  });

  it('rejects duplicate sort_orders', async () => {
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [
        { s3_key: KEY('a.jpg'), sort_order: 0 },
        { s3_key: KEY('b.jpg'), sort_order: 0 },
      ],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_sort_order');
  });

  it('rejects a sort_order outside the valid 0..MAX_POST_IMAGES-1 range', async () => {
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [{ s3_key: KEY('a.jpg'), sort_order: 40000 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_sort_order');
  });

  it('rejects a caption over the 1000-char cap', async () => {
    const res = await handler(makeEvent({
      post_id: POST_ID,
      caption: 'x'.repeat(1001),
      items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('caption_too_long');
  });

  it('rejects when an uploaded object is missing', async () => {
    mockHeadSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotFound' }));
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('uploaded_object_not_found');
  });

  it('rejects when HeadObject returns no VersionId (bucket must be versioned)', async () => {
    mockHeadSend.mockResolvedValue({ ContentLength: 5000, ContentType: 'image/jpeg' });
    const res = await handler(makeEvent({ post_id: POST_ID, items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }] }));
    expect(res.statusCode).toBe(500);
  });

  it('maps only NotFound to uploaded_object_not_found; other Head errors are 500', async () => {
    mockHeadSend.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const res = await handler(makeEvent({ post_id: POST_ID, items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }] }));
    expect(res.statusCode).toBe(500);
  });

  it('creates the post, moderates every image, reports flagged_count', async () => {
    (moderateImage as jest.Mock).mockResolvedValueOnce('approved').mockResolvedValueOnce('flagged');
    const res = await handler(makeEvent({
      post_id: POST_ID,
      caption: 'my work',
      items: [
        { s3_key: KEY('a.jpg'), sort_order: 0 },
        { s3_key: KEY('b.jpg'), sort_order: 1 },
      ],
    }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.flagged_count).toBe(1);
    expect(moderateImage).toHaveBeenCalledTimes(2);
    expect(moderateImage).toHaveBeenCalledWith('jale-worker-media-test', KEY('a.jpg'), 'v-abc');
    const mediaInsert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_post_media'));
    expect(mediaInsert).toBeDefined();
    expect(mediaInsert?.[1]).toEqual(expect.arrayContaining(['worker-uuid', 'v-abc']));
  });

  it('returns 409 when the post id already exists', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('INSERT INTO worker_posts')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      return { rows: [] };
    });
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }],
    }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('post_already_exists');
  });

  it('rolls back transaction 2 before releasing when the media INSERT fails on a non-23505 error', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('INSERT INTO worker_posts')) {
        return { rows: [{ id: POST_ID, caption: 'my work', source: 'web', created_at: '2026-08-22T00:00:00Z' }] };
      }
      if (text.includes('INSERT INTO worker_post_media')) {
        // A non-23505 error (e.g. numeric field overflow, 22003) must not be
        // mistaken for the duplicate-post case -- it should fall through to
        // the generic 500 path, but only after the open transaction is
        // rolled back (the pool is max:1, so a leaked open transaction would
        // poison the next warm-container invocation).
        throw Object.assign(new Error('numeric field overflow'), { code: '22003' });
      }
      return { rows: [] };
    });
    const res = await handler(makeEvent({
      post_id: POST_ID,
      items: [{ s3_key: KEY('a.jpg'), sort_order: 0 }],
    }));
    expect(res.statusCode).toBe(500);
    const calls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const insertIdx = calls.findIndex((sql) => sql.includes('INSERT INTO worker_post_media'));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    const rollbackIdx = calls.indexOf('ROLLBACK', insertIdx);
    expect(rollbackIdx).toBeGreaterThan(insertIdx);
  });
});
