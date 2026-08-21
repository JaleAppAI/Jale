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

// Real `validateApplicationAnswers` by default (pass-through wrapper) --
// only the merge-backstop test below overrides it for one call, to
// simulate a validator that (hypothetically, in the future) accepts a
// >8192-byte value; every other test exercises the genuine validator so
// e.g. string-trimming behavior is authentic, not asserted-by-mock.
jest.mock('../../../../../lambda/lib/application-answers', () => {
  const actual = jest.requireActual('../../../../../lambda/lib/application-answers');
  return { ...actual, validateApplicationAnswers: jest.fn(actual.validateApplicationAnswers) };
});

import {
  computeNextStep,
  handleFillMessage,
  promptNextStep,
  isFillCancel,
  parseFillConfirmation,
  type FillDeps,
  type FillContext,
  type FillPendingConfirm,
  type FillPendingEntryAnother,
} from '../../../../../lambda/whatsapp/lib/application-fill';
import { setInternalUserRlsContext } from '../../../../../lambda/lib/db';
import { validateApplicationAnswers } from '../../../../../lambda/lib/application-answers';
import type { IncomingMessage } from '../../../../../lambda/whatsapp/lib/conversation-router';
import type { ExtractionClient } from '../../../../../lambda/whatsapp/lib/application-fill-extraction';
import { fieldQuestion, fieldRetryHint, fillMessage } from '../../../../../lambda/whatsapp/lib/application-fill-prompts';

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

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage / promptNextStep / isFillCancel / parseFillConfirmation
// (Task 7). `validateApplicationAnswers` runs for REAL in every test below
// except the merge-backstop one -- string trimming, array-length caps, etc.
// are all genuine validator behavior, not asserted-by-mock.
// ─────────────────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'dddddddd-0000-0000-0000-00000000000d';
const FROM = 'whatsapp:+15550000000';
const NOW_MS = 1_700_000_000_000;
let sidCounter = 0;

function incomingMsg(body: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  sidCounter += 1;
  return {
    body,
    buttonPayload: undefined,
    interactivePayload: undefined,
    messageSid: `SMtest${sidCounter}`,
    from: FROM,
    numMedia: 0,
    mediaUrl: undefined,
    mediaSid: undefined,
    mediaContentType: undefined,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FillContext> = {}): FillContext {
  return {
    conversationId: CONVERSATION_ID,
    workerId: WORKER_ID,
    jobId: 'stale-job-id',
    lang: 'en',
    stateContext: { fill_application_id: APPLICATION_ID },
    ...overrides,
  };
}

function fakeExtraction(json: unknown): ExtractionClient {
  return { invoke: async () => JSON.stringify(json) };
}

function makeDeps(ctx: FillContext, overrides: Partial<FillDeps> = {}): FillDeps {
  return {
    extraction: fakeExtraction({}),
    queueReplyText: jest.fn(async () => {}),
    setRls: jest.fn(async () => {}),
    updateStateContext: jest.fn(async (_client: unknown, _conversationId: string, patch: Record<string, unknown>) => {
      Object.assign(ctx.stateContext, patch);
    }),
    nowMs: () => NOW_MS,
    ...overrides,
  };
}

function mockJobIdRow(jobId: string = JOB_ID) {
  mockQuery.mockResolvedValueOnce({ rows: [{ job_id: jobId }], rowCount: 1 });
}

function mockUpdateOk() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
}

function lastReply(deps: FillDeps): string {
  const calls = (deps.queueReplyText as jest.Mock).mock.calls;
  return calls[calls.length - 1][3];
}

