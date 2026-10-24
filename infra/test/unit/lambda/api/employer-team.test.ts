import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team';
import { handler as listHandler } from '../../../../lambda/api/employer-team-list';
import { handler as membershipHandler } from '../../../../lambda/api/employer-membership';
import { handler as createHandler } from '../../../../lambda/api/employer-team-invite-create';
import { handler as resendHandler } from '../../../../lambda/api/employer-team-invite-resend';
import { handler as revokeHandler } from '../../../../lambda/api/employer-team-invite-revoke';
import { handler as removeHandler } from '../../../../lambda/api/employer-team-member-remove';
import { handler as reassignHandler } from '../../../../lambda/api/employer-team-job-reassign';

jest.mock('../../../../lambda/api/employer-team-list', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-membership', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-team-invite-create', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-team-invite-resend', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-team-invite-revoke', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-team-member-remove', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-team-job-reassign', () => ({ handler: jest.fn() }));

const delegates: Record<string, jest.Mock> = {
  list: listHandler as jest.Mock,
  membership: membershipHandler as jest.Mock,
  create: createHandler as jest.Mock,
  resend: resendHandler as jest.Mock,
  revoke: revokeHandler as jest.Mock,
  remove: removeHandler as jest.Mock,
  reassign: reassignHandler as jest.Mock,
};

// One Lambda behind `/employer/team/{action}`: the method and the action pick
// the delegate.
const makeEvent = (method: string, action: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: method,
  pathParameters: action === undefined ? null : { action },
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: '{}',
} as unknown as APIGatewayProxyEvent);

function onlyCalled(name: string, event: APIGatewayProxyEvent): void {
  for (const [delegate, mock] of Object.entries(delegates)) {
    if (delegate === name) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][0]).toBe(event);
    } else {
      expect(mock).not.toHaveBeenCalled();
    }
  }
}

function noneCalled(): void {
  for (const mock of Object.values(delegates)) expect(mock).not.toHaveBeenCalled();
}

describe('employer-team dispatcher', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    for (const [name, mock] of Object.entries(delegates)) {
      mock.mockResolvedValue({ statusCode: 200, headers: {}, body: JSON.stringify({ from: name }) });
    }
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('GET members reaches the list delegate', async () => {
    const event = makeEvent('GET', 'members');
    await expect(handler(event)).resolves.toEqual({ statusCode: 200, headers: {}, body: '{"from":"list"}' });
    onlyCalled('list', event);
  });

  it('GET membership reaches the membership delegate', async () => {
    const event = makeEvent('GET', 'membership');
    await expect(handler(event)).resolves.toEqual({ statusCode: 200, headers: {}, body: '{"from":"membership"}' });
    onlyCalled('membership', event);
  });

  it.each([
    ['invite', 'create'],
    ['resend', 'resend'],
    ['revoke', 'revoke'],
    ['remove', 'remove'],
    ['reassign', 'reassign'],
    ['membership', 'membership'],
  ])('POST invite/resend/revoke/remove/reassign reach their delegates (%s)', async (action, delegate) => {
    const event = makeEvent('POST', action);
    await expect(handler(event)).resolves.toEqual({
      statusCode: 200, headers: {}, body: JSON.stringify({ from: delegate }),
    });
    onlyCalled(delegate, event);
  });

  it.each([
    ['GET', 'invite'],
    ['GET', 'remove'],
    ['POST', 'members'],
    ['GET', 'unknown'],
    ['POST', 'unknown'],
    ['POST', 'INVITE'],
    ['GET', ''],
  ])('GET invite and POST members: 404 not_found with CORS headers (%s %p)', async (method, action) => {
    const res = await handler(makeEvent(method, action));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
    noneCalled();
  });

  it.each([
    ['PUT', 'invite'],
    ['PATCH', 'remove'],
    ['DELETE', 'revoke'],
    ['HEAD', 'members'],
    ['OPTIONS', 'membership'],
  ])('an unsupported method (%s %p): 404 not_found, no delegate', async (method, action) => {
    const res = await handler(makeEvent(method, action));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
    noneCalled();
  });

  it('a request with no action: 404', async () => {
    const res = await handler(makeEvent('POST', undefined));
    expect(res.statusCode).toBe(404);
    noneCalled();
  });

  it.each([
    ['GET', '__proto__'],
    ['POST', '__proto__'],
    ['GET', 'constructor'],
    ['POST', 'constructor'],
    ['POST', 'toString'],
  ])('__proto__ and constructor: 404 (%s %p)', async (method, action) => {
    const res = await handler(makeEvent(method, action));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    noneCalled();
  });

  it.each([undefined, 'false', '', 'TRUE', '1'])(
    'with the flag off (%p), every route is 404 not_found before any delegate runs',
    async (flag) => {
      if (flag === undefined) delete process.env.TEAM_MANAGEMENT_ENABLED;
      else process.env.TEAM_MANAGEMENT_ENABLED = flag;
      for (const [method, action] of [
        ['GET', 'members'], ['GET', 'membership'], ['POST', 'invite'], ['POST', 'resend'],
        ['POST', 'revoke'], ['POST', 'remove'], ['POST', 'reassign'], ['POST', 'membership'],
      ]) {
        const res = await handler(makeEvent(method, action));
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
        expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
      }
      noneCalled();
    },
  );

  it('a delegate rejection propagates, never becomes a 404', async () => {
    delegates.remove.mockRejectedValue(new Error('boom'));
    await expect(handler(makeEvent('POST', 'remove'))).rejects.toThrow('boom');
  });
});
