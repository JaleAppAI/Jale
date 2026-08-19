import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-templates-save';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEntitlements } from '../../../../lambda/lib/entitlements';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveEntitlements as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const BASE_PAYLOAD = {
  title: 'Concrete Finisher',
  location: 'Columbus, OH',
  job_type: 'contract',
  trade_category: 'concrete',
};

const makeEvent = (bodyOverrides: Record<string, unknown> = {}) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  body: JSON.stringify({
    name: 'Concrete crew',
    payload: BASE_PAYLOAD,
    ...bodyOverrides,
  }),
} as unknown as APIGatewayProxyEvent);

const TEMPLATE_ROW = { id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90', name: 'Concrete crew', payload: {}, updated_at: 'now' };

describe('employer-templates-save', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    // Default: employer_free, 2 template slots, 0 used -- allow create
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1, templateLimit: 2 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ template_count: 0 }] });
      }
      if (sql.includes('SELECT id FROM employer_job_templates')) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (sql.includes('INSERT INTO employer_job_templates')) {
        return Promise.resolve({ rows: [TEMPLATE_ROW] });
      }
      return Promise.resolve({});
    });
  });

  it('creates a template (201) and strips start_date from the stored payload', async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, start_date: '2026-09-01' } }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    expect(insertCall).toBeDefined();
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.start_date).toBeUndefined();
    expect(parsed.title).toBe('Concrete Finisher');
  });

  it('rejects at the template cap with plan context (403)', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1, templateLimit: 2 });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ template_count: 2 }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'template_limit_reached', plan_code: 'employer_free', template_limit: 2 });
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('rejects a duplicate name (409 template_name_taken)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ template_count: 0 }] });
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'tpl-other' }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('template_name_taken');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('updates an owned template by id without a cap check (200)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90' }));

    expect(res.statusCode).toBe(200);
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  it("rejects renaming onto ANOTHER template's name (409)", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'tpl-other' }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('template_name_taken');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE employer_job_templates'), expect.anything());
  });

  it('allows renaming a template to its own current name (200)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90' }));

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for an unowned/unknown id', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'emp-1' }] });
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('rejects a malformed template id before touching the database (400)', async () => {
    const res = await handler(makeEvent({ id: 'not-a-uuid' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_template_id');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each([
    // trade_category REQUIRED here: parseJobFields runs first and would
    // otherwise win with invalid_trade_category. city_key without state
    // exercises the 400 partial-triple path (a lone `city` alone is legal).
    [{ payload: { title: 'x', location: 'y', job_type: 'contract', trade_category: 'concrete', city_key: 'el-paso-tx', city: 'El Paso' } }, 'invalid_city_fields'],
    [{ payload: { title: 'x', location: 'y', job_type: 'bogus' } }, 'invalid_job_type'],
    [{ name: '', payload: { title: 'x', location: 'y', job_type: 'contract' } }, 'invalid_template_name'],
    [{ name: 'a'.repeat(81), payload: { title: 'x', location: 'y', job_type: 'contract' } }, 'invalid_template_name'],
  ])('validates input %j -> %s (400)', async (bodyOverrides, code) => {
    const res = await handler(makeEvent(bodyOverrides as Record<string, unknown>));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(code);
  });

  // ---------------------------------------------------------------------------
  // Stage 1a -- optional_docs / required_fields / optional_fields
  // ---------------------------------------------------------------------------

  it('stores all four requirement arrays from a fully-populated payload', async () => {
    const res = await handler(makeEvent({
      payload: {
        ...BASE_PAYLOAD,
        required_docs: ['resume'],
        optional_docs: ['driver_license'],
        required_fields: ['work_authorization'],
        optional_fields: ['date_available'],
      },
    }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    expect(insertCall).toBeDefined();
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.required_docs).toEqual(['resume']);
    expect(parsed.optional_docs).toEqual(['driver_license']);
    expect(parsed.required_fields).toEqual(['work_authorization']);
    expect(parsed.optional_fields).toEqual(['date_available']);
  });

  it('validates a legacy payload with none of the three new keys (still 201, and no defaults are injected into the stored payload)', async () => {
    const res = await handler(makeEvent({ payload: BASE_PAYLOAD }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    const parsed = JSON.parse(insertCall[1][2]);
    // required_docs is existing, unconditional behavior -- untouched by Stage 1a.
    expect(parsed.required_docs).toEqual([]);
    // The three NEW keys must stay absent, not default to [], so an old
    // template's stored shape is never rewritten just by being re-saved.
    expect(parsed).not.toHaveProperty('optional_docs');
    expect(parsed).not.toHaveProperty('required_fields');
    expect(parsed).not.toHaveProperty('optional_fields');
  });

  it('rejects overlapping required/optional fields with 400 requirements_tier_overlap', async () => {
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, required_fields: ['work_authorization'], optional_fields: ['work_authorization'] },
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('requirements_tier_overlap');
    expect(body.keys).toEqual(['work_authorization']);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('rejects overlapping required/optional docs with 400 requirements_tier_overlap', async () => {
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, required_docs: ['resume'], optional_docs: ['resume'] },
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('requirements_tier_overlap');
    expect(body.keys).toEqual(['resume']);
  });

  it('rejects an invalid optional_docs entry with 400 invalid_optional_docs', async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, optional_docs: ['bogus'] } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_optional_docs');
  });

  it('rejects an invalid required_fields entry with 400 invalid_required_fields', async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, required_fields: ['bogus'] } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_required_fields');
  });

  it('rejects an invalid optional_fields entry with 400 invalid_optional_fields', async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, optional_fields: ['bogus'] } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_optional_fields');
  });
});
