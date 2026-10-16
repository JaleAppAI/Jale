import type { APIGatewayProxyEvent } from 'aws-lambda';
import { VIEW_RESOURCE, handler } from '../../../../lambda/api/worker-job-dispatch';
import { handler as detailHandler } from '../../../../lambda/api/worker-jobs-detail';
import { handler as viewHandler } from '../../../../lambda/api/worker-jobs-view';

jest.mock('../../../../lambda/api/worker-jobs-detail', () => ({ handler: jest.fn() }));
jest.mock('../../../../lambda/api/worker-jobs-view', () => ({ handler: jest.fn() }));

const mockDetail = detailHandler as jest.Mock;
const mockView = viewHandler as jest.Mock;

const JOB = '77777777-7777-4777-8777-777777777777';
const makeEvent = (httpMethod: string, resource: string): APIGatewayProxyEvent => ({
  httpMethod,
  resource,
  pathParameters: { jobId: JOB },
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  body: httpMethod === 'POST' ? JSON.stringify({ source: 'feed' }) : null,
} as unknown as APIGatewayProxyEvent);

// The existing WorkerJobsDetailLambda serves both GET /worker/jobs/{jobId}
// and, since sprint 28, POST /worker/jobs/{jobId}/view: one Lambda, so the
// new route costs no Function, role or log group.
describe('worker-job-dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetail.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"id":"job"}' });
    mockView.mockResolvedValue({ statusCode: 204, headers: {}, body: '' });
  });

  it('serves GET /worker/jobs/{jobId} with the job detail handler, unchanged', async () => {
    const event = makeEvent('GET', '/worker/jobs/{jobId}');
    const res = await handler(event);
    expect(mockDetail).toHaveBeenCalledTimes(1);
    expect(mockDetail.mock.calls[0][0]).toBe(event);
    expect(mockView).not.toHaveBeenCalled();
    expect(res).toEqual({ statusCode: 200, headers: {}, body: '{"id":"job"}' });
  });

  it('serves POST /worker/jobs/{jobId}/view with the view handler, and passes the event through', async () => {
    expect(VIEW_RESOURCE).toBe('/worker/jobs/{jobId}/view');
    const event = makeEvent('POST', VIEW_RESOURCE);
    const res = await handler(event);
    expect(mockView).toHaveBeenCalledTimes(1);
    expect(mockView.mock.calls[0][0]).toBe(event);
    expect(mockDetail).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });

  it('a GET on the view path or a POST elsewhere never reaches the view handler', async () => {
    await handler(makeEvent('GET', VIEW_RESOURCE));
    await handler(makeEvent('POST', '/worker/jobs/{jobId}'));
    expect(mockView).not.toHaveBeenCalled();
  });
});
