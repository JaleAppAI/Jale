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

// Task 8: media.ts's uploadDocumentToS3 makes a real S3 PutObjectCommand
// call -- mocked so doc-step tests never hit AWS. sniffDocumentType,
// MediaTooLargeError, ALLOWED_DOCUMENT_TYPES stay REAL (pure, no I/O) so the
// magic-byte sniff and the mismatch/error-type checks under test are
// authentic, not asserted-by-mock. downloadTwilioMediaBounded is never
// imported here -- application-fill.ts only calls it indirectly via the
// injected `deps.downloadMedia`, so it needs no mock of its own.
jest.mock('../../../../../lambda/whatsapp/lib/media', () => {
  const actual = jest.requireActual('../../../../../lambda/whatsapp/lib/media');
  return { ...actual, uploadDocumentToS3: jest.fn() };
});

import {
  computeNextStep,
  countRemainingRequirements,
  seedAnswersFromDefaults,
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
import { fieldQuestion, fieldRetryHint, fillMessage, docPrompt } from '../../../../../lambda/whatsapp/lib/application-fill-prompts';
import { uploadDocumentToS3, MediaTooLargeError } from '../../../../../lambda/whatsapp/lib/media';
import { t } from '../../../../../lambda/whatsapp/lib/templates';

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

const DOCUMENTS_BUCKET = 'test-documents-bucket';

function makeDeps(ctx: FillContext, overrides: Partial<FillDeps> = {}): FillDeps {
  return {
    extraction: fakeExtraction({}),
    queueReplyText: jest.fn(async () => {}),
    setRls: jest.fn(async () => {}),
    updateStateContext: jest.fn(async (_client: unknown, _conversationId: string, patch: Record<string, unknown>) => {
      Object.assign(ctx.stateContext, patch);
    }),
    nowMs: () => NOW_MS,
    downloadMedia: jest.fn(async () => Buffer.from('unused-default-fixture')),
    documentsBucket: DOCUMENTS_BUCKET,
    ...overrides,
  };
}

// Magic-byte fixtures for sniffDocumentType (media.ts) -- real bytes, not
// asserted-by-mock, since sniffDocumentType runs for real in every test
// below.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n%mock-pdf-body');

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

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage — document steps (Task 8). Real S3 key format:
// documents/${jobId}/${workerId}/${docType}/${uuid}.${ext} (worker-doc-
// upload-url.ts:93 scheme). copyRequiredDocumentSnapshots (applications.ts)
// runs FOR REAL here (not mocked) so its own INSERT...SELECT queries flow
// through the same mockQuery chain -- only uploadDocumentToS3 (media.ts,
// real S3 I/O) is mocked.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — document steps (Task 8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('media at doc step (non-cert): sniff ok -> S3 put -> SAVEPOINT -> DELETE-then-INSERT with version id -> snapshot copy -> next prompt', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-123' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [1]
    mockDocRows([]); // [2] -- resume missing -> doc:resume
    mockUpdateOk(); // [3] SAVEPOINT
    mockUpdateOk(); // [4] DELETE
    mockUpdateOk(); // [5] INSERT
    mockUpdateOk(); // [6] copyRequiredDocumentSnapshots (non-cert branch, 1 query)
    mockUpdateOk(); // [7] RELEASE
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [8] promptNextStep's computeNextStep
    mockDocRows(['resume']); // [9] -- driver_license now missing

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).toHaveBeenCalledWith(
      DOCUMENTS_BUCKET,
      expect.stringMatching(new RegExp(`^documents/${JOB_ID}/${WORKER_ID}/resume/[0-9a-f-]+\\.jpg$`)),
      JPEG_BYTES,
      'image/jpeg',
    );

    const [deleteSql, deleteParams] = mockQuery.mock.calls[4];
    expect(deleteSql).toMatch(/DELETE FROM worker_documents WHERE worker_id = \$1 AND job_id = \$2 AND doc_type = \$3/);
    expect(deleteParams).toEqual([WORKER_ID, JOB_ID, 'resume']);

    const [insertSql, insertParams] = mockQuery.mock.calls[5];
    expect(insertSql).toMatch(/INSERT INTO worker_documents/);
    expect(insertParams).toEqual([
      WORKER_ID, JOB_ID, 'resume',
      expect.stringContaining('documents/'),
      'resume.jpg',
      JPEG_BYTES.length,
      'image/jpeg',
      'v-123',
      null, // cert_name -- always NULL for non-cert doc types (078's CHECK requires it)
    ]);

    expect(mockQuery).toHaveBeenCalledTimes(10);
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  it('certification_doc: plain INSERT (no DELETE), replies entry_another (cert loop), arms fill_cert_more_pending, does NOT advance', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-456' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['certification_doc'] })); // [1]
    mockDocRows([]); // [2] -- doc:certification_doc
    mockUpdateOk(); // [3] SAVEPOINT
    mockUpdateOk(); // [4] INSERT (no DELETE for certification_doc)
    mockUpdateOk(); // [5] copyRequiredDocumentSnapshots (cert branch, 1 query)
    mockUpdateOk(); // [6] RELEASE

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    for (const [sql] of mockQuery.mock.calls) {
      expect(sql).not.toMatch(/DELETE FROM worker_documents/);
    }
    const [insertSql, insertParams] = mockQuery.mock.calls[4];
    expect(insertSql).toMatch(/INSERT INTO worker_documents/);
    expect(insertParams).toEqual([
      WORKER_ID, JOB_ID, 'certification_doc',
      expect.stringContaining('documents/'),
      'certification_doc.jpg',
      JPEG_BYTES.length,
      'image/jpeg',
      'v-456',
      null, // cert_name -- WhatsApp never collects a label; NULL lands in 078's unlabeled bucket
    ]);

    // promptNextStep never ran: no 8th/9th query re-deriving the step.
    expect(mockQuery).toHaveBeenCalledTimes(7);
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it.each(['certification_document_limit', 'certification_document_name_limit'])(
    'cert cap (%s): 23514 -> ROLLBACK TO SAVEPOINT -> cert_cap message -> advances',
    async (constraintName) => {
      const ctx = makeCtx();
      const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
      const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
      (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-789' });

      mockJobIdRow(); // [0]
      mockAppRow(appRow({ required_fields: [], required_docs: ['certification_doc', 'driver_license'] })); // [1]
      mockDocRows([]); // [2] -- doc:certification_doc
      mockUpdateOk(); // [3] SAVEPOINT
      const capError = Object.assign(new Error('cap reached'), { code: '23514', constraint: constraintName });
      mockQuery.mockRejectedValueOnce(capError); // [4] INSERT rejects
      mockUpdateOk(); // [5] ROLLBACK TO SAVEPOINT
      mockAppRow(appRow({ required_fields: [], required_docs: ['certification_doc', 'driver_license'] })); // [6] promptNextStep
      mockDocRows(['certification_doc']); // [7] -- cap implies existing rows; driver_license now next

      const result = await handleFillMessage(client, ctx, msg, deps);

      expect(result).toEqual({ handled: true });
      expect(mockQuery.mock.calls[5][0]).toMatch(/ROLLBACK TO SAVEPOINT/);
      const replies = (deps.queueReplyText as jest.Mock).mock.calls.map((c) => c[3]);
      expect(replies).toEqual([fillMessage('cert_cap', 'en'), docPrompt('driver_license', 'en')]);
    },
  );

  it('non-cert 23505 -> ROLLBACK TO SAVEPOINT -> treated satisfied -> advances silently (first-write-wins)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-abc' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [1]
    mockDocRows([]); // [2] -- doc:resume
    mockUpdateOk(); // [3] SAVEPOINT
    mockUpdateOk(); // [4] DELETE
    const raceError = Object.assign(new Error('duplicate'), { code: '23505' });
    mockQuery.mockRejectedValueOnce(raceError); // [5] INSERT rejects
    mockUpdateOk(); // [6] ROLLBACK TO SAVEPOINT
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [7] promptNextStep
    mockDocRows(['resume']); // [8] -- a concurrent write already landed it

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery.mock.calls[6][0]).toMatch(/ROLLBACK TO SAVEPOINT/);
    // No cert_cap / error reply -- exactly one reply, the advanced next-step prompt.
    expect((deps.queueReplyText as jest.Mock).mock.calls).toHaveLength(1);
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  it('other SQLSTATE -> ROLLBACK TO SAVEPOINT -> rethrows (never mapped to satisfied/stay_pending)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-def' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]
    mockUpdateOk(); // [3] SAVEPOINT
    mockUpdateOk(); // [4] DELETE
    const weirdError = Object.assign(new Error('server exploded'), { code: 'XX000' });
    mockQuery.mockRejectedValueOnce(weirdError); // [5] INSERT rejects
    mockUpdateOk(); // [6] ROLLBACK TO SAVEPOINT

    await expect(handleFillMessage(client, ctx, msg, deps)).rejects.toThrow('server exploded');

    expect(mockQuery.mock.calls[6][0]).toMatch(/ROLLBACK TO SAVEPOINT/);
    expect(mockQuery).toHaveBeenCalledTimes(7); // never reached promptNextStep
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('sniff mismatch vs claimed type -> doc_invalid_type reply, step stays pending, no S3 put', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PNG_BYTES) }); // real bytes sniff to image/png
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' }); // claimed jpeg

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(3); // no SAVEPOINT/writes, no promptNextStep re-derive
    expect(lastReply(deps)).toBe(fillMessage('doc_invalid_type', 'en'));
  });

  it('oversize buffer (MediaTooLargeError) -> doc_too_large reply, no S3 put', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => { throw new MediaTooLargeError(); }) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(lastReply(deps)).toBe(fillMessage('doc_too_large', 'en'));
  });

  it('downloadMedia throws a generic error -> doc_download_failed reply, no S3 put, NO rethrow (turn commits)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => { throw new Error('twilio 502'); }) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true }); // never rejects -- the turn commits
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('doc_download_failed', 'en'));
  });

  it('NumMedia>1 -> processes the first attachment, prepends doc_take_first to the resulting reply', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 2, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-multi' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [1]
    mockDocRows([]); // [2]
    mockUpdateOk(); // [3] SAVEPOINT
    mockUpdateOk(); // [4] DELETE
    mockUpdateOk(); // [5] INSERT
    mockUpdateOk(); // [6] copy snapshot
    mockUpdateOk(); // [7] RELEASE
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] })); // [8]
    mockDocRows(['resume']); // [9]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).toHaveBeenCalledWith(DOCUMENTS_BUCKET, expect.any(String), JPEG_BYTES, 'image/jpeg');
    expect(lastReply(deps)).toBe(`${fillMessage('doc_take_first', 'en')}\n\n${docPrompt('driver_license', 'en')}`);
  });

  it('audio content type at a doc step -> voice_note_not_supported (templates.ts key, not v2_voice_not_supported), no download attempted', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'audio/ogg' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(deps.downloadMedia).not.toHaveBeenCalled();
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(lastReply(deps)).toBe(t('voice_note_not_supported', 'en'));
  });

  it('media at a FIELD step -> field_step_media reply, nothing written', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg' });

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: ['work_authorization'], application_answers: {} })); // [1] -- field kind, no docs query

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(deps.downloadMedia).not.toHaveBeenCalled();
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(lastReply(deps)).toBe(fillMessage('field_step_media', 'en'));
  });

  it('free text at a doc step -> re-sends the doc prompt when outside the reprompt cooldown', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const msg = incomingMsg('hola');

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(docPrompt('resume', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('free text at a doc step within the reprompt cooldown -> absorbed silently, no duplicate prompt', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_last_prompt_at: NOW_MS - 1000 },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('hola');

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('outcome contract: stay_pending never triggers promptNextStep; stored does', async () => {
    // Scenario A: stay_pending (invalid type) -- only the 3 derive-step
    // queries run, no SAVEPOINT/write, no second computeNextStep call.
    const ctxA = makeCtx();
    const depsA = makeDeps(ctxA, { downloadMedia: jest.fn(async () => PNG_BYTES) });
    mockJobIdRow();
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume'] }));
    mockDocRows([]);
    await handleFillMessage(client, ctxA, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg',
    }), depsA);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(lastReply(depsA)).toBe(fillMessage('doc_invalid_type', 'en'));

    jest.clearAllMocks();

    // Scenario B: stored -- promptNextStep DOES run (2 extra queries, and a
    // DIFFERENT reply -- the next doc's prompt, not a doc-step error).
    const ctxB = makeCtx();
    const depsB = makeDeps(ctxB, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-contract' });
    mockJobIdRow();
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] }));
    mockDocRows([]);
    mockUpdateOk(); // SAVEPOINT
    mockUpdateOk(); // DELETE
    mockUpdateOk(); // INSERT
    mockUpdateOk(); // copy snapshot
    mockUpdateOk(); // RELEASE
    mockAppRow(appRow({ required_fields: [], required_docs: ['resume', 'driver_license'] }));
    mockDocRows(['resume']);
    await handleFillMessage(client, ctxB, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg',
    }), depsB);
    expect(mockQuery).toHaveBeenCalledTimes(10);
    expect(lastReply(depsB)).toBe(docPrompt('driver_license', 'en'));
  });

  it('cert loop: fill_cert_more_pending routes the next media straight to certification_doc, bypassing computeNextStep', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PDF_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/2', mediaContentType: 'application/pdf' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-second-cert' });

    mockJobIdRow(); // [0]
    mockUpdateOk(); // [1] SAVEPOINT
    mockUpdateOk(); // [2] INSERT (no DELETE for certification_doc)
    mockUpdateOk(); // [3] copy snapshot
    mockUpdateOk(); // [4] RELEASE

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    // computeNextStep never ran -- no job_applications/jobs join query.
    for (const [sql] of mockQuery.mock.calls) {
      expect(sql).not.toMatch(/FROM job_applications ja/);
    }
    expect(mockQuery).toHaveBeenCalledTimes(5);
    const [insertSql, insertParams] = mockQuery.mock.calls[2];
    expect(insertSql).toMatch(/INSERT INTO worker_documents/);
    expect(insertParams[2]).toBe('certification_doc');
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it('cert loop: "2 no" clears fill_cert_more_pending and advances (promptNextStep runs)', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);
    const msg = incomingMsg('2 no');

    mockJobIdRow(); // [0]
    mockAppRow(appRow({ required_fields: [], required_docs: ['driver_license'] })); // [1]
    mockDocRows([]); // [2]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  // Review fix (Critical, bug A): "1"/"si" is the exact affirmative
  // entry_another's own copy invites ("Responde con 1 o 2") -- it must NOT
  // be treated the same as "no". The flag stays armed and the worker gets
  // told to send the file, with NO advance (no promptNextStep call, i.e.
  // no computeNextStep-derived query beyond the jobId lookup).
  it.each(['1', '1 si', 'si', 'yes'])('cert loop: "%s" keeps fill_cert_more_pending armed and re-sends docPrompt(certification_doc), no advance', async (body) => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);

    mockJobIdRow(); // [0] -- no computeNextStep call at all

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
    expect(lastReply(deps)).toBe(docPrompt('certification_doc', 'en'));
  });

  it('cert loop: unclear text re-echoes (fillMessage reconfirm) and keeps the flag armed', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);

    mockJobIdRow(); // [0]

    const result = await handleFillMessage(client, ctx, incomingMsg('maybe later'), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
    expect(lastReply(deps)).toBe(fillMessage('reconfirm', 'en'));
  });

  // Review fix (Critical, bug B) -- the important regression test: a
  // retryable error (invalid type here) on a SECOND cert attempt must NOT
  // clear the loop flag. Before the fix, the flag was cleared unconditionally
  // whenever the outcome wasn't 'stored', so the worker's next (valid) retry
  // would route through computeNextStep to whatever's ACTUALLY next and get
  // stored under the WRONG doc_type instead of certification_doc.
  it('cert loop: invalid file during an active loop keeps the flag armed; the next valid upload still stores as certification_doc', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PNG_BYTES) }); // claimed pdf, sniffs png -> mismatch
    const badMsg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/bad', mediaContentType: 'application/pdf' });

    mockJobIdRow(); // [0] -- flag bypasses computeNextStep

    const badResult = await handleFillMessage(client, ctx, badMsg, deps);

    expect(badResult).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1); // no SAVEPOINT/write, no promptNextStep re-derive
    expect(lastReply(deps)).toBe(fillMessage('doc_invalid_type', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true); // NOT cleared

    jest.clearAllMocks();
    (deps.downloadMedia as jest.Mock).mockImplementation(async () => JPEG_BYTES);
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-retry-good' });
    const goodMsg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/good', mediaContentType: 'image/jpeg' });

    mockJobIdRow(); // [0]
    mockUpdateOk(); // [1] SAVEPOINT
    mockUpdateOk(); // [2] INSERT (no DELETE for certification_doc)
    mockUpdateOk(); // [3] copy snapshot
    mockUpdateOk(); // [4] RELEASE

    const goodResult = await handleFillMessage(client, ctx, goodMsg, deps);

    expect(goodResult).toEqual({ handled: true });
    // Still routed as certification_doc, NOT mis-routed to some other doc
    // type via computeNextStep.
    for (const [sql] of mockQuery.mock.calls) {
      expect(sql).not.toMatch(/FROM job_applications ja/);
    }
    const [insertSql, insertParams] = mockQuery.mock.calls[2];
    expect(insertSql).toMatch(/INSERT INTO worker_documents/);
    expect(insertParams[2]).toBe('certification_doc');
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it('cert loop: hitting the cap mid-loop (satisfied) clears the flag and advances', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    const msg = incomingMsg('', { numMedia: 1, mediaUrl: 'https://twilio.example/media/cap', mediaContentType: 'image/jpeg' });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-cap' });

    mockJobIdRow(); // [0] -- flag bypasses computeNextStep
    mockUpdateOk(); // [1] SAVEPOINT
    const capError = Object.assign(new Error('cap reached'), { code: '23514', constraint: 'certification_document_limit' });
    mockQuery.mockRejectedValueOnce(capError); // [2] INSERT rejects
    mockUpdateOk(); // [3] ROLLBACK TO SAVEPOINT
    mockAppRow(appRow({ required_fields: [], required_docs: ['certification_doc', 'driver_license'] })); // [4] promptNextStep
    mockDocRows(['certification_doc']); // [5]

    const result = await handleFillMessage(client, ctx, msg, deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
    const replies = (deps.queueReplyText as jest.Mock).mock.calls.map((c) => c[3]);
    expect(replies).toEqual([fillMessage('cert_cap', 'en'), docPrompt('driver_license', 'en')]);
  });

  it('CANCELAR also clears fill_cert_more_pending', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);

    await handleFillMessage(client, ctx, incomingMsg('cancelar'), deps);

    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// seedAnswersFromDefaults (Task 9). Called directly (not through
// handleFillMessage) with a worker's `worker_application_defaults.answers`
// bag -- `deps.setRls` is the injected mock (never itself touches
// `mockQuery`, matching every other FillDeps test above), so the SELECT/
// UPDATE call-count assertions below count ONLY this function's own
// `client.query` calls: [0] defaults SELECT, [1] job_applications SELECT
// (skipped entirely when there is no defaults row), [2] the batched UPDATE
// (skipped entirely when nothing validates).
// ─────────────────────────────────────────────────────────────────────────

describe('seedAnswersFromDefaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (validateApplicationAnswers as jest.Mock).mockImplementation(
      jest.requireActual('../../../../../lambda/lib/application-answers').validateApplicationAnswers,
    );
  });

  function mockDefaultsRow(answers: Record<string, unknown> | null) {
    mockQuery.mockResolvedValueOnce(
      answers ? { rows: [{ answers }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }

  function mockCurrentAnswers(answers: Record<string, unknown>) {
    mockQuery.mockResolvedValueOnce({ rows: [{ application_answers: answers }], rowCount: 1 });
  }

  function mockSeedUpdateOk() {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
  }

  it('seeds a default field absent from application_answers and returns its key', async () => {
    const ctx = makeCtx({ stateContext: { fill_application_id: APPLICATION_ID } });
    const deps = makeDeps(ctx);

    mockDefaultsRow({ work_authorization: true });
    mockCurrentAnswers({});
    mockSeedUpdateOk();

    const seeded = await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(seeded).toEqual(['work_authorization']);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const [, updateParams] = mockQuery.mock.calls[2];
    expect(JSON.parse((updateParams as unknown[])[0] as string)).toEqual({ work_authorization: true });
    expect((updateParams as unknown[])[1]).toBe(APPLICATION_ID);
  });

  it('never overwrites a key already present in application_answers, even if the default disagrees', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow({ work_authorization: false });
    mockCurrentAnswers({ work_authorization: true });

    const seeded = await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(seeded).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(2); // defaults + current answers -- no UPDATE
  });

  it('skips a key whose stored default fails validation, silently -- never seeded, never an error', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow({ work_authorization: 'yes' }); // not a boolean -- fails validateWorkAuthorization
    mockCurrentAnswers({});

    const seeded = await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(seeded).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(2); // no UPDATE -- nothing validated
  });

  it('batches every seeded key (required + optional) into exactly one UPDATE', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow({ work_authorization: true, date_available: '2026-09-01', education: 'college' });
    mockCurrentAnswers({ education: 'ged' }); // already answered -- must not be touched
    mockSeedUpdateOk();

    const seeded = await seedAnswersFromDefaults(
      client,
      ctx,
      ['work_authorization', 'date_available'],
      ['education'],
      deps,
    );

    expect(seeded.sort()).toEqual(['date_available', 'work_authorization']);
    expect(mockQuery).toHaveBeenCalledTimes(3); // defaults + current + ONE update
    const [, updateParams] = mockQuery.mock.calls[2];
    expect(JSON.parse((updateParams as unknown[])[0] as string)).toEqual({
      work_authorization: true,
      date_available: '2026-09-01',
    });
  });

  it('worker with no defaults row: seeds nothing and never queries job_applications', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow(null);

    const seeded = await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(seeded).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // the defaults SELECT only
  });

  it('an empty defaults answers bag ({}) also seeds nothing without a second query', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow({});

    const seeded = await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(seeded).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('runs deps.setRls before any SELECT (call-order)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    mockDefaultsRow({ work_authorization: true });
    mockCurrentAnswers({});
    mockSeedUpdateOk();

    await seedAnswersFromDefaults(client, ctx, ['work_authorization'], [], deps);

    expect(deps.setRls).toHaveBeenCalledWith(client, WORKER_ID);
    const setRlsOrder = (deps.setRls as jest.Mock).mock.invocationCallOrder[0];
    const firstQueryOrder = mockQuery.mock.invocationCallOrder[0];
    expect(setRlsOrder).toBeLessThan(firstQueryOrder);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// countRemainingRequirements (Task 9) -- the fill-arm intro's N/M counts.
// One combined SELECT (job_applications JOIN jobs + a correlated
// worker_documents subquery), matching computeNextStep's own two data
// sources but returning COUNTS rather than the first gap.
// ─────────────────────────────────────────────────────────────────────────

describe('countRemainingRequirements', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockCountRow(overrides: Partial<{
    application_answers: Record<string, unknown>;
    required_fields: string[];
    required_docs: string[];
    have_docs: string[];
  }> = {}) {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        application_answers: {},
        required_fields: [],
        required_docs: [],
        have_docs: [],
        ...overrides,
      }],
      rowCount: 1,
    });
  }

  it('counts unanswered required fields and undelivered required docs', async () => {
    mockCountRow({
      application_answers: { work_authorization: true },
      required_fields: ['work_authorization', 'date_available', 'desired_pay'],
      required_docs: ['resume', 'driver_license'],
      have_docs: ['resume'],
    });

    const counts = await countRemainingRequirements(client, APPLICATION_ID);

    expect(counts).toEqual({ nFields: 2, nDocs: 1, uncollectable: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reports uncollectable doc types (e.g. legacy ssn) separately, never counted in nDocs', async () => {
    mockCountRow({ required_docs: ['ssn'], have_docs: [] });

    const counts = await countRemainingRequirements(client, APPLICATION_ID);

    expect(counts).toEqual({ nFields: 0, nDocs: 0, uncollectable: ['ssn'] });
  });

  it('zero counts when every field is answered and every doc is on file', async () => {
    mockCountRow({
      application_answers: { work_authorization: true },
      required_fields: ['work_authorization'],
      required_docs: ['resume'],
      have_docs: ['resume'],
    });

    const counts = await countRemainingRequirements(client, APPLICATION_ID);

    expect(counts).toEqual({ nFields: 0, nDocs: 0, uncollectable: [] });
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
