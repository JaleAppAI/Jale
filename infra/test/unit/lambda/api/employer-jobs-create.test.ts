import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-create';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { setJobCoordinates } from '../../../../lambda/lib/location';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEntitlements } from '../../../../lambda/lib/entitlements';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/location');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetJobCoordinates = setJobCoordinates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveEntitlements as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const makeEvent = (body: Record<string, unknown>) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  body: JSON.stringify({
    title: 'Concrete Finisher',
    location: 'Columbus, OH',
    job_type: 'contract',
    trade_category: 'concrete',
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
    // Default: employer_free, 1 slot, 0 active jobs — allow create
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ active_jobs: 0 }] });
      }
      if (sql.includes('INSERT INTO jobs')) {
        return Promise.resolve({
          rows: [{
            id: 'job-1',
            title: 'Concrete Finisher',
            location: 'Columbus, OH',
            pay: null,
            job_type: 'contract',
            status: 'active',
            required_docs: [],
            created_at: 'now',
            pay_min: null,
            pay_max: null,
            start_date: null,
            expected_duration: null,
            shift_schedule: null,
            transportation_required: false,
            language_preference: ['any'],
            number_of_workers_needed: 1,
            hired_count: 0,
            open_count: 1,
            trade_category: 'concrete',
            required_experience_years: null,
            certifications: [],
          }],
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

  it('rejects invalid pay ranges before opening a DB connection', async () => {
    const res = await handler(makeEvent({ pay_min: 30, pay_max: 20 }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_pay_range');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  // A-7 (T-A1 ride-along): 4000-char cap on `description`, enforced by
  // parseJobFields (infra/lambda/lib/job-fields.ts) -- this handler makes no
  // description-specific check of its own, so these two tests are the
  // endpoint-level proof that the shared validator's rejection reaches the
  // create path unchanged.
  it('rejects an over-length (4001+ char) description with 400 invalid_description, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ description: 'A'.repeat(4001) }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_description' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('accepts a description at exactly the 4000-char boundary', async () => {
    const res = await handler(makeEvent({ description: 'A'.repeat(4000) }));

    expect(res.statusCode).toBe(201);
  });

  it('persists a TRIMMED description, so surrounding whitespace cannot smuggle extra characters past the 4000-char cap into storage', async () => {
    // parseJobFields validates the TRIMMED length (4000, passes), but a raw
    // pass-through would previously store this ~1MB whitespace-padded value
    // verbatim. Assert on the actual INSERT bind param, not just the status
    // code -- a 201 alone would not have caught the bug.
    const padded = `  ${'A'.repeat(4000)}  `;
    const res = await handler(makeEvent({ description: padded }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO jobs'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // Column order in the INSERT: employer_id, title, location, pay,
    // job_type, description, ... -- description is bind param index 5.
    expect(params[5]).toBe('A'.repeat(4000));
    expect((params[5] as string).length).toBe(4000);
  });

  // ---------------------------------------------------------------------------
  // Entitlement gate — A7 tests
  // ---------------------------------------------------------------------------

  it('creates a job when employer_free plan has 0 active jobs (slot available)', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ active_jobs: 0 }] });
      if (sql.includes('INSERT INTO jobs')) {
        return Promise.resolve({ rows: [{ id: 'job-1', title: 'Concrete Finisher', location: 'Columbus, OH', pay: null, job_type: 'contract', status: 'active', required_docs: [], created_at: 'now', pay_min: null, pay_max: null, start_date: null, expected_duration: null, shift_schedule: null, transportation_required: false, language_preference: ['any'], number_of_workers_needed: 1, hired_count: 0, open_count: 1, trade_category: 'concrete', required_experience_years: null, certifications: [] }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({}));

    expect(res.statusCode).toBe(201);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 403 job_limit_reached when employer_free plan is at its active job limit', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ active_jobs: 1 }] }); // already at limit
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({}));

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('job_limit_reached');
    expect(body.plan_code).toBe('employer_free');
    expect(body.active_job_limit).toBe(1);
    expect(body.active_jobs).toBe(1);
    // Must roll back, must not insert
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO jobs'), expect.anything());
  });

  it('creates a job when employer_pro plan has slots remaining', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ active_jobs: 3 }] }); // under limit
      if (sql.includes('INSERT INTO jobs')) {
        return Promise.resolve({ rows: [{ id: 'job-2', title: 'Concrete Finisher', location: 'Columbus, OH', pay: null, job_type: 'contract', status: 'active', required_docs: [], created_at: 'now', pay_min: null, pay_max: null, start_date: null, expected_duration: null, shift_schedule: null, transportation_required: false, language_preference: ['any'], number_of_workers_needed: 1, hired_count: 0, open_count: 1, trade_category: 'concrete', required_experience_years: null, certifications: [] }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({}));

    expect(res.statusCode).toBe(201);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 500 when resolveEntitlements throws billing_plan_catalog_invalid', async () => {
    mockResolveEntitlements.mockRejectedValue(new Error('billing_plan_catalog_invalid'));
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({}));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    // Must roll back on error
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('issues FOR UPDATE lock query before resolving entitlements', async () => {
    const callOrder: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        callOrder.push('for_update');
        return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      }
      if (sql.includes('COUNT(*)')) {
        callOrder.push('count');
        return Promise.resolve({ rows: [{ active_jobs: 0 }] });
      }
      if (sql.includes('INSERT INTO jobs')) {
        callOrder.push('insert');
        return Promise.resolve({ rows: [{ id: 'job-1', title: 'Concrete Finisher', location: 'Columbus, OH', pay: null, job_type: 'contract', status: 'active', required_docs: [], created_at: 'now', pay_min: null, pay_max: null, start_date: null, expected_duration: null, shift_schedule: null, transportation_required: false, language_preference: ['any'], number_of_workers_needed: 1, hired_count: 0, open_count: 1, trade_category: 'concrete', required_experience_years: null, certifications: [] }] });
      }
      return Promise.resolve({});
    });
    mockResolveEntitlements.mockImplementation(() => {
      callOrder.push('resolve_entitlements');
      return Promise.resolve({ planCode: 'employer_free', activeJobLimit: 1 });
    });

    await handler(makeEvent({}));

    expect(callOrder.indexOf('for_update')).toBeLessThan(callOrder.indexOf('resolve_entitlements'));
    expect(callOrder.indexOf('resolve_entitlements')).toBeLessThan(callOrder.indexOf('count'));
    expect(callOrder.indexOf('count')).toBeLessThan(callOrder.indexOf('insert'));
  });

  // INSERT positional params (0-based): 21 city_key, 22 city, 23 state, 24 state_region.

  it('stores the city triple when provided', async () => {
    const res = await handler(makeEvent({ city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }));
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO jobs'));
    expect(insertCall[0]).toContain('city_key');
    // state_region is derived from location ('Columbus, OH') independently of
    // the picker triple, which only feeds city_key/city/state.
    expect(insertCall[1].slice(21)).toEqual(['el-paso-tx', 'El Paso', 'TX', 'OH']);
  });

  it('derives the city triple from parseable location text when no picker triple is sent', async () => {
    const res = await handler(makeEvent({}));  // location defaults to 'Columbus, OH'
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO jobs'));
    expect(insertCall[1].slice(21)).toEqual(['columbus-oh', 'Columbus', 'OH', 'OH']);
  });

  it('accepts a job with unparseable location and no city fields (degraded picker)', async () => {
    const res = await handler(makeEvent({ location: 'Near the old stadium' }));
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO jobs'));
    expect(insertCall[1].slice(21)).toEqual([null, null, null, null]);
  });

  it('a picker triple wins over the location text parse', async () => {
    const res = await handler(makeEvent({
      location: 'Columbus, OH',
      city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
    }));
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO jobs'));
    // state_region still derives from location ('Columbus, OH' -> OH),
    // independently of the picker triple overriding city_key/city/state.
    expect(insertCall[1].slice(21)).toEqual(['el-paso-tx', 'El Paso', 'TX', 'OH']);
  });

  it('accepts a lone `city` field (no city_key/state) as the SEO-only channel -- no longer a 400 partial triple', async () => {
    // Doctrine change: only city_key/state presence triggers the all-three
    // requirement. A lone `city` is legal (parseCityFields returns ok+null),
    // so this now creates successfully. Because the default location
    // ('Columbus, OH') IS derivable via parseCityFromLocation, that derived
    // triple's city ("Columbus") wins over the explicit `city: 'El Paso'` for
    // the shared column -- see resolveJobLocationFields/cityTriple ordering
    // in employer-jobs-create.ts. The explicit `city` only wins when no
    // triple is sent AND the location itself is unparseable (see the
    // employer-jobs-update.test.ts SEO-channel tests for that case).
    const res = await handler(makeEvent({ city: 'El Paso' }));
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO jobs'));
    expect(insertCall[1][21]).toBe('columbus-oh');
    expect(insertCall[1][22]).toBe('Columbus');
    expect(insertCall[1][23]).toBe('OH');
    expect(insertCall[1][24]).toBe('OH');
  });

  it('rejects a mismatched city_key (400)', async () => {
    const res = await handler(makeEvent({ city_key: 'austin-tx', city: 'El Paso', state: 'TX' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_city_key');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});
