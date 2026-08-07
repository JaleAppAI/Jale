import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-templates-delete';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const makeEvent = (overrides: Partial<APIGatewayProxyEvent> = {}) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { templateId: 'tpl-1' },
  ...overrides,
} as unknown as APIGatewayProxyEvent);

describe('employer-templates-delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM employer_job_templates')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({});
    });
  });

  it('returns 401 without claims', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: undefined } },
      pathParameters: { templateId: 'tpl-1' },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
  });

  it('returns 400 missing_template_id when path parameter is missing', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
      pathParameters: { },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_template_id');
  });

  it('deletes owned template and returns 204', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // Assert the DELETE query was called with correct params
    const deleteCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM employer_job_templates'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual(['tpl-1', 'employer-sub']);
  });

  it('returns 403 forbidden when template not found or unowned', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM employer_job_templates')) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('returns 403 when not compliant', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });
});
