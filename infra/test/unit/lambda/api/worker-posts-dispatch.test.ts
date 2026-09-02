import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-posts-dispatch';
import { handler as uploadUrlsHandler } from '../../../../lambda/api/worker-post-upload-urls';

jest.mock('../../../../lambda/api/worker-post-upload-urls', () => ({ handler: jest.fn() }));

const mockUploadUrls = uploadUrlsHandler as jest.Mock;

// Mounted on `/worker/posts/{post_id}` — the resource that already serves
// `DELETE /worker/posts/{post_id}`. Only the POST goes through this
// dispatcher; DELETE keeps its own method and its own Lambda.
const makeEvent = (postId: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  pathParameters: postId === undefined ? {} : { post_id: postId },
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  body: JSON.stringify({ items: [{ mime_type: 'image/jpeg', file_size: 1024 }] }),
} as unknown as APIGatewayProxyEvent);

describe('worker-posts-dispatch (POST /worker/posts/{post_id})', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockUploadUrls.mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' });
  });

  it('routes upload-urls to worker-post-upload-urls', async () => {
    await handler(makeEvent('upload-urls'));
    expect(mockUploadUrls).toHaveBeenCalledTimes(1);
  });

  it('passes the event through unmodified', async () => {
    const event = makeEvent('upload-urls');
    await handler(event);
    expect(mockUploadUrls.mock.calls[0][0]).toBe(event);
    expect(JSON.parse(mockUploadUrls.mock.calls[0][0].body).items).toHaveLength(1);
  });

  it('returns the delegate response verbatim', async () => {
    mockUploadUrls.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"post_id":"p1","uploads":[]}' });
    const res = await handler(makeEvent('upload-urls'));
    expect(JSON.parse(res.body).post_id).toBe('p1');
  });

  // A POST to a real post id was a 403 from API Gateway before this
  // consolidation (the resource had DELETE only). It must be a clean 404, and
  // above all must not mint upload URLs.
  it('404s a real post id (a uuid) without invoking the delegate', async () => {
    const res = await handler(makeEvent('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockUploadUrls).not.toHaveBeenCalled();
  });

  it('404s a missing post_id', async () => {
    expect((await handler(makeEvent(undefined))).statusCode).toBe(404);
  });

  it.each(['__proto__', 'constructor', 'toString'])('404s the prototype-chain key %s', async (postId) => {
    expect((await handler(makeEvent(postId))).statusCode).toBe(404);
  });

  it('returns CORS headers on the 404', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
  });
});
