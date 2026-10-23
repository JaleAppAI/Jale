import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-templates-save';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveCompanyEntitlements } from '../../../../lambda/lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../../../../lambda/lib/company-usage';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');
jest.mock('../../../../lambda/lib/company-usage');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveCompanyEntitlements as jest.Mock;
const mockReadCompanyUsage = readCompanyUsage as jest.Mock;
const companyUsage = (templates: number) => ({ organizationId: ORG_ID, activeJobs: 0, templates, activeForemen: 0, suspendedForemen: 0 });
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const EMPLOYER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerActor = (scopeUserIds: string[] = [EMPLOYER_ID]) => ({
  ok: true,
  actor: { userId: EMPLOYER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds },
});

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
    mockResolveEmployerActor.mockResolvedValue(ownerActor());
    mockReadCompanyUsage.mockResolvedValue(companyUsage(0));
    mockQuery.mockImplementation((sql: string) => {
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

  it('rejects at the company template cap with plan context (403)', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1, templateLimit: 2, foremanSeatLimit: 0 });
    mockReadCompanyUsage.mockResolvedValue(companyUsage(2)); // two templates across the company

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'template_limit_reached', plan_code: 'employer_free', template_limit: 2 });
    expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.anything(), { lock: true });
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('rejects a duplicate name (409 template_name_taken)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'tpl-other' }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('template_name_taken');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('takes the company lock on the update path too, before its name check, without a cap check', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: TEMPLATE_ROW.id }));

    expect(res.statusCode).toBe(200);
    expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.anything(), { lock: true });
    const nameCheckAt = mockQuery.mock.calls.findIndex(([sql]) => typeof sql === 'string' && sql.includes('SELECT id FROM employer_job_templates'));
    expect(mockReadCompanyUsage.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[nameCheckAt]);
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  const NAME_KEY = 'employer_job_templates_employer_id_name_key';
  const failWrite = (write: string, dbError: Record<string, unknown>) => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes(write)) {
        return Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint'), dbError));
      }
      return Promise.resolve({});
    });
  };

  it.each([
    ['a create', {}, 'INSERT INTO employer_job_templates'],
    ['a rename', { id: TEMPLATE_ROW.id }, 'UPDATE employer_job_templates'],
  ])('answers 409 template_name_taken, and logs it, when %s loses a name race on the name key (23505)', async (_name, body, write) => {
    failWrite(write, { code: '23505', constraint: NAME_KEY });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await handler(makeEvent(body));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'template_name_taken' });
    expect(warn).toHaveBeenCalledWith('employer-templates-save: name race (23505)');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    warn.mockRestore();
  });

  it.each([
    ['another constraint', { code: '23505', constraint: 'employer_job_templates_pkey' }],
    ['no constraint name', { code: '23505' }],
  ])('keeps a 23505 on %s on the generic 500 path', async (_name, dbError) => {
    failWrite('INSERT INTO employer_job_templates', dbError);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await handler(makeEvent({}));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(warn).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    warn.mockRestore();
    error.mockRestore();
  });

  it('answers 403 membership_inactive and rolls back when the company lock refuses the caller', async () => {
    mockReadCompanyUsage.mockRejectedValue(new CompanyUsageRefusedError());

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('returns 500 and rolls back when the usage read is for another company than the actor\'s', async () => {
    mockReadCompanyUsage.mockResolvedValue({ ...companyUsage(0), organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });

  it('updates an owned template by id without a cap check (200)', async () => {
    mockQuery.mockImplementation((sql: string) => {
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
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90' }));

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for an unowned/unknown id', async () => {
    mockQuery.mockImplementation((sql: string) => {
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

  // ---------------------------------------------------------------------------
  // BE-T2 -- six new structured fields (077): old-shape template re-save
  // ---------------------------------------------------------------------------

  it("saves an old-shape template payload (trade_category='other' with NO trade_category_other, and no other BE-T2 keys) with 200/201 -- parseJobFields alone must keep old template re-saves working", async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, trade_category: 'other' } }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    expect(insertCall).toBeDefined();
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.trade_category).toBe('other');
    // parseJobFields gives these six keys as null unconditionally (same
    // treatment as expected_duration/shift_schedule above them) -- no
    // requiredness is enforced here, and no error is raised for the historic
    // 'other' rows that predate trade_category_other.
    expect(parsed.trade_category_other).toBeNull();
    expect(parsed.expected_duration_bucket).toBeNull();
    expect(parsed.work_days).toBeNull();
    expect(parsed.shift_start).toBeNull();
    expect(parsed.shift_end).toBeNull();
    expect(parsed.certification_requirements).toBeNull();
  });

  it('stores all six new fields when a fully-populated payload is saved as a template', async () => {
    const res = await handler(makeEvent({
      payload: {
        ...BASE_PAYLOAD,
        trade_category: 'other',
        trade_category_other: 'Scaffolding',
        expected_duration_bucket: '1_2w',
        work_days: ['mon', 'tue'],
        shift_start: '07:00',
        shift_end: '15:30',
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      },
    }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.trade_category_other).toBe('Scaffolding');
    expect(parsed.expected_duration_bucket).toBe('1_2w');
    expect(parsed.work_days).toEqual(['mon', 'tue']);
    expect(parsed.shift_start).toBe('07:00');
    expect(parsed.shift_end).toBe('15:30');
    expect(parsed.certification_requirements).toEqual([{ name: 'OSHA 30', tier: 'required', proof_required: true }]);
    // certifications is DERIVED from certification_requirements' names.
    expect(parsed.certifications).toEqual(['OSHA 30']);
  });

  it("rejects a trade_category_other sent for a non-'other' trade_category in a template payload", async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, trade_category_other: 'Scaffolding' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_trade_category_other');
  });

  it('rejects certification_requirements conflicting with required_docs certification_doc in a template payload', async () => {
    const res = await handler(makeEvent({
      payload: {
        ...BASE_PAYLOAD,
        required_docs: ['certification_doc'],
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      },
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_certification_requirements_doc_conflict');
  });
  // ---------------------------------------------------------------------------
  // B4 -- pre_application_prompts (091). The frontend has always SENT the key
  // (job-form.ts:478) and read it back (`jobToForm`), but the whitelist in
  // validateTemplatePayload never carried it, so a template saved with custom
  // questions silently lost them.
  // ---------------------------------------------------------------------------

  it('round-trips pre_application_prompts into the stored payload, preserving supplied ids verbatim', async () => {
    const res = await handler(makeEvent({
      payload: {
        ...BASE_PAYLOAD,
        pre_application_prompts: [
          { id: 'q-1', text: '  How many years pouring slabs?  ' },
          { id: 'q-2', text: 'Do you own your own tools?' },
        ],
      },
    }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    expect(insertCall).toBeDefined();
    const parsed = JSON.parse(insertCall[1][2]);
    // Ids are NEVER re-minted -- job_applications.prompt_answers is keyed on
    // them, so a template that seeds a job must carry the same ids through.
    expect(parsed.pre_application_prompts).toEqual([
      { id: 'q-1', text: 'How many years pouring slabs?' },
      { id: 'q-2', text: 'Do you own your own tools?' },
    ]);
  });

  it('mints an id for a prompt supplied as text only', async () => {
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, pre_application_prompts: [{ text: 'Own transportation?' }] },
    }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.pre_application_prompts).toHaveLength(1);
    expect(parsed.pre_application_prompts[0].text).toBe('Own transportation?');
    expect(parsed.pre_application_prompts[0].id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });

  it('keeps pre_application_prompts ABSENT when the payload omits it (no [] injection into a legacy template)', async () => {
    const res = await handler(makeEvent({ payload: BASE_PAYLOAD }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed).not.toHaveProperty('pre_application_prompts');
  });

  it('stores an explicitly empty prompt list as [] (the key was sent, so it is not absent)', async () => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, pre_application_prompts: [] } }));

    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    const parsed = JSON.parse(insertCall[1][2]);
    expect(parsed.pre_application_prompts).toEqual([]);
  });

  it.each([
    ['not an array', 'nope'],
    ['too many prompts', Array.from({ length: 11 }, (_, i) => ({ text: `q${i}` }))],
    ['a blank text', [{ text: '   ' }]],
    ['an over-long text', [{ text: 'a'.repeat(501) }]],
    ['a malformed id', [{ id: 'not a valid id!', text: 'q' }]],
    ['a duplicate id', [{ id: 'q-1', text: 'a' }, { id: 'q-1', text: 'b' }]],
    ['an extra key', [{ id: 'q-1', text: 'a', required: true }]],
  ])('rejects %s with 400 invalid_pre_application_prompts, exactly as employer-jobs-create does', async (_label, prompts) => {
    const res = await handler(makeEvent({ payload: { ...BASE_PAYLOAD, pre_application_prompts: prompts } }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_pre_application_prompts');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employer_job_templates'), expect.anything());
  });
  // ---------------------------------------------------------------------------
  // Sprint 24 follow-up -- "template -> job location not selected".
  //
  // employer-jobs-update.ts:302 recovers the city identity from the location
  // TEXT when no triple is sent (`cityFields.value ?? parseCityFromLocation`).
  // This handler did not, so a template saved from a degraded picker (or any
  // legacy template) stored location-only forever and every job created from
  // it landed with city_key = null -- invisible to every city filter and feed.
  // ---------------------------------------------------------------------------

  function storedPayload() {
    const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
    expect(insertCall).toBeDefined();
    return JSON.parse(insertCall[1][2]);
  }

  it('derives the city triple from a parseable location when the payload carries no triple', async () => {
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, location: 'Austin, TX' },
    }));

    expect(res.statusCode).toBe(201);
    // Same slug rule as slugCityKey / migration 061, so a job seeded from this
    // template keys identically to one posted directly.
    expect(storedPayload()).toMatchObject({
      city_key: 'austin-tx',
      city: 'Austin',
      state: 'TX',
    });
  });

  it('accepts the ZIP-suffixed form the SQL backfill also matches', async () => {
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, location: 'El Paso, TX 79901' },
    }));

    expect(res.statusCode).toBe(201);
    expect(storedPayload()).toMatchObject({ city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' });
  });

  it('stores NO triple at all when the location text cannot be parsed', async () => {
    // Never guess: a wrong city surfaces the job in the wrong feed. This is
    // the pre-fix behaviour, preserved exactly for free-text locations.
    const res = await handler(makeEvent({
      payload: { ...BASE_PAYLOAD, location: 'Remote / travel' },
    }));

    expect(res.statusCode).toBe(201);
    const parsed = storedPayload();
    expect(parsed).not.toHaveProperty('city_key');
    expect(parsed).not.toHaveProperty('city');
    expect(parsed).not.toHaveProperty('state');
    expect(parsed.location).toBe('Remote / travel');
  });

  it('lets an EXPLICIT triple win over the location text', async () => {
    // The picker is the authority when it worked: an employer who selected
    // Dallas for a job whose location line reads "Austin, TX" gets Dallas.
    const res = await handler(makeEvent({
      payload: {
        ...BASE_PAYLOAD,
        location: 'Austin, TX',
        city_key: 'dallas-tx',
        city: 'Dallas',
        state: 'TX',
      },
    }));

    expect(res.statusCode).toBe(201);
    expect(storedPayload()).toMatchObject({ city_key: 'dallas-tx', city: 'Dallas', state: 'TX' });
  });

  it('derives the triple on the UPDATE path too, not just create', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({
      id: '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90',
      payload: { ...BASE_PAYLOAD, location: 'Austin, TX' },
    }));

    expect(res.statusCode).toBe(200);
    const updateCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE employer_job_templates'));
    expect(JSON.parse(updateCall[1][1])).toMatchObject({ city_key: 'austin-tx', city: 'Austin', state: 'TX' });
  });

  describe('organization actor', () => {
    const TEMPLATE_ID = '3f6d3a2e-8c4b-4a1e-9d2f-1b5e6c7a8d90';

    it('creates as the actor and counts and limits the company under the company lock', async () => {
      mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));

      const res = await handler(makeEvent());

      expect(res.statusCode).toBe(201);
      expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'employer-sub');
      expect(mockCheckCompliance.mock.invocationCallOrder[0])
        .toBeLessThan(mockResolveEmployerActor.mock.invocationCallOrder[0]);
      expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.anything(), { lock: true });
      expect(mockResolveEntitlements).toHaveBeenCalledWith(expect.anything(), ORG_ID);
      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO employer_job_templates'));
      expect(insertCall[1][0]).toBe(EMPLOYER_ID);
      expect(mockQuery.mock.calls.some(([sql]) => typeof sql === 'string' && /FROM users|COUNT\(\*\)/.test(sql))).toBe(false);
    });

    it("lets the owner's scope reach a member's template on the update path, checking names within that template's employer", async () => {
      mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM employer_job_templates')) return Promise.resolve({ rowCount: 0, rows: [] });
        if (sql.includes('UPDATE employer_job_templates')) return Promise.resolve({ rowCount: 1, rows: [TEMPLATE_ROW] });
        return Promise.resolve({});
      });

      const res = await handler(makeEvent({ id: TEMPLATE_ID }));

      expect(res.statusCode).toBe(200);
      const conflict = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('SELECT id FROM employer_job_templates'));
      expect(conflict[0]).toContain('employer_id = ANY($1::uuid[])');
      expect(conflict[0]).toContain('$4::uuid');
      expect(conflict[1]).toEqual([[EMPLOYER_ID, FOREMAN_ID], 'Concrete crew', TEMPLATE_ID, EMPLOYER_ID]);
      const update = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE employer_job_templates'));
      expect(update[0]).toContain('employer_id = ANY($4::uuid[])');
      expect(update[1][0]).toBe('Concrete crew');
      expect(update[1][2]).toBe(TEMPLATE_ID);
      expect(update[1][3]).toEqual([EMPLOYER_ID, FOREMAN_ID]);
      expect(mockResolveEntitlements).not.toHaveBeenCalled();
      // One lock for every template write; an update checks no limit.
      expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.anything(), { lock: true });
    });

    it('returns the actor failure, rolls back, and runs no template query when the membership is inactive', async () => {
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });

      const res = await handler(makeEvent());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
      expect(mockQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('employer_job_templates'))).toBe(false);
      expect(mockResolveEntitlements).not.toHaveBeenCalled();
    });
  });
});