describe('handleFillMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (validateApplicationAnswers as jest.Mock).mockImplementation(
      jest.requireActual('../../../../../lambda/lib/application-answers').validateApplicationAnswers,
    );
  });

  it('deterministic boolean: "1" stores true for work_authorization and prompts next step', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('1');

    mockJobIdRow();
    mockAppRow(appRow({
      required_fields: ['work_authorization', 'date_available'],
      application_answers: {},
    }));
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['work_authorization', 'date_available'],
      application_answers: { work_authorization: true },
    }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    // jobId is refreshed every turn (surfaced from the dedicated lookup),
    // even though nothing in Task 7 itself consumes it yet.
    expect(ctx.jobId).toBe(JOB_ID);

    const [updateSql, updateParams] = mockQuery.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE job_applications/);
    expect(updateSql).toMatch(/application_answers = application_answers \|\| \$1::jsonb/);
    expect(updateParams).toEqual([JSON.stringify({ work_authorization: true }), APPLICATION_ID]);

    expect(lastReply(deps)).toBe(fieldQuestion('date_available', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('date answer echoes long-form confirm via fill_pending (no immediate write)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('1990-04-03');

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['date_of_birth'], application_answers: {} }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(2); // jobId lookup + computeNextStep only -- no UPDATE
    expect(ctx.stateContext.fill_pending).toEqual({
      key: 'date_of_birth', stage: 'confirm', extracted: '1990-04-03',
    });
    const reply = lastReply(deps);
    expect(reply).toContain('April 3, 1990');
    expect(reply).toContain(fillMessage('confirm_footer', 'en'));
  });

  it('confirm "1 si" merges validated value: UPDATE ... application_answers || $1 and clears fill_pending', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'date_of_birth', stage: 'confirm', extracted: '1990-04-03' } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('1 si');

    mockJobIdRow();
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['date_of_birth', 'desired_pay'],
      application_answers: { date_of_birth: '1990-04-03' },
    }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    const [updateSql, updateParams] = mockQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE job_applications\s+SET application_answers = application_answers \|\| \$1::jsonb, updated_at = now\(\)\s+WHERE id = \$2/);
    expect(updateParams).toEqual([JSON.stringify({ date_of_birth: '1990-04-03' }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(lastReply(deps)).toBe(fieldQuestion('desired_pay', 'en'));
  });

  it('discard "2" clears fill_pending and re-asks with fieldRetryHint', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: {
          key: 'home_address', stage: 'confirm',
          extracted: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
        } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('2');

    mockJobIdRow();

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1); // jobId lookup only -- no write, no re-derive
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(lastReply(deps)).toBe(fieldRetryHint('home_address', 'en'));
  });

  it('unrecognized text while fill_pending re-echoes the confirmation (reconfirm message)', async () => {
    const originalPending = {
      key: 'home_address', stage: 'confirm',
      extracted: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
    } satisfies FillPendingConfirm;
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_pending: originalPending },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('maybe?');

    mockJobIdRow();

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateContext).not.toHaveBeenCalled(); // fill_pending is KEPT, not scrubbed
    expect(ctx.stateContext.fill_pending).toEqual(originalPending);
    expect(lastReply(deps)).toBe(fillMessage('reconfirm', 'en'));
  });

  it('extraction key: free text -> extractFieldAnswer -> fill_pending with summary echo', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({
        value: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
        confidence: { street: 0.9, city: 0.9, state: 0.9, zip: 0.9 },
      }),
    });
    const msg = incomingMsg('vivo en 1 Main St Kyle TX 78640');

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['home_address'], application_answers: {} }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(2); // jobId + computeNextStep -- no write yet
    expect(ctx.stateContext.fill_pending).toEqual({
      key: 'home_address',
      stage: 'confirm',
      extracted: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
      summaryVars: { address: '1 Main St, Kyle, TX 78640' },
    });
    const reply = lastReply(deps);
    expect(reply).toContain('1 Main St, Kyle, TX 78640');
    expect(reply).toContain(fillMessage('confirm_footer', 'en'));
  });

  it.each([
    ['low_confidence', fakeExtraction({ value: { level: 'high_school' }, confidence: { level: 0.2 } }), fieldRetryHint('education', 'en')],
    ['bedrock_error', { invoke: async () => { throw new Error('timeout'); } } as ExtractionClient, fillMessage('guard_error', 'en')],
  ])('%s re-prompts with the mapped message, nothing written', async (_label, extraction, expectedMessage) => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { extraction });
    const msg = incomingMsg('preparatoria');

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['education'], application_answers: {} }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(2); // no UPDATE
    expect(deps.updateStateContext).not.toHaveBeenCalled(); // nothing written, fill_pending untouched
    expect(lastReply(deps)).toBe(expectedMessage);
  });

  it('too_long re-prompts with the mapped message, nothing written (never calls Bedrock)', async () => {
    const ctx = makeCtx();
    const invoke = jest.fn();
    const deps = makeDeps(ctx, { extraction: { invoke } });
    const msg = incomingMsg('x'.repeat(2000));

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['education'], application_answers: {} }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('answer_too_long', 'en'));
  });

  it('array key entry confirm asks entry_another; "2 no" merges accumulated entries as one validated array', async () => {
    const oneReference = { name: 'Juan Perez', relationship: 'supervisor', phone: '555-123-4567' };
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'references', stage: 'confirm', extracted: oneReference, entries: [] } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);

    // Step A: confirm the single entry -> "add another?" prompt, no merge yet.
    mockJobIdRow();
    const resultA = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(resultA).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1); // jobId lookup only
    expect(ctx.stateContext.fill_pending).toEqual({
      key: 'references', stage: 'entry_another', entries: [oneReference],
    } satisfies FillPendingEntryAnother);
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));

    // Step B: "no more" -> validate + merge the WHOLE array once.
    mockJobIdRow();
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['references', 'military_service'],
      application_answers: { references: [oneReference] },
    }));

    const resultB = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(resultB).toEqual({ handled: true });
    const [updateSql, updateParams] = mockQuery.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE job_applications/);
    expect(updateParams).toEqual([JSON.stringify({ references: [oneReference] }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(lastReply(deps)).toBe(fieldQuestion('military_service', 'en'));
  });

  it('array key cap: confirming the 3rd entry auto-finalizes (merges the full 3-entry array), no entry_another offered', async () => {
    // Review fix (Finding 1): validateReferences/validateWorkHistory
    // (application-answers.ts) reject arrays >3 -- without a matching cap
    // here, a confirmed 4th entry would sit in fill_pending.entries only
    // for the whole-array validation to fail at finalize time, discarding
    // every already-confirmed entry. The 3rd CONFIRMED entry must
    // auto-finalize instead of offering "add another?".
    const e1 = { name: 'Ref One', relationship: 'supervisor', phone: '555-000-0001' };
    const e2 = { name: 'Ref Two', relationship: 'coworker', phone: '555-000-0002' };
    const e3 = { name: 'Ref Three', relationship: 'manager', phone: '555-000-0003' };
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'references', stage: 'confirm', extracted: e3, entries: [e1, e2] } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);

    mockJobIdRow();
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['references', 'military_service'],
      application_answers: { references: [e1, e2, e3] },
    }));

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    const [updateSql, updateParams] = mockQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE job_applications/);
    expect(updateParams).toEqual([JSON.stringify({ references: [e1, e2, e3] }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
    // Only ONE reply: the "merged, here's the next question" message --
    // entry_another is never offered once the cap is hit.
    expect((deps.queueReplyText as jest.Mock).mock.calls).toHaveLength(1);
    expect(lastReply(deps)).not.toBe(fillMessage('entry_another', 'en'));
    expect(lastReply(deps)).toBe(fieldQuestion('military_service', 'en'));
  });

  it('array key below cap: two entries + explicit "2 no" still finalizes with exactly those 2 entries', async () => {
    const e1 = { name: 'Ref One', relationship: 'supervisor', phone: '555-000-0001' };
    const e2 = { name: 'Ref Two', relationship: 'coworker', phone: '555-000-0002' };
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'references', stage: 'entry_another', entries: [e1, e2] } satisfies FillPendingEntryAnother,
      },
    });
    const deps = makeDeps(ctx);

    mockJobIdRow();
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['references', 'military_service'],
      application_answers: { references: [e1, e2] },
    }));

    const result = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = mockQuery.mock.calls[1];
    expect(updateParams).toEqual([JSON.stringify({ references: [e1, e2] }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
  });

  it('CANCELAR clears fill_application_id and fill_pending, sends canceled copy', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('  CanceLAR  ');

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).not.toHaveBeenCalled(); // no jobId lookup, no computeNextStep -- guard short-circuits first
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(lastReply(deps)).toBe(fillMessage('canceled', 'en'));
  });

  it('answers merge runs after deps.setRls and uses validated.value[key], never raw extraction', async () => {
    const rawExtracted = { street: '1 Main St', apartment: '  Unit 5  ', city: 'Kyle', state: 'TX', zip: '78640' };
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'home_address', stage: 'confirm', extracted: rawExtracted } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('1');

    mockJobIdRow();
    mockUpdateOk();
    mockAppRow(appRow({ required_fields: ['home_address'], application_answers: { home_address: rawExtracted } }));
    mockDocRows([]);

    await handleFillMessage(client, ctx, msg, deps);

    expect(deps.setRls).toHaveBeenCalledWith(client, WORKER_ID);
    const setRlsOrder = (deps.setRls as jest.Mock).mock.invocationCallOrder[0];
    const updateOrder = mockQuery.mock.invocationCallOrder[1]; // [0]=jobId lookup, [1]=UPDATE
    expect(setRlsOrder).toBeLessThan(updateOrder);

    const [, updateParams] = mockQuery.mock.calls[1];
    const written = JSON.parse(updateParams[0]);
    // The validator TRIMS apartment -- this is validated.value[key], never
    // the raw (untrimmed) extracted object.
    expect(written.home_address.apartment).toBe('Unit 5');
  });

  it('merge backstop >8192 bytes: answer_too_long reply, nothing written, step stays pending', async () => {
    const oversized = { street: 'x'.repeat(9000), city: 'Kyle', state: 'TX', zip: '78640' };
    (validateApplicationAnswers as jest.Mock).mockReturnValueOnce({ ok: true, value: { home_address: oversized } });

    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'home_address', stage: 'confirm', extracted: { street: 'irrelevant' } } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('1');

    mockJobIdRow();

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1); // jobId lookup only -- no UPDATE, nothing written
    expect(deps.setRls).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('answer_too_long', 'en'));
  });

  it('desired_pay success: next prompt embeds the normalized amount/interval echo', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('25/hour');

    mockJobIdRow();
    mockAppRow(appRow({
      required_fields: ['desired_pay', 'work_authorization'],
      application_answers: {},
    }));
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['desired_pay', 'work_authorization'],
      application_answers: { desired_pay: { amount: 25, interval: 'hourly' } },
    }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = mockQuery.mock.calls[2];
    expect(updateParams).toEqual([
      JSON.stringify({ desired_pay: { amount: 25, interval: 'hourly' } }),
      APPLICATION_ID,
    ]);
    expect(lastReply(deps)).toBe(
      `Got it: $25 per hour.\n\n${fieldQuestion('work_authorization', 'en')}`,
    );
  });

  it.each([
    ['25 an hour', 25, 'hourly'],
    ['25 a day', 25, 'daily'],
    ['25 per hour', 25, 'hourly'],
    ['25/hora', 25, 'hourly'],
    ['25 por hora', 25, 'hourly'],
    ['$25 hourly', 25, 'hourly'],
  ] as const)('desired_pay regex fix (Finding 2): "%s" parses to amount %i / %s', async (body, amount, interval) => {
    // "25 an hour" is the LITERAL worked example in this key's own
    // fieldQuestion/fieldRetryHint copy (application-fill-prompts.ts) --
    // the brief's original regex could not parse its own example.
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['desired_pay', 'work_authorization'], application_answers: {} }));
    mockUpdateOk();
    mockAppRow(appRow({
      required_fields: ['desired_pay', 'work_authorization'],
      application_answers: { desired_pay: { amount, interval } },
    }));

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    // [0]=jobId lookup, [1]=computeNextStep (current step), [2]=UPDATE.
    const [, updateParams] = mockQuery.mock.calls[2];
    expect(updateParams).toEqual([JSON.stringify({ desired_pay: { amount, interval } }), APPLICATION_ID]);
  });

  it('desired_pay "25 al ano" returns null (no yearly interval) and re-prompts', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('25 al ano');

    mockJobIdRow();
    mockAppRow(appRow({ required_fields: ['desired_pay'], application_answers: {} }));

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(2); // no UPDATE
    expect(lastReply(deps)).toBe(fieldRetryHint('desired_pay', 'en'));
  });
});

