import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-applicants';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

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
});
