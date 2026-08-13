import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/pay-reference';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function makeEvent(opts: {
  sub?: string | null;
  trade?: string;
  city_key?: string;
} = {}): APIGatewayProxyEvent {
  // Distinguish "key omitted -> use the default" from "key explicitly set to
  // undefined -> simulate the query param being absent from the request" via
  // 'in' checks, since destructuring defaults can't tell those apart (a
  // default kicks in for an explicit `undefined` value too).
  const sub = 'sub' in opts ? opts.sub : 'user-sub-1';
  const trade = 'trade' in opts ? opts.trade : 'electrician';
  const city_key = 'city_key' in opts ? opts.city_key : 'austin-tx';

  const queryStringParameters: Record<string, string> = {};
  if (trade !== undefined) queryStringParameters.trade = trade;
  if (city_key !== undefined) queryStringParameters.city_key = city_key;

  return {
    requestContext: sub ? { authorizer: { claims: { sub } } } : { authorizer: {} },
    queryStringParameters,
  } as unknown as APIGatewayProxyEvent;
}

const AUSTIN_ELECTRICIAN_ROW = {
  trade_category: 'electrician',
  p25_hourly: '22.97',
  p50_hourly: '29.03',
  p75_hourly: '35.25',
  area_kind: 'metro',
  area_label: 'Austin',
  source_tier: 'metro',
  data_vintage: 'May 2025',
};

describe('GET /pay-reference handler', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
  });
  afterAll(() => { process.env = env; });

  it('returns 401 when there is no cognito sub', async () => {
    const res = await handler(makeEvent({ sub: null }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_trade when trade is missing', async () => {
    const res = await handler(makeEvent({ trade: undefined }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_trade' });
  });

  it('returns 400 invalid_trade when trade is not one of the 8 canonical categories', async () => {
    const res = await handler(makeEvent({ trade: 'welder' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_trade' });
  });

  it('never echoes the raw invalid trade value back in the error body', async () => {
    const res = await handler(makeEvent({ trade: 'SUPER_SECRET_WELDER_VALUE' }));
    expect(res.body).not.toContain('SUPER_SECRET_WELDER_VALUE');
  });

  it('returns 400 invalid_city_key when city_key is missing', async () => {
    const res = await handler(makeEvent({ city_key: undefined }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_city_key' });
  });

  it('returns 400 invalid_city_key when city_key does not match the slug shape', async () => {
    const res = await handler(makeEvent({ city_key: 'Austin TX!' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_city_key' });
  });

  it('never echoes the raw invalid city_key value back in the error body', async () => {
    const res = await handler(makeEvent({ city_key: 'SUPER_SECRET_CITY_VALUE!' }));
    expect(res.body).not.toContain('SUPER_SECRET_CITY_VALUE');
  });

  it('returns 404 no_reference for trade=other without querying the database', async () => {
    const res = await handler(makeEvent({ trade: 'other' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_reference' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 404 no_reference when the lookup finds nothing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent({ city_key: 'nowhere-tx' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_reference' });
  });

  it('returns 200 with the metro reference, numbers cast from NUMERIC strings', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM city_cbsa_crosswalk')) return Promise.resolve({ rows: [{ area_code: '12420' }] });
      if (sql.includes('FROM wage_references')) return Promise.resolve({ rows: [AUSTIN_ELECTRICIAN_ROW] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(makeEvent({ trade: 'electrician', city_key: 'austin-tx' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      trade_category: 'electrician',
      p25_hourly: 22.97,
      p50_hourly: 29.03,
      p75_hourly: 35.25,
      area_kind: 'metro',
      area_label: 'Austin',
      source_tier: 'metro',
      data_vintage: 'May 2025',
    });
    expect(typeof body.p25_hourly).toBe('number');
    expect(typeof body.p50_hourly).toBe('number');
    expect(typeof body.p75_hourly).toBe('number');
  });

  it('sets RLS context with the cognito sub inside BEGIN/COMMIT', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM city_cbsa_crosswalk')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM wage_references')) return Promise.resolve({ rows: [AUSTIN_ELECTRICIAN_ROW] });
      return Promise.resolve({ rows: [] });
    });
    await handler(makeEvent({ sub: 'worker-sub-42' }));
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-sub-42');
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 500 and rolls back when a query throws', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({});
      if (sql.includes('FROM city_cbsa_crosswalk')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
