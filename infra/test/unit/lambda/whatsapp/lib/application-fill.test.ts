// infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts
//
// Verifies computeNextStep — the DB-derived progress engine for the
// WhatsApp application-fill flow. All DB access goes through a single
// mocked `client.query`, matched by call order / SQL shape, following
// conversation-router.test.ts's conventions.
//
// job-fields.ts (DOC_TYPES / REQUIRED_FIELD_TYPES) is left UNMOCKED
// intentionally: it is pure data, no I/O.
//
// ../../lib/db is mocked because worker_documents is a FORCE ROW LEVEL
// SECURITY table (005_document_vault.sql) whose SELECT policy requires
// app.current_internal_user_id to be set to the worker's id first —
// computeNextStep must call setInternalUserRlsContext before querying it.

const mockQuery = jest.fn();
const client: any = { query: mockQuery };

jest.mock('../../../../../lambda/lib/db', () => ({
  setInternalUserRlsContext: jest.fn(),
}));

import { computeNextStep } from '../../../../../lambda/whatsapp/lib/application-fill';
import { setInternalUserRlsContext } from '../../../../../lambda/lib/db';

const APPLICATION_ID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const WORKER_ID = 'bbbbbbbb-0000-0000-0000-00000000000b';
const JOB_ID = 'cccccccc-0000-0000-0000-00000000000c';

// Builds a row shaped like the first SELECT's result (job_applications JOIN
// jobs). Callers override only the fields the test cares about.
function appRow(overrides: Partial<{
  job_status: string;
  application_status: string;
  required_fields: string[];
  required_docs: string[];
  application_answers: Record<string, unknown>;
  worker_id: string;
  job_id: string;
}> = {}) {
  return {
    job_status: 'active',
    application_status: 'pending',
    required_fields: [],
    required_docs: [],
    application_answers: {},
    worker_id: WORKER_ID,
    job_id: JOB_ID,
    ...overrides,
  };
}

function mockAppRow(row: ReturnType<typeof appRow>) {
  mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
}

function mockDocRows(docTypes: string[]) {
  mockQuery.mockResolvedValueOnce({
    rows: docTypes.map((doc_type) => ({ doc_type })),
    rowCount: docTypes.length,
  });
}

