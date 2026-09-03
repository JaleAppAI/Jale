import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-applications-list';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

describe('worker-applications-list', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 200 with applications including job_status, under the internal-id RLS context', async () => {
    const row = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'closed',
    };
    // 091 engine inputs -- selected, used, and STRIPPED from the response.
    const engineInputs = {
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    };
    const derived = {
      details_status: 'not_requested', stage: 'apply',
      details_requested_at: null, details_completed_at: null,
      remaining_count: 0,
      remaining: {
        prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
        counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
        complete: true,
      },
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ ...row, ...engineInputs }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ applications: [{ ...row, ...derived }] });

    // The 070 policy is keyed on app.current_internal_user_id — without this
    // call, closed jobs silently vanish from the list again.
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-internal-id');

    const listSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;
    // paused is a billing signal — never exposed to workers (spec).
    expect(listSql).toContain("CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status");
    // Company name comes from the 031 definer function; the users join is
    // gone (no RLS policy lets a worker read an employer's users row).
    expect(listSql).toContain('employer_display_name(j.employer_id) AS company_name');
    expect(listSql).not.toContain('JOIN users');
  });

  it('returns 409 when the internal-id lookup finds no user row', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalled();
  });

  describe('application stages (091)', () => {
    const BASE = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'active',
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    };

    async function row(over: Record<string, unknown> = {}) {
      mockQuery.mockImplementation((q: string) => {
        if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
        if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ ...BASE, ...over }] });
        return Promise.resolve({ rows: [] });
      });
      const res = await handler(ev);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).applications[0];
    }

    const listSql = () =>
      mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;

    it('selects the stage columns, the job requirements and a JOB-SCOPED have_docs, and keeps employer_display_name last', async () => {
      await row();
      const sql = listSql();
      expect(sql).toContain('a.prompt_answers');
      expect(sql).toContain('a.details_requested_at');
      expect(sql).toContain('a.details_completed_at');
      expect(sql).toContain('j.required_fields');
      expect(sql).toContain('j.certification_requirements');
      expect(sql).toContain('j.pre_application_prompts');
      expect(sql).toContain('AND wd.job_id = a.job_id');
      expect(sql).toContain('AS have_docs');
      // The 031 definer function flips a transaction-local employer_profiles
      // read flag until COMMIT -- this must stay the last query touching it.
      expect(sql).toContain('employer_display_name(j.employer_id) AS company_name');
      const after = mockQuery.mock.calls.slice(
        mockQuery.mock.calls.findIndex(([q]) => String(q).includes('employer_display_name')) + 1,
      );
      expect(after.every(([q]) => !String(q).includes('employer_profiles'))).toBe(true);
    });

    it('strips every raw engine input from the response rows', async () => {
      const r = await row({ application_answers: { a: 1 }, prompt_answers: { p1: 'x' }, have_docs: ['resume'] });
      for (const key of [
        'application_answers', 'prompt_answers', 'have_docs',
        'required_fields', 'optional_fields', 'required_docs', 'optional_docs',
        'certification_requirements', 'pre_application_prompts',
      ]) {
        expect(r[key]).toBeUndefined();
      }
    });

    it('reports requested with a remaining_count summing all four buckets', async () => {
      const r = await row({
        status: 'details_requested',
        details_requested_at: '2026-09-01T00:00:00Z',
        pre_application_prompts: [{ id: 'p1', text: 'A' }, { id: 'p2', text: 'B' }],
        prompt_answers: { p1: 'yes' },
        required_fields: ['work_authorization'],
        required_docs: ['resume'],
      });
      expect(r.details_status).toBe('requested');
      expect(r.stage).toBe('details');
      expect(r.details_requested_at).toBe('2026-09-01T00:00:00Z');
      // 1 prompt + 1 field + 0 certs + 1 doc
      expect(r.remaining_count).toBe(3);
      expect(r.remaining.counts).toEqual({ prompts: 1, fields: 1, certifications: 0, docs: 1 });
    });

    it('reports complete from details_completed_at', async () => {
      const r = await row({
        details_requested_at: '2026-09-01T00:00:00Z',
        details_completed_at: '2026-09-02T00:00:00Z',
        required_fields: ['work_authorization'],
      });
      expect(r.details_status).toBe('complete');
      expect(r.details_completed_at).toBe('2026-09-02T00:00:00Z');
      // remaining still reports the outstanding item; the timestamp wins.
      expect(r.remaining_count).toBe(1);
    });

    it('never promotes a not-yet-requested application to complete', async () => {
      const r = await row();
      expect(r.details_status).toBe('not_requested');
      expect(r.remaining.complete).toBe(true);
    });
  });
});
