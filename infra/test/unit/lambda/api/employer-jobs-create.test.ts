import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-create';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { setJobCoordinates } from '../../../../lambda/lib/location';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/location');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetJobCoordinates = setJobCoordinates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const makeEvent = (body: Record<string, unknown>) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  body: JSON.stringify({
    title: 'Concrete Finisher',
    location: 'Columbus, OH',
    job_type: 'contract',
    ...body,
  }),
} as unknown as APIGatewayProxyEvent);

describe('employer-jobs-create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockSetJobCoordinates.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO jobs')) {
        return Promise.resolve({
          rows: [{ id: 'job-1', title: 'Concrete Finisher', location: 'Columbus, OH', job_type: 'contract', status: 'active', required_docs: [], created_at: 'now' }],
        });
      }
      return Promise.resolve({});
    });
  });

  it('rejects partial coordinate payloads before opening a DB connection', async () => {
    const res = await handler(makeEvent({ latitude: 39.961176 }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_coordinates');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects out-of-range coordinates before opening a DB connection', async () => {
    const res = await handler(makeEvent({ latitude: 91, longitude: -82.998794 }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_latitude');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('sets manual job coordinates inside the create transaction when both coordinates are present', async () => {
    const res = await handler(makeEvent({ latitude: 39.961176, longitude: -82.998794 }));

    expect(res.statusCode).toBe(201);
    expect(mockSetJobCoordinates).toHaveBeenCalledWith(expect.any(Object), 'job-1', 39.961176, -82.998794, 'manual');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });
});
