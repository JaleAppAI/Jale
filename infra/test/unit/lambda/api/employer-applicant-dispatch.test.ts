import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-applicant-dispatch';
import { handler as statusUpdateHandler } from '../../../../lambda/api/employer-application-status-update';
import { handler as hireDetailsHandler } from '../../../../lambda/api/employer-application-hire-details';

jest.mock('../../../../lambda/api/employer-application-status-update', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/employer-application-hire-details', () => ({ handler: jest.fn() }));

const mockStatusUpdate = statusUpdateHandler as jest.Mock;
const mockHireDetails = hireDetailsHandler as jest.Mock;

// One Lambda behind two resources: the bare `{workerId}` (PATCH, the status
// change) and its `{action}` child (PUT hire-details, F19). The action is the
// only thing that tells them apart.
const makeEvent = (method: string, action: string | undefined): APIGatewayProxyEvent => ({
  httpMethod: method,
  pathParameters: {
    jobId: '11111111-1111-4111-8111-111111111111',
    workerId: '22222222-2222-4222-8222-222222222222',
    ...(action === undefined ? {} : { action }),
  },
  requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
  body: '{}',
} as unknown as APIGatewayProxyEvent);

describe('employer-applicant-dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockStatusUpdate.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"from":"status"}' });
    mockHireDetails.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"from":"hire"}' });
  });

  it('sends the bare {workerId} PATCH to the status update, unchanged', async () => {
    const event = makeEvent('PATCH', undefined);
    await expect(handler(event)).resolves.toEqual({ statusCode: 200, headers: {}, body: '{"from":"status"}' });
    expect(mockStatusUpdate.mock.calls[0][0]).toBe(event);
    expect(mockHireDetails).not.toHaveBeenCalled();
  });

  it('sends {workerId}/hire-details to the hire-details handler only', async () => {
    const event = makeEvent('PUT', 'hire-details');
    await expect(handler(event)).resolves.toEqual({ statusCode: 200, headers: {}, body: '{"from":"hire"}' });
    expect(mockHireDetails.mock.calls[0][0]).toBe(event);
    expect(mockStatusUpdate).not.toHaveBeenCalled();
  });

  it.each(['status', '__proto__', 'constructor', 'HIRE-DETAILS', ''])('404s the action %p, with CORS headers', async (action) => {
    const res = await handler(makeEvent('PUT', action));
    expect(res.statusCode).toBe(404);
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
    expect(mockStatusUpdate).not.toHaveBeenCalled();
    expect(mockHireDetails).not.toHaveBeenCalled();
  });
});
