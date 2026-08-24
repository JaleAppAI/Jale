import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-post-upload-urls';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example/presigned'),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();

const makeEvent = (body: unknown) => ({
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

describe('worker-post-upload-urls Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.MEDIA_BUCKET = 'jale-worker-media-test';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    });
    (setRlsContext as jest.Mock).mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) =>
      String(sql).includes('FROM users') ? { rows: [{ id: 'worker-uuid' }] } : {},
    );
  });

  it('rejects an empty items array', async () => {
    const res = await handler(makeEvent({ items: [] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_items');
  });

  it('rejects more than 10 items', async () => {
    const items = Array.from({ length: 11 }, () => ({ mime_type: 'image/jpeg', file_size: 1000 }));
    const res = await handler(makeEvent({ items }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('too_many_items');
  });

  it('rejects a non-image mime type', async () => {
    const res = await handler(makeEvent({ items: [{ mime_type: 'application/pdf', file_size: 1000 }] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_mime_type');
  });

  it('rejects an oversized file', async () => {
    const res = await handler(makeEvent({ items: [{ mime_type: 'image/jpeg', file_size: 11 * 1024 * 1024 }] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('file_too_large');
  });

  it('returns one presigned upload per item, keyed under the worker/post prefix', async () => {
    const res = await handler(makeEvent({
      items: [
        { mime_type: 'image/jpeg', file_size: 1000 },
        { mime_type: 'image/webp', file_size: 2000 },
      ],
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.post_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.uploads).toHaveLength(2);
    expect(body.uploads[0].s3_key).toMatch(new RegExp(`^worker-uuid/posts/${body.post_id}/[0-9a-f-]{36}\\.jpg$`));
    expect(body.uploads[1].s3_key).toMatch(/\.webp$/);
    expect(body.uploads[0].url).toBe('https://s3.example/presigned');
  });
});
