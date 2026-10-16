import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-applicants';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import { callerFor, expectAttemptAfter, expectRecordedInsideTransaction, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const JOB_ID = '11111111-1111-4111-8111-111111111111';

const makeEvent = (queryStringParameters?: Record<string, string>, pathParameters: Record<string, string> = { jobId: JOB_ID }) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters,
  queryStringParameters,
} as unknown as APIGatewayProxyEvent);

describe('employer-job-applicants Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  it('returns 400 when jobId is not a valid UUID', async () => {
    const res = await handler(makeEvent(undefined, { jobId: 'not-a-uuid' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_job_id');
  });

  it('reads ordered skills from worker_skills instead of worker_profiles.skills', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rowCount: 1 }) // job ownership
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const applicantQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(applicantQuery).toContain('FROM worker_skills ws');
    expect(applicantQuery).toContain('WHERE ws.worker_id = ja.worker_id');
    expect(applicantQuery).not.toContain('wp.skills');
  });

  it('filters skills with normalized worker_skills values', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rowCount: 1 }) // job ownership
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ skills: ' Welding, CARPENTRY ,, ' }));

    expect(res.statusCode).toBe(200);
    const applicantCall = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'));
    expect(applicantCall?.[0]).toContain('EXISTS (');
    expect(applicantCall?.[0]).toContain('ws.skill = ANY');
    expect(applicantCall?.[1]).toContainEqual(['welding', 'carpentry']);
  });

  it('includes application_answers and a not_provided list of skipped optional fields/docs per applicant', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({
        rows: [{ id: JOB_ID, optional_fields: ['date_available'], optional_docs: ['driver_license'] }],
        rowCount: 1,
      }) // job ownership -- now also carries optional_fields/optional_docs
      .mockResolvedValueOnce({
        rows: [{
          application_id: 'app-1',
          worker_id: 'worker-1',
          full_name: 'Jane Doe',
          phone: '555-0100',
          status: 'pending',
          applied_at: 'ts',
          skills: [],
          availability: null,
          years_experience: null,
          location: null,
          application_answers: {},
          missing_optional_docs: ['driver_license'],
        }],
        rowCount: 1,
      }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.applicants).toHaveLength(1);
    const applicant = body.applicants[0];
    expect(applicant.application_answers).toEqual({});
    // date_available (optional_fields, unanswered) + driver_license (optional_docs, missing)
    expect(applicant.not_provided.sort()).toEqual(['date_available', 'driver_license']);
    expect(applicant.missing_optional_docs).toBeUndefined();

    const applicantQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(applicantQuery).toContain('ja.application_answers');
  });

  it('counts an optional document as provided only when it is attached to this job, never a vault-only copy', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID, optional_fields: [], optional_docs: ['resume'] }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    expect((await handler(makeEvent())).statusCode).toBe(200);

    const applicantQuery = String(
      mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0],
    );
    const missingDocs = applicantQuery.slice(0, applicantQuery.indexOf('AS missing_optional_docs'));
    const coverage = missingDocs.slice(missingDocs.lastIndexOf('FROM worker_documents wd'));
    expect(coverage).toContain('AND wd.job_id = ja.job_id');
    expect(coverage).not.toMatch(/job_id\s+IS\s+NULL/i);
  });

  it('reports an empty not_provided when the applicant answered every optional field and has every optional doc', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({
        rows: [{ id: JOB_ID, optional_fields: ['date_available'], optional_docs: [] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          application_id: 'app-1',
          worker_id: 'worker-1',
          full_name: 'Jane Doe',
          phone: '555-0100',
          status: 'pending',
          applied_at: 'ts',
          skills: [],
          availability: null,
          years_experience: null,
          location: null,
          application_answers: { date_available: '2026-09-01' },
          missing_optional_docs: [],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.applicants[0].not_provided).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Application stages (091)
  // ---------------------------------------------------------------------------

  describe('application stages (091)', () => {
    const JOB_ROW = {
      id: JOB_ID,
      optional_fields: [],
      optional_docs: [],
      required_fields: ['years_experience'],
      required_docs: ['resume'],
      certification_requirements: null,
      pre_application_prompts: [{ id: 'p1', text: 'Do you own tools?' }, { id: 'p2', text: '¿Transporte?' }],
    };
    const APPLICANT_ROW = {
      application_id: 'app-1',
      worker_id: 'worker-1',
      full_name: 'Jane Doe',
      phone: '555-0100',
      status: 'pending',
      applied_at: 'ts',
      skills: [],
      availability: null,
      years_experience: null,
      location: null,
      application_answers: {},
      prompt_answers: {},
      details_requested_at: null,
      details_completed_at: null,
      have_docs: [],
      missing_optional_docs: [],
    };

    function mockRun(job: Record<string, unknown> = {}, applicants: Array<Record<string, unknown>> = [{}]) {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rows: [{ ...JOB_ROW, ...job }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: applicants.map((over) => ({ ...APPLICANT_ROW, ...over })),
          rowCount: applicants.length,
        })
        .mockResolvedValueOnce({}); // COMMIT
    }

    const applicantSql = () =>
      mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications ja'))?.[0] as string;
    const jobSql = () =>
      mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs WHERE id ='))?.[0] as string;

    it('selects the stage columns and a JOB-SCOPED have_docs, and the job requirement columns once', async () => {
      mockRun();
      expect((await handler(makeEvent())).statusCode).toBe(200);

      const sql = applicantSql();
      expect(sql).toContain('ja.prompt_answers');
      expect(sql).toContain('ja.details_requested_at');
      expect(sql).toContain('ja.details_completed_at');
      // Job-scoped: the vault (`job_id IS NULL`) does NOT count, matching
      // what 091's hire gate measures. missing_optional_docs has the same
      // scope (see the not_provided tests above).
      expect(sql).toContain('WHERE wd.worker_id = ja.worker_id');
      expect(sql).toContain('AND wd.job_id = ja.job_id');
      expect(sql).toContain('AS have_docs');

      // The job's requirement columns come from the ownership SELECT (one
      // row for the whole page), never re-joined per applicant.
      const job = jobSql();
      expect(job).toContain('required_fields');
      expect(job).toContain('certification_requirements');
      expect(job).toContain('pre_application_prompts');
    });

    it('returns the parsed prompt list alongside applicants/total', async () => {
      mockRun();
      const body = JSON.parse((await handler(makeEvent())).body);
      expect(body.pre_application_prompts).toEqual([
        { id: 'p1', text: 'Do you own tools?' }, { id: 'p2', text: '¿Transporte?' },
      ]);
      expect(body.total).toBe(1);
    });

    it('reports not_requested/apply with everything outstanding before the employer asks', async () => {
      mockRun();
      const applicant = JSON.parse((await handler(makeEvent())).body).applicants[0];
      expect(applicant.details_status).toBe('not_requested');
      expect(applicant.stage).toBe('apply');
      expect(applicant.details_requested_at).toBeNull();
      expect(applicant.details_completed_at).toBeNull();
      expect(applicant.remaining).toEqual({
        prompts: ['p1', 'p2'],
        fields: ['years_experience'],
        certifications: { unclaimed: [], unproven: [] },
        docs: ['resume'],
        counts: { prompts: 2, fields: 1, certifications: 0, docs: 1 },
        complete: false,
      });
      // The three buckets no read endpoint publishes.
      expect(applicant.remaining.uncollectableDocs).toBeUndefined();
      expect(applicant.remaining.optionalFields).toBeUndefined();
      expect(applicant.remaining.optionalDocs).toBeUndefined();
    });

    it('reports requested/details once details_requested_at is set', async () => {
      mockRun({}, [{
        status: 'details_requested',
        prompt_answers: { p1: 'Yes', p2: 'Sí' },
        details_requested_at: '2026-09-01T00:00:00Z',
        have_docs: ['resume'],
      }]);
      const applicant = JSON.parse((await handler(makeEvent())).body).applicants[0];
      // The status CASE remap is unchanged and details_requested passes through.
      expect(applicant.status).toBe('details_requested');
      expect(applicant.details_status).toBe('requested');
      expect(applicant.stage).toBe('details');
      expect(applicant.remaining.fields).toEqual(['years_experience']);
      expect(applicant.remaining.docs).toEqual([]);
    });

    it('reports complete once nothing is outstanding, before details_completed_at flips', async () => {
      mockRun({}, [{
        application_answers: { years_experience: 4 },
        prompt_answers: { p1: 'Yes', p2: 'Sí' },
        details_requested_at: '2026-09-01T00:00:00Z',
        have_docs: ['resume'],
      }]);
      const applicant = JSON.parse((await handler(makeEvent())).body).applicants[0];
      expect(applicant.details_status).toBe('complete');
      expect(applicant.remaining.complete).toBe(true);
    });

    it('joins prompt answers to their questions in prompt order, orphans last', async () => {
      mockRun({}, [{ prompt_answers: { deleted: 'Old', p2: 'Sí', p1: 'Yes' } }]);
      const applicant = JSON.parse((await handler(makeEvent())).body).applicants[0];
      expect(applicant.prompt_answers).toEqual([
        { prompt_id: 'p1', question: 'Do you own tools?', text: 'Yes' },
        { prompt_id: 'p2', question: '¿Transporte?', text: 'Sí' },
        { prompt_id: 'deleted', question: null, text: 'Old' },
      ]);
    });

    // F19 (K4.2): the start details the employer saved for a hire, and
    // whether a hire still needs them.
    it('publishes hire_details and hire_details_needed, and strips the raw hire columns', async () => {
      mockRun({}, [
        { application_id: 'hired-with', status: 'hired', hire_start_date: '2026-10-20', hire_report_location: 'Gate 3',
          hire_contact_name: null, hire_contact_phone: null, hire_notes: null,
          hire_details_updated_at: new Date('2026-10-14T12:00:00.000Z') },
        { application_id: 'hired-without', status: 'hired' },
        { application_id: 'talking', status: 'talking' },
      ]);
      const applicants = JSON.parse((await handler(makeEvent())).body).applicants;
      expect(applicants.map((a: any) => [a.application_id, a.hire_details, a.hire_details_needed])).toEqual([
        ['hired-with', { start_date: '2026-10-20', report_location: 'Gate 3', contact_name: null, contact_phone: null,
          notes: null, updated_at: '2026-10-14T12:00:00.000Z' }, false],
        ['hired-without', null, true],
        ['talking', null, false],
      ]);
      for (const applicant of applicants) {
        for (const raw of ['hire_start_date', 'hire_report_location', 'hire_contact_name', 'hire_contact_phone', 'hire_notes',
          'hire_details_updated_at']) {
          expect(Object.prototype.hasOwnProperty.call(applicant, raw)).toBe(false);
        }
      }
      expect(applicantSql()).toContain("to_char(ja.hire_start_date, 'YYYY-MM-DD') AS hire_start_date");
    });

    it('drops the internal have_docs helper column from the response', async () => {
      mockRun({}, [{ have_docs: ['resume'] }]);
      const applicant = JSON.parse((await handler(makeEvent())).body).applicants[0];
      expect(applicant.have_docs).toBeUndefined();
      expect(applicant.missing_optional_docs).toBeUndefined();
    });
  });

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const employer = callerFor('employer', 'employer-id');
    const client = expect.objectContaining({ query: mockQuery });
    const row = (n: number) => ({
      application_id: `app-${n}`, worker_id: `worker-${n % 2}`, full_name: 'Fixture Name', phone: 'fixture-phone',
      status: 'pending', applied_at: '2026-10-01T00:00:00.000Z', application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null, skills: [], availability: null,
      years_experience: null, location: null, missing_optional_docs: [], have_docs: [],
    });

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
    });

    it('records every listed applicant before COMMIT; the helper splits long lists', async () => {
      const rows = [row(1), row(2), row(3)];
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: JOB_ID }] }) // job ownership
        .mockResolvedValueOnce({ rows, rowCount: rows.length }) // applicants
        .mockResolvedValueOnce({}); // COMMIT
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      const { applicants } = JSON.parse(res.body);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.job_applicants',
        subjectUserIds: ['worker-1', 'worker-0', 'worker-1'],
        recordIds: ['app-1', 'app-2', 'app-3'],
        resultCount: 3,
        fieldNames: Object.keys(applicants[0]).sort(),
        purpose: { kind: 'job', id: JOB_ID },
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /FROM job_applications ja/);
    });

    it('answers 500 with no applicants when the record cannot be written', async () => {
      mockQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: JOB_ID }] })
        .mockResolvedValueOnce({ rows: [row(1)], rowCount: 1 })
        .mockResolvedValue({});
      mockRecordAccess.mockRejectedValue(new Error('audit: the access record could not be written'));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockQuery.mock.calls.some(([q]) => q === 'COMMIT')).toBe(false);
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
        surface: 'employer.job_applicants', outcome: 'failed', purpose: { kind: 'job', id: JOB_ID },
      });
    });

    it('records a denied attempt after the 403 for another employer\'s job', async () => {
      mockQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValue({});
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(403);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'COMMIT');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.job_applicants', outcome: 'denied', purpose: { kind: 'job', id: JOB_ID },
      });
    });

    it('records nothing for an invalid status filter (400)', async () => {
      mockQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: JOB_ID }] })
        .mockResolvedValue({});
      const res = await handler(withRequestId(makeEvent({ status: 'nonsense' })));
      expect(res.statusCode).toBe(400);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expect(mockRecordAttempt).not.toHaveBeenCalled();
    });
  });
});
