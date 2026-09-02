import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-documents-dispatch';
import { handler as uploadUrlHandler } from '../../../../lambda/api/worker-doc-upload-url';
import { handler as confirmHandler } from '../../../../lambda/api/worker-doc-confirm';
import { handler as submitHandler } from '../../../../lambda/api/worker-doc-submit';

jest.mock('../../../../lambda/api/worker-doc-upload-url', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/worker-doc-confirm', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/worker-doc-submit', () => ({ handler: jest.fn() }));

const mockUploadUrl = uploadUrlHandler as jest.Mock;
const mockConfirm = confirmHandler as jest.Mock;
const mockSubmit = submitHandler as jest.Mock;
const all = () => [mockUploadUrl, mockConfirm, mockSubmit];

const makeEvent = (action: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  // The tokenized flow is UNAUTHENTICATED: no requestContext.authorizer at
  // all. The delegates read the upload token out of the body.
  pathParameters: action === undefined ? {} : { action },
  body: JSON.stringify({ token: 'upload-token', doc_type: 'id_card' }),
} as unknown as APIGatewayProxyEvent);

describe('worker-documents-dispatch (POST /worker/documents/{action})', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    for (const mock of all()) mock.mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' });
  });

  it.each([
    ['upload-url', () => mockUploadUrl],
    ['confirm', () => mockConfirm],
    ['submit', () => mockSubmit],
  ])('routes %s to its handler and to no other', async (action, chosen) => {
    await handler(makeEvent(action as string));
    expect(chosen()).toHaveBeenCalledTimes(1);
    expect(all().filter((m) => m !== chosen()).every((m) => m.mock.calls.length === 0)).toBe(true);
  });

  it('passes the event through unmodified, body included', async () => {
    const event = makeEvent('confirm');
    await handler(event);
    expect(mockConfirm.mock.calls[0][0]).toBe(event);
    expect(JSON.parse(mockConfirm.mock.calls[0][0].body).token).toBe('upload-token');
  });

  it('returns the delegate response verbatim', async () => {
    mockUploadUrl.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"url":"https://s3"}' });
    const res = await handler(makeEvent('upload-url'));
    expect(JSON.parse(res.body).url).toBe('https://s3');
  });

  it('404s an unknown action without invoking any delegate', async () => {
    const res = await handler(makeEvent('list'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    for (const mock of all()) expect(mock).not.toHaveBeenCalled();
  });

  it('404s a missing action', async () => {
    expect((await handler(makeEvent(undefined))).statusCode).toBe(404);
  });

  it.each(['__proto__', 'constructor', 'valueOf'])('404s the prototype-chain key %s', async (action) => {
    expect((await handler(makeEvent(action))).statusCode).toBe(404);
  });

  it('returns CORS headers on the 404', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
  });
});
