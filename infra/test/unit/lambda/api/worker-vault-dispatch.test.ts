import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-vault-dispatch';
import { handler as uploadUrlAuthHandler } from '../../../../lambda/api/worker-doc-upload-url-auth';
import { handler as confirmAuthHandler } from '../../../../lambda/api/worker-doc-confirm-auth';
import { DOC_TYPES } from '../../../../lambda/lib/job-fields';

jest.mock('../../../../lambda/api/worker-doc-upload-url-auth', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/worker-doc-confirm-auth', () => ({ handler: jest.fn() }));

const mockUploadUrl = uploadUrlAuthHandler as jest.Mock;
const mockConfirm = confirmAuthHandler as jest.Mock;

// This dispatcher is mounted on `/worker/vault/{doc_type}` — the SAME resource
// that already serves `DELETE /worker/vault/{doc_type}` — so its path
// parameter is named `doc_type`, and the two literal actions occupy the same
// slot a real doc type does on the DELETE. Hence the last test below: a real
// doc type must NOT reach either upload handler.
const makeEvent = (docType: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  pathParameters: docType === undefined ? {} : { doc_type: docType },
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  body: JSON.stringify({ doc_type: 'id_card', mime_type: 'image/jpeg' }),
} as unknown as APIGatewayProxyEvent);

describe('worker-vault-dispatch (POST /worker/vault/{doc_type})', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    for (const mock of [mockUploadUrl, mockConfirm]) {
      mock.mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' });
    }
  });

  it('routes upload-url to worker-doc-upload-url-auth only', async () => {
    await handler(makeEvent('upload-url'));
    expect(mockUploadUrl).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('routes confirm to worker-doc-confirm-auth only', async () => {
    await handler(makeEvent('confirm'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockUploadUrl).not.toHaveBeenCalled();
  });

  it('passes the event through unmodified — the delegates read doc_type from the BODY', async () => {
    const event = makeEvent('upload-url');
    await handler(event);
    expect(mockUploadUrl.mock.calls[0][0]).toBe(event);
    // The path parameter still says 'upload-url'; the dispatcher must not
    // rewrite pathParameters.doc_type to the body's value.
    expect(mockUploadUrl.mock.calls[0][0].pathParameters.doc_type).toBe('upload-url');
    expect(JSON.parse(mockUploadUrl.mock.calls[0][0].body).doc_type).toBe('id_card');
  });

  it('returns the delegate response verbatim', async () => {
    mockConfirm.mockResolvedValue({ statusCode: 409, headers: {}, body: '{"error":"duplicate"}' });
    await expect(handler(makeEvent('confirm'))).resolves.toEqual({
      statusCode: 409,
      headers: {},
      body: '{"error":"duplicate"}',
    });
  });

  it('404s a missing doc_type', async () => {
    expect((await handler(makeEvent(undefined))).statusCode).toBe(404);
  });

  it.each(['__proto__', 'constructor', 'toString'])('404s the prototype-chain key %s', async (docType) => {
    expect((await handler(makeEvent(docType))).statusCode).toBe(404);
  });

  it('returns CORS headers on the 404', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
  });

  // `{doc_type}` is shared with DELETE, whose real values are the DOC_TYPES.
  // A POST to one of those was a 403 from API Gateway before this
  // consolidation (no such route) and must now be a clean 404 — never a
  // silent upload-url mint or confirm under a doc-type-shaped action.
  it('404s every REAL doc type without invoking a delegate', async () => {
    for (const docType of DOC_TYPES) {
      const res = await handler(makeEvent(docType));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    }
    expect(mockUploadUrl).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('has no doc type that collides with an action name', () => {
    // If a future doc type were literally named `confirm` or `upload-url`,
    // DELETE would keep working while POST silently shadowed it. Guard it here
    // rather than discovering it in production.
    expect(DOC_TYPES).not.toContain('upload-url');
    expect(DOC_TYPES).not.toContain('confirm');
  });
});
