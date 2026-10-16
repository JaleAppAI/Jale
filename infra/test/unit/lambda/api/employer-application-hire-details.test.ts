/**
 * employer-application-hire-details.test.ts -- F19 (sprint 28, contract K4.2):
 * `PUT /employer/jobs/{jobId}/applicants/{workerId}/hire-details`.
 *
 * The write itself is `jale_cap.employer_save_hire_details` (migration 125),
 * whose ownership and status rules the 125 DB suite proves on a real
 * database. This file pins the handler: validation before the pool, the
 * outcome mapping, and the one WhatsApp line that follows a changed save,
 * which can never fail the save.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  buildHireDetailsNotice,
  handler,
  parseHireDetailsInput,
} from '../../../../lambda/api/employer-application-hire-details';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { loadStageRecipient } from '../../../../lambda/lib/employer-worker-lane';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/employer-worker-lane', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-worker-lane'),
  loadStageRecipient: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternal = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockRecipient = loadStageRecipient as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const EMPLOYER_ID = '44444444-4444-4444-8444-444444444444';
const SAVED_AT = new Date('2026-10-14T12:00:00.000Z');

const INPUT = {
  start_date: '2026-10-20',
  report_location: 'Gate 3, North lot',
  contact_name: 'Site lead',
  contact_phone: '+1 555 0100',
  notes: null,
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'PUT',
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: JOB_ID, workerId: WORKER_ID, action: 'hire-details' },
    body: JSON.stringify(INPUT),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'saved',
    application_id: APP_ID,
    changed: true,
    start_date: '2026-10-20',
    report_location: 'Gate 3, North lot',
    contact_name: 'Site lead',
    contact_phone: '+1 555 0100',
    notes: null,
    updated_at: SAVED_AT,
    ...overrides,
  };
}

let saveResult: Record<string, unknown> = savedRow();
let noticeOutcome: unknown = { rows: [{ outcome: 'queued' }] };

function defaultQuery(sql: string) {
  if (/SELECT id FROM users WHERE cognito_sub/.test(sql)) return { rows: [{ id: EMPLOYER_ID }] };
  if (/jale_cap\.employer_save_hire_details/.test(sql)) return { rows: [saveResult] };
  if (/SELECT title FROM jobs/.test(sql)) return { rows: [{ title: 'Glazier' }] };
  if (/jale_cap\.employer_hire_details_notice/.test(sql)) {
    if (noticeOutcome instanceof Error) throw noticeOutcome;
    return noticeOutcome;
  }
  return { rows: [], rowCount: 0 };
}

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));

describe('employer-application-hire-details', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', FRONTEND_BASE_URL: 'https://app.example.test' };
    saveResult = savedRow();
    noticeOutcome = { rows: [{ outcome: 'queued' }] };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockQuery.mockImplementation(async (sql: string) => defaultQuery(sql));
    mockSetRlsContext.mockResolvedValue(undefined);
    mockSetInternal.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockRecipient.mockResolvedValue({ workerId: WORKER_ID, language: 'es', hasWhatsappNumber: true });
  });

  afterAll(() => { process.env = env; });

  // ── Before the pool ────────────────────────────────────────────────

  it('401s without a caller', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as never));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each([
    ['job', { jobId: 'nope', workerId: WORKER_ID, action: 'hire-details' }],
    ['worker', { jobId: JOB_ID, workerId: 'nope', action: 'hire-details' }],
  ])('404s a malformed %s id without a round trip', async (_label, pathParameters) => {
    const res = await handler(makeEvent({ pathParameters }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('405s anything but PUT', async () => {
    const res = await handler(makeEvent({ httpMethod: 'POST' }));
    expect(res.statusCode).toBe(405);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('400s an unreadable body with no field named', async () => {
    const res = await handler(makeEvent({ body: '{' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_hire_details', fields: [] });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('400s every invalid field at once, by name, before the pool', async () => {
    const res = await handler(makeEvent({
      body: JSON.stringify({
        start_date: '2026-02-30',
        report_location: 'x'.repeat(201),
        contact_name: 'y'.repeat(81),
        contact_phone: 'call me',
        notes: 42,
      }),
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_hire_details',
      fields: ['start_date', 'report_location', 'contact_name', 'contact_phone', 'notes'],
    });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  // ── The save ───────────────────────────────────────────────────────

  it('saves through the definer as the employer and answers the saved details', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      hire_details: {
        start_date: '2026-10-20',
        report_location: 'Gate 3, North lot',
        contact_name: 'Site lead',
        contact_phone: '+1 555 0100',
        notes: null,
        updated_at: '2026-10-14T12:00:00.000Z',
      },
    });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'e-sub');
    expect(mockSetInternal).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);
    const save = mockQuery.mock.calls.find(([sql]) => /employer_save_hire_details/.test(String(sql)));
    expect(save?.[1]).toEqual([JOB_ID, WORKER_ID, '2026-10-20', 'Gate 3, North lot', 'Site lead', '+1 555 0100', null]);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('answers hire_details null when the save left every field empty, exactly as the reads do', async () => {
    saveResult = savedRow({ changed: true, start_date: null, report_location: null, contact_name: null,
      contact_phone: null, notes: null });
    const res = await handler(makeEvent({ body: JSON.stringify({
      start_date: null, report_location: null, contact_name: null, contact_phone: null, notes: null,
    }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hire_details: null });
    // Nothing to tell the worker about.
    expect(mockRecipient).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => /employer_hire_details_notice/.test(sql))).toBe(false);
  });

  it.each([
    ['not_found', 404],
    ['not_hired', 409],
  ])('maps %s to %i and rolls back', async (outcome, status) => {
    saveResult = { outcome, application_id: null, changed: false };
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error: outcome });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
  });

  it('403s an employer who has not accepted the terms', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'legal_required' });
    expect(sqlCalls().some((sql) => /employer_save_hire_details/.test(sql))).toBe(false);
  });

  // ── The details-added line ─────────────────────────────────────────

  it('sends the worker one line in their language when the save changed something', async () => {
    await handler(makeEvent());

    const notice = mockQuery.mock.calls.find(([sql]) => /employer_hire_details_notice/.test(String(sql)));
    expect(notice?.[1]).toEqual([
      APP_ID,
      buildHireDetailsNotice('es', { jobTitle: 'Glazier', url: `https://app.example.test/es/worker/applications/${APP_ID}` }),
    ]);
    // In its own savepoint, so a refusal can never take the save with it.
    const calls = sqlCalls();
    const savepoint = calls.findIndex((sql) => /^SAVEPOINT hire_details_notice$/.test(sql));
    const noticeAt = calls.findIndex((sql) => /employer_hire_details_notice/.test(sql));
    expect(savepoint).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(savepoint);
    expect(calls).toContain('RELEASE SAVEPOINT hire_details_notice');
  });

  it('sends nothing when the save changed nothing (a re-save is not news)', async () => {
    saveResult = savedRow({ changed: false });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockRecipient).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => /employer_hire_details_notice/.test(sql))).toBe(false);
  });

  it('sends nothing to a worker with no WhatsApp number', async () => {
    mockRecipient.mockResolvedValue({ workerId: WORKER_ID, language: 'en', hasWhatsappNumber: false });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(sqlCalls().some((sql) => /employer_hire_details_notice/.test(sql))).toBe(false);
  });

  it('keeps the save when the line fails, rolling back only its savepoint', async () => {
    noticeOutcome = new Error('boom');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hire_details.report_location).toBe('Gate 3, North lot');
    const calls = sqlCalls();
    expect(calls).toContain('ROLLBACK TO SAVEPOINT hire_details_notice');
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  it('never re-sends the hire celebration', async () => {
    await handler(makeEvent());
    expect(sqlCalls().some((sql) => /employer_claim_worker_intent|application_stage/.test(sql))).toBe(false);
  });
});

describe('parseHireDetailsInput', () => {
  it('trims, turns blanks into null and keeps unknown keys out', () => {
    expect(parseHireDetailsInput({
      start_date: ' 2026-10-20 ', report_location: '  Gate 3 ', contact_name: '', contact_phone: null,
      extra: 'ignored',
    })).toEqual({
      ok: true,
      value: { start_date: '2026-10-20', report_location: 'Gate 3', contact_name: null, contact_phone: null, notes: null },
    });
  });

  it('measures lengths in characters, the way the database CHECKs do', () => {
    expect(parseHireDetailsInput({ report_location: 'ñ'.repeat(200) })).toMatchObject({ ok: true });
    expect(parseHireDetailsInput({ report_location: '😀'.repeat(200) })).toMatchObject({ ok: true });
    expect(parseHireDetailsInput({ report_location: '😀'.repeat(201) })).toEqual({ ok: false, fields: ['report_location'] });
  });

  it.each([
    ['2026-13-01'], ['2026-1-1'], ['20261020'], ['2026-02-29'], ['tomorrow'],
  ])('refuses the start date %s', (start) => {
    expect(parseHireDetailsInput({ start_date: start })).toEqual({ ok: false, fields: ['start_date'] });
  });

  it('accepts a leap day', () => {
    expect(parseHireDetailsInput({ start_date: '2028-02-29' })).toMatchObject({ ok: true });
  });

  it('allows digits, spaces, + ( ) - in a phone, up to 32', () => {
    expect(parseHireDetailsInput({ contact_phone: '+1 (555) 010-0000' })).toMatchObject({ ok: true });
    expect(parseHireDetailsInput({ contact_phone: '5'.repeat(33) })).toEqual({ ok: false, fields: ['contact_phone'] });
    expect(parseHireDetailsInput({ contact_phone: '555.0100' })).toEqual({ ok: false, fields: ['contact_phone'] });
  });

  it('refuses a NUL anywhere, which the database would refuse as a 500', () => {
    expect(parseHireDetailsInput({ notes: 'a\u0000b' })).toEqual({ ok: false, fields: ['notes'] });
  });

  it('refuses a body that is not an object', () => {
    expect(parseHireDetailsInput(null)).toEqual({ ok: false, fields: [] });
    expect(parseHireDetailsInput([])).toEqual({ ok: false, fields: [] });
  });
});

describe('buildHireDetailsNotice', () => {
  it('names the job and links the application, in English and Spanish', () => {
    const url = `https://app.example.test/en/worker/applications/${APP_ID}`;
    expect(buildHireDetailsNotice('en', { jobTitle: 'Glazier', url }))
      .toBe(`Your employer added your start details for Glazier. See them here: ${url}`);
    expect(buildHireDetailsNotice('es', { jobTitle: 'Glazier', url }))
      .toBe(`Tu empleador agrego los detalles de inicio para Glazier. Velos aqui: ${url}`);
  });

  it('is ASCII in Spanish, like every other worker line', () => {
    expect(buildHireDetailsNotice('es', { jobTitle: 'Glazier', url: 'u' })).toMatch(/^[\x20-\x7e]+$/);
  });
});