describe('computeNextStep', () => {
  beforeEach(() => jest.clearAllMocks());

  it('walks required_fields in array order, skipping answered keys', async () => {
    mockAppRow(appRow({
      required_fields: ['work_authorization', 'date_available', 'desired_pay'],
      application_answers: { work_authorization: true },
    }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'field', key: 'date_available', uncollectable: [] });
    // Only the application/job SELECT ran — the docs query never fires
    // while an unanswered field remains.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fields before docs: an unanswered field wins even when a required doc is also missing', async () => {
    mockAppRow(appRow({
      required_fields: ['work_authorization'],
      application_answers: {},
      required_docs: ['resume'],
    }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'field', key: 'work_authorization', uncollectable: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('docs walk in required_docs array order, skipping present doc rows', async () => {
    mockAppRow(appRow({
      required_fields: [],
      required_docs: ['resume', 'driver_license', 'work_auth_doc'],
    }));
    mockDocRows(['resume']);

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'doc', docType: 'driver_license', uncollectable: [] });
  });

  it('a doc uploaded via web mid-flow is skipped (presence diff)', async () => {
    // The doc-presence query itself filters on (job_id IS NULL OR job_id =
    // $2), so a web-vault upload (job_id NULL) surfaces here exactly like a
    // per-job upload: it just shows up as a present doc_type row.
    mockAppRow(appRow({
      required_fields: [],
      required_docs: ['resume', 'driver_license'],
    }));
    mockDocRows(['resume']); // uploaded via web, no job tie

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'doc', docType: 'driver_license', uncollectable: [] });
  });

  it('the doc-presence query matches worker_id and (job_id IS NULL OR job_id = $2)', async () => {
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] }));
    mockDocRows([]);

    await computeNextStep(client, APPLICATION_ID);

    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/worker_id\s*=\s*\$1/);
    expect(sql).toMatch(/\(job_id IS NULL OR job_id = \$2\)/);
    expect(params).toEqual([WORKER_ID, JOB_ID]);
  });

  it('sets the worker_documents RLS context before querying it', async () => {
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] }));
    mockDocRows([]);

    await computeNextStep(client, APPLICATION_ID);

    expect(setInternalUserRlsContext).toHaveBeenCalledWith(client, WORKER_ID);
    // Call-order: the RLS context must be set before the worker_documents
    // query fires, or its FORCE ROW LEVEL SECURITY policy silently returns
    // zero rows and every required doc reads as missing forever.
    const rlsCallOrder = (setInternalUserRlsContext as jest.Mock).mock.invocationCallOrder[0];
    const docsQueryCallOrder = mockQuery.mock.invocationCallOrder[1];
    expect(rlsCallOrder).toBeLessThan(docsQueryCallOrder);
  });

  it('does not set the worker_documents RLS context when the walk ends on a field step', async () => {
    mockAppRow(appRow({
      required_fields: ['work_authorization'],
      application_answers: {},
    }));

    await computeNextStep(client, APPLICATION_ID);

    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('ssn is excluded from the walk and reported in uncollectable', async () => {
    mockAppRow(appRow({
      required_fields: [],
      required_docs: ['ssn', 'resume'],
    }));
    mockDocRows([]);

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'doc', docType: 'resume', uncollectable: ['ssn'] });
  });

  it('complete when only uncollectable items remain', async () => {
    mockAppRow(appRow({
      required_fields: [],
      required_docs: ['ssn'],
    }));
    mockDocRows([]);

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'complete', uncollectable: ['ssn'] });
  });

  it('exit application_gone when the application row is missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'exit', reason: 'application_gone', uncollectable: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['filled', 'closed'])('exit job_inactive when job status is %s', async (job_status) => {
    mockAppRow(appRow({ job_status, required_docs: ['ssn'] }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'exit', reason: 'job_inactive', uncollectable: ['ssn'] });
    // No field/doc queries once the job is inactive.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['hired', 'not_interested'])(
    'exit application_closed when application status is %s',
    async (application_status) => {
      mockAppRow(appRow({ application_status, required_docs: ['ssn'] }));

      const result = await computeNextStep(client, APPLICATION_ID);

      expect(result).toEqual({ kind: 'exit', reason: 'application_closed', uncollectable: ['ssn'] });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['contacted', 'talking'])(
    'continues (does not exit) when application status is %s',
    async (application_status) => {
      mockAppRow(appRow({
        application_status,
        required_fields: [],
        required_docs: [],
      }));
      mockDocRows([]);

      const result = await computeNextStep(client, APPLICATION_ID);

      expect(result).toEqual({ kind: 'complete', uncollectable: [] });
    },
  );

  it('continues (does not exit) when job status is paused (spec §9: active AND paused continue)', async () => {
    mockAppRow(appRow({
      job_status: 'paused',
      required_fields: [],
      required_docs: [],
    }));
    mockDocRows([]);

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'complete', uncollectable: [] });
  });

  it('a key added to required_fields mid-fill becomes the next step (requirements widening)', async () => {
    // Originally required_fields was ['work_authorization', 'desired_pay']
    // and both were answered. The employer then widened required_fields to
    // insert 'date_available' in the middle — unanswered, mid-array, with
    // an ALREADY-answered key after it. The array-order walk must surface
    // it regardless of what comes later in the array.
    mockAppRow(appRow({
      required_fields: ['work_authorization', 'date_available', 'desired_pay'],
      application_answers: { work_authorization: true, desired_pay: '25/hour' },
    }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'field', key: 'date_available', uncollectable: [] });
  });

  it('a stored false answer counts as answered (hasOwnProperty, not truthiness)', async () => {
    mockAppRow(appRow({
      required_fields: ['worked_here_before', 'education'],
      application_answers: { worked_here_before: false },
    }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'field', key: 'education', uncollectable: [] });
  });

  it('a stored null answer counts as answered (hasOwnProperty, not truthiness)', async () => {
    mockAppRow(appRow({
      required_fields: ['worked_here_before', 'education'],
      application_answers: { worked_here_before: null },
    }));

    const result = await computeNextStep(client, APPLICATION_ID);

    expect(result).toEqual({ kind: 'field', key: 'education', uncollectable: [] });
  });

  it('the application/job SELECT joins on ja.id = $1 with the applicationId param', async () => {
    mockAppRow(appRow());
    mockDocRows([]);

    await computeNextStep(client, APPLICATION_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM job_applications ja/);
    expect(sql).toMatch(/JOIN jobs j ON j\.id = ja\.job_id/);
    expect(sql).toMatch(/ja\.id = \$1/);
    expect(params).toEqual([APPLICATION_ID]);
  });
});
