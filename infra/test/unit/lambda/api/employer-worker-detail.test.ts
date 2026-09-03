import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-detail';
import { handler as profileHandler } from '../../../../lambda/api/employer-worker-profile';
import { handler as docsHandler } from '../../../../lambda/api/employer-worker-docs';
import { handler as postsHandler } from '../../../../lambda/api/employer-worker-posts';

// The three real handlers are replaced wholesale: this suite asserts ONLY the
// routing table and the pass-through, never the delegates' own behaviour (they
// keep their own test files, unchanged by the consolidation).
jest.mock('../../../../lambda/api/employer-worker-profile', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-worker-docs', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-worker-posts', () => ({ handler: jest.fn() }));

const mockProfile = profileHandler as jest.Mock;
const mockDocs = docsHandler as jest.Mock;
const mockPosts = postsHandler as jest.Mock;

const makeEvent = (action: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  pathParameters: action === undefined
    ? { worker_id: 'worker-uuid' }
    : { worker_id: 'worker-uuid', action },
  queryStringParameters: { job_id: 'job-uuid' },
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
} as unknown as APIGatewayProxyEvent);

describe('employer-worker-detail dispatcher (GET /employer/workers/{worker_id}/{action})', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    for (const mock of [mockProfile, mockDocs, mockPosts]) {
      mock.mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' });
    }
  });

  it.each([
    ['profile', () => mockProfile, () => [mockDocs, mockPosts]],
    ['documents', () => mockDocs, () => [mockProfile, mockPosts]],
    ['posts', () => mockPosts, () => [mockProfile, mockDocs]],
  ])('routes %s to its handler and to no other', async (action, chosen, others) => {
    await handler(makeEvent(action as string));
    expect(chosen()).toHaveBeenCalledTimes(1);
    for (const other of others()) expect(other).not.toHaveBeenCalled();
  });

  it('passes the event through unmodified, including worker_id and the query string', async () => {
    const event = makeEvent('profile');
    await handler(event);
    // Identity, not deep-equality: the delegates read worker_id off the SAME
    // event object, so the dispatcher must not clone or rewrite it.
    expect(mockProfile).toHaveBeenCalledWith(event);
    expect(mockProfile.mock.calls[0][0]).toBe(event);
    expect(mockProfile.mock.calls[0][0].pathParameters.worker_id).toBe('worker-uuid');
    expect(mockProfile.mock.calls[0][0].queryStringParameters.job_id).toBe('job-uuid');
  });

  it('returns the delegate response verbatim', async () => {
    mockDocs.mockResolvedValue({ statusCode: 201, headers: { 'X-T': '1' }, body: '{"documents":[]}' });
    await expect(handler(makeEvent('documents'))).resolves.toEqual({
      statusCode: 201,
      headers: { 'X-T': '1' },
      body: '{"documents":[]}',
    });
  });

  it('404s an unknown action without invoking any delegate', async () => {
    const res = await handler(makeEvent('secrets'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    for (const mock of [mockProfile, mockDocs, mockPosts]) expect(mock).not.toHaveBeenCalled();
  });

  it('404s a missing action', async () => {
    expect((await handler(makeEvent(undefined))).statusCode).toBe(404);
  });

  // A plain object literal keyed by the path parameter would resolve
  // '__proto__'/'constructor'/'toString' to inherited Object.prototype members
  // — a lookup table for user-controlled keys must be a Map.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '404s the prototype-chain key %s',
    async (action) => {
      const res = await handler(makeEvent(action));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    },
  );

  it('returns CORS headers on the 404 so the browser can read it', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
  });

  it('lets a delegate rejection propagate rather than masking it as a 404', async () => {
    mockPosts.mockRejectedValue(new Error('boom'));
    await expect(handler(makeEvent('posts'))).rejects.toThrow('boom');
  });
});