describe('promptNextStep', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the field question and stamps fill_last_prompt_at', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockAppRow(appRow({ required_fields: ['work_authorization'], application_answers: {} }));

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fieldQuestion('work_authorization', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('complete/exit is a Task-11 placeholder: sends completion copy and clears fill state', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockAppRow(appRow({ required_fields: [], required_docs: [] }));
    mockDocRows([]);

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fillMessage('completion', 'en'));
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_pending).toBeNull();
  });
});

describe('isFillCancel', () => {
  it.each(['cancelar', 'CANCELAR', '  Cancelar  ', 'CanceLar'])('matches %s (case/trim-insensitive)', (s) => {
    expect(isFillCancel(s)).toBe(true);
  });

  it.each(['cancel', 'cancela', 'cancelarr', 'no cancelar', 'cancelar por favor'])('does not match %s', (s) => {
    expect(isFillCancel(s)).toBe(false);
  });

  // Duplicated (not imported) from flows.ts's private COMMAND_KEYWORDS +
  // damerauLevenshteinDistance -- flows.ts belongs to another lane (Task 10)
  // and does not export either (same rationale onboarding-language.ts
  // documents for its own duplicate copy of this function). Spec §6.2 /
  // §14 requires and documents: min distance 5, against 'cerrar'/'saltar'.
  const COMMAND_KEYWORDS = [
    'help', 'ayuda', 'commands', 'comandos', 'jobs', 'trabajos', 'empleos',
    'profile', 'perfil', 'skip', 'saltar', 'chats', 'mensajes', 'cerrar', 'close',
  ];

  function damerauLevenshteinDistance(a: string, b: string): number {
    const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) d[i][0] = i;
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  it('isFillCancel distance lock: "cancelar" is >1 Damerau-Levenshtein from every COMMAND_KEYWORDS entry', () => {
    const distances = COMMAND_KEYWORDS.map((kw) => damerauLevenshteinDistance('cancelar', kw));
    for (const d of distances) {
      expect(d).toBeGreaterThan(1);
    }
    expect(Math.min(...distances)).toBe(5); // spec §14's documented value, vs cerrar/saltar
  });
});

describe('parseFillConfirmation', () => {
  it.each([['1', 'yes'], ['1 si', 'yes'], ['si', 'yes'], ['Si', 'yes'], ['sí', 'yes'], ['yes', 'yes'], ['1 yes', 'yes']])(
    '%s -> %s',
    (input, expected) => {
      expect(parseFillConfirmation(input)).toBe(expected);
    },
  );

  it.each([['2', 'no'], ['2 no', 'no'], ['no', 'no'], ['No', 'no']])('%s -> %s', (input, expected) => {
    expect(parseFillConfirmation(input)).toBe(expected);
  });

  it.each(['maybe', '3', '', 'ok', 'yes please'])('%s -> null', (input) => {
    expect(parseFillConfirmation(input)).toBeNull();
  });
});
