// infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts
//
// Verifies the WhatsApp application-fill lane after sprint 23 rewired it onto
// the shared engine (lambda/lib/application-requirements.ts). Everything this
// module used to own -- its private `computeNextStep`, its
// `countRemainingRequirements`, its own `seedAnswersFromDefaults` and
// `persistMergedAnswers` -- now lives in that engine and is unit-tested in
// test/unit/lambda/lib/application-requirements.test.ts. What is tested HERE
// is the lane: the narrower step gate (`fillStepFor`/`computeFillStep`), the
// stage-2 arm (`armFill`), the per-turn dispatcher (`handleFillMessage`) and
// the terminal arms (`promptNextStep` -> completion / lifecycle exit).
//
// ── WHY THE DB DOUBLE IS SQL-SHAPE-ROUTED, NOT A CALL QUEUE ──────────────
// The pre-sprint-23 version of this file drove `client.query` with a strict
// `mockResolvedValueOnce` queue and asserted on `mockQuery.mock.calls[N]`
// with hardcoded indices. Both are unusable now: ONE logical operation
// (`mergeFieldAnswers`) is a snapshot load + a SAVEPOINT + the merge UPDATE +
// a RELEASE + a defaults upsert + a conditional completion stamp, and the
// snapshot load is itself 1 or 3 statements depending on whether the job asks
// for documents. A queue encodes that arithmetic in every test and breaks on
// any engine-internal reordering.
//
// So `installDbFake()` below installs ONE `mockImplementation` that routes on
// SQL SHAPE and answers from mutable STATE (`fake`). Tests declare state
// ("this application is stage 2, needs work_authorization, has no docs on
// file") instead of a call sequence. The fake also APPLIES writes to that
// state -- a merge UPDATE really merges into the fixture's answers, a
// worker_documents INSERT really makes the doc present -- so a turn's
// follow-up prompt advances for the same reason production advances, and
// SAVEPOINT/ROLLBACK really restores. Any statement the router does not
// recognize THROWS with the SQL text, so an unmocked query fails loudly
// instead of silently resolving to `undefined`.
//
// Assertions look calls up by SQL shape (`findCall`/`findCallIndex`), never
// by index. Where ORDER is the thing under test (S3 PUT before the DB write,
// setRls before the write, the completion stamp before the completion reply)
// the order is asserted with `invocationCallOrder`, computed from a
// find-by-shape index.
//
// job-fields.ts (DOC_TYPES / REQUIRED_FIELD_TYPES) is left UNMOCKED
// intentionally: it is pure data, no I/O.
//
// ../../lib/db is mocked: `setInternalUserRlsContext` is how the engine's
// document-sync path arms worker_documents' FORCE ROW LEVEL SECURITY policy
// (005_document_vault.sql), and mocking it both (a) lets the RLS-ordering
// tests below assert on it directly and (b) keeps its `SELECT set_config(...)`
// out of the query stream, so "how many statements does one snapshot load
// cost" stays readable.

const mockQuery = jest.fn();
const client: any = { query: mockQuery };

jest.mock('../../../../../lambda/lib/db', () => ({
  setInternalUserRlsContext: jest.fn(),
}));

// Real `validateApplicationAnswers` by default (pass-through wrapper) --
// only the merge-backstop / invalid-answer tests below override it for one
// call; every other test exercises the genuine validator so e.g.
// string-trimming behavior is authentic, not asserted-by-mock.
jest.mock('../../../../../lambda/lib/application-answers', () => {
  const actual = jest.requireActual('../../../../../lambda/lib/application-answers');
  return { ...actual, validateApplicationAnswers: jest.fn(actual.validateApplicationAnswers) };
});

// media.ts's uploadDocumentToS3 makes a real S3 PutObjectCommand call --
// mocked so doc-step tests never hit AWS. sniffDocumentType,
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
  computeFillStep,
  fillStepFor,
  fillCountsFor,
  workerApplicationUrl,
  matchesFillEscape,
  localizeDocList,
  armFill,
  handleFillMessage,
  promptNextStep,
  isFillCancel,
  parseFillConfirmation,
  type FillDeps,
  type FillContext,
  type FillPendingConfirm,
  type FillPendingEntryAnother,
} from '../../../../../lambda/whatsapp/lib/application-fill';
import {
  loadRequirementSnapshot,
  type RequirementSnapshot,
} from '../../../../../lambda/lib/application-requirements';
import { setInternalUserRlsContext } from '../../../../../lambda/lib/db';
import { validateApplicationAnswers } from '../../../../../lambda/lib/application-answers';
import type { IncomingMessage } from '../../../../../lambda/whatsapp/lib/conversation-router';
import type { ExtractionClient } from '../../../../../lambda/whatsapp/lib/application-fill-extraction';
import { fieldQuestion, fieldRetryHint, fieldLabel, fillMessage, docPrompt } from '../../../../../lambda/whatsapp/lib/application-fill-prompts';
import { uploadDocumentToS3, MediaTooLargeError } from '../../../../../lambda/whatsapp/lib/media';
import { t } from '../../../../../lambda/whatsapp/lib/templates';

const APPLICATION_ID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const WORKER_ID = 'bbbbbbbb-0000-0000-0000-00000000000b';
const JOB_ID = 'cccccccc-0000-0000-0000-00000000000c';
const CONVERSATION_ID = 'dddddddd-0000-0000-0000-00000000000d';
const OTHER_APPLICATION_ID = 'eeeeeeee-0000-0000-0000-00000000000e';
const OTHER_APPLICATION_ID_2 = 'ffffffff-0000-0000-0000-00000000000f';
const OTHER_JOB_ID = 'cccccccc-0000-0000-0000-00000000001c';
const OTHER_JOB_ID_2 = 'cccccccc-0000-0000-0000-00000000002c';
const FROM = 'whatsapp:+15550000000';
const NOW_MS = 1_700_000_000_000;

// The employer name `employer_display_name(...)` resolves to for JOB_ID --
// sprint 23's `intro` and `completion` copy both substitute `{{company}}`.
const COMPANY = 'Acme Concrete';

// Stage-2 default (task requirement 4): `details_requested_at` NON-NULL and
// `details_completed_at` NULL. `RequirementSnapshot.stage` is derived from
// the TIMESTAMP, never the literal status (application-requirements.ts:258),
// and `fillStepFor` exits an 'apply'-stage snapshot as `details_not_requested`
// -- so a fixture that forgets this makes every fill test exit instead of
// asking anything.
const DETAILS_REQUESTED_AT = '2026-09-01T10:00:00.000Z';

// ─────────────────────────────────────────────────────────────────────────
// THE DB FAKE. One `mockImplementation`, routed on SQL shape, answering from
// (and writing into) the mutable `fake` state below.
// ─────────────────────────────────────────────────────────────────────────

/** Every statement shape the lane + engine can issue this file. Also reused
 * as the find-by-shape patterns in assertions, so a pattern and its route
 * can never drift apart. */
const SQL = {
  /** application-requirements.ts:218 SNAPSHOT_SQL. */
  snapshot: /SELECT ja\.id, ja\.worker_id, ja\.job_id/,
  /** application-fill.ts:834 findContinueOtherOffer -- also a
   * job_applications-JOIN-jobs select, told apart by its worker_id key. */
  offerScan: /FROM job_applications ja JOIN jobs j[\s\S]*ja\.worker_id = \$1/,
  /** application-fill.ts:755 fetchApplicationJobId (media path). */
  jobIdOnly: /SELECT job_id FROM job_applications WHERE id = \$1/,
  /** application-fill.ts:782 fetchApplicationJobContext (text path, step 5). */
  jobContext: /SELECT job_applications\.job_id, jobs\.required_fields/,
  /** application-requirements.ts:295 -- the post-sync doc re-read. */
  docReread: /SELECT DISTINCT doc_type FROM worker_documents/,
  /** applications.ts:101 copyRequiredDocumentSnapshots, non-cert branch. */
  copyNonCert: /INSERT INTO worker_documents[\s\S]*SELECT DISTINCT ON \(doc_type\)/,
  /** applications.ts:117 copyRequiredDocumentSnapshots, certification branch. */
  copyCert: /INSERT INTO worker_documents[\s\S]*FROM worker_documents src/,
  /** application-fill.ts:1207 -- the lane's own single-row doc write. */
  docInsert: /INSERT INTO worker_documents \(worker_id, job_id, doc_type[\s\S]*VALUES \(\$1, \$2, \$3/,
  docDelete: /DELETE FROM worker_documents WHERE worker_id = \$1 AND job_id = \$2 AND doc_type = \$3/,
  /** application-requirements.ts:594 persistMergedAnswers -- THE merge. */
  mergeUpdate: /UPDATE job_applications\s+SET application_answers = application_answers \|\| \$1::jsonb/,
  /** application-requirements.ts clearFieldAnswer -- the CAMBIAR undo. Told
   * apart from `mergeUpdate` by the jsonb `-` operator; no assertion may
   * match on the `UPDATE job_applications` prefix alone. */
  clearAnswer: /UPDATE job_applications\s+SET application_answers = application_answers - \$1::text/,
  /** application-requirements.ts:924 markDetailsCompleteIfDone. NOTE: this
   * and `mergeUpdate` are BOTH `UPDATE job_applications`, so no assertion may
   * match on that prefix alone any more. */
  detailsComplete: /UPDATE job_applications\s+SET details_completed_at = now\(\)/,
  defaultsSelect: /SELECT answers FROM worker_application_defaults WHERE worker_id = \$1/,
  defaultsUpsert: /INSERT INTO worker_application_defaults/,
  seedAnswersSelect: /SELECT application_answers FROM job_applications WHERE id = \$1/,
  company: /SELECT employer_display_name\(/,
  savepoint: /^\s*SAVEPOINT (\S+)/,
  releaseSavepoint: /^\s*RELEASE SAVEPOINT (\S+)/,
  rollbackSavepoint: /^\s*ROLLBACK TO SAVEPOINT (\S+)/,
  setConfig: /SELECT set_config\(/,
};

interface AppFixture {
  /** The SNAPSHOT_SQL row, or null for a vanished application. */
  row: Record<string, any> | null;
  /** JOB-SCOPED worker_documents doc types (what `have_docs` reports). */
  haveDocs: string[];
  /** Vault docs (job_id IS NULL). `copyRequiredDocumentSnapshots` folds the
   * requested ones into `haveDocs` -- the engine header's whole reason for
   * `syncDocumentSnapshots: true`: without it a vault-only resume reads as
   * missing forever and the bot re-asks every turn. */
  vaultDocs: string[];
}

interface FakeDb {
  apps: Map<string, AppFixture>;
  /** Doc types written by a CONCURRENT transaction -- unioned into every
   * doc read and deliberately NOT savepoint-managed (another transaction's
   * row does not roll back with ours). This is what a 23505/23514 doc INSERT
   * failure actually means: the rows are already there. */
  concurrentDocs: string[];
  /** worker_application_defaults.answers, or null for "no row yet". */
  defaults: Record<string, unknown> | null;
  /** Every payload written through `upsertWorkerApplicationDefaults`. */
  defaultsWritten: Record<string, unknown>[];
  /** findContinueOtherOffer's candidate rows. */
  otherApps: { id: string; title: string }[];
  company: string;
  /** Override for the merge UPDATE's `RETURNING length(...) AS total` --
   * the post-merge column size the engine's SAVEPOINT guard compares against
   * MAX_ANSWERS_JSON_LENGTH (16384). Defaults to the real serialized size. */
  answersTotal?: number;
  /** Override for fetchApplicationJobContext's `required_fields` ONLY, so a
   * test can make that read and SNAPSHOT_SQL disagree (a real intra-turn
   * race: the employer edits the job between the two SELECTs). */
  jobContextRequiredFields?: string[];
  /** Thrown by copyRequiredDocumentSnapshots (both branches). */
  copyError?: unknown;
  /** Thrown by the lane's own worker_documents INSERT. */
  docInsertError?: unknown;
  savepoints: Map<string, () => void>;
}

let fake: FakeDb;

function freshApp(overrides: Record<string, unknown> = {}, fixture: Partial<AppFixture> = {}): AppFixture {
  return {
    row: {
      id: APPLICATION_ID,
      worker_id: WORKER_ID,
      job_id: JOB_ID,
      application_status: 'pending',
      application_answers: {},
      prompt_answers: {},
      details_requested_at: DETAILS_REQUESTED_AT,
      details_completed_at: null,
      applied_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      job_status: 'active',
      job_title: 'Concrete Finisher',
      required_fields: [],
      optional_fields: [],
      required_docs: [],
      optional_docs: [],
      certification_requirements: [],
      pre_application_prompts: [],
      ...overrides,
    },
    haveDocs: [],
    vaultDocs: [],
    ...fixture,
  };
}

function freshFake(): FakeDb {
  return {
    apps: new Map([[APPLICATION_ID, freshApp()]]),
    concurrentDocs: [],
    defaults: null,
    defaultsWritten: [],
    otherApps: [],
    company: COMPANY,
    savepoints: new Map(),
  };
}

/** Replaces THE application fixture's row fields (stage-2 defaults kept for
 * anything not named) and, optionally, its document state. */
function setApp(overrides: Record<string, unknown> = {}, fixture: Partial<AppFixture> = {}): void {
  fake.apps.set(APPLICATION_ID, freshApp(overrides, fixture));
}

/** Registers an ADDITIONAL application (a continue-other candidate). */
function setOtherApp(id: string, overrides: Record<string, unknown> = {}, fixture: Partial<AppFixture> = {}): void {
  fake.apps.set(id, freshApp({ id, ...overrides }, fixture));
}

/** The application row is gone (deleted, or its job CASCADE-deleted). */
function setAppMissing(): void {
  fake.apps.set(APPLICATION_ID, { row: null, haveDocs: [], vaultDocs: [] });
}

function appByJob(jobId: string): AppFixture | undefined {
  for (const fixture of fake.apps.values()) {
    if (fixture.row?.job_id === jobId) return fixture;
  }
  return undefined;
}

/** Job-scoped docs as the DB would report them: our own rows plus whatever a
 * concurrent transaction already committed. */
function visibleDocs(fixture: AppFixture | undefined): string[] {
  return Array.from(new Set([...(fixture?.haveDocs ?? []), ...fake.concurrentDocs]));
}

function takeSavepoint(name: string): void {
  const saved = Array.from(fake.apps.entries()).map(([id, f]) => [id, {
    answers: JSON.parse(JSON.stringify(f.row?.application_answers ?? {})),
    detailsCompletedAt: f.row?.details_completed_at ?? null,
    haveDocs: [...f.haveDocs],
    vaultDocs: [...f.vaultDocs],
  }] as const);
  fake.savepoints.set(name, () => {
    for (const [id, snap] of saved) {
      const f = fake.apps.get(id);
      if (!f) continue;
      if (f.row) {
        f.row.application_answers = snap.answers;
        f.row.details_completed_at = snap.detailsCompletedAt;
      }
      f.haveDocs = [...snap.haveDocs];
      f.vaultDocs = [...snap.vaultDocs];
    }
  });
}

function installDbFake(): void {
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    const args = (params ?? []) as any[];
    const ok = (rows: any[] = []) => ({ rows, rowCount: rows.length });

    // ── transaction control ──────────────────────────────────────────────
    let m = text.match(SQL.savepoint);
    if (m && !/^\s*(RELEASE|ROLLBACK)/.test(text)) {
      takeSavepoint(m[1]);
      return ok();
    }
    m = text.match(SQL.releaseSavepoint);
    if (m) {
      fake.savepoints.delete(m[1]);
      return ok();
    }
    m = text.match(SQL.rollbackSavepoint);
    if (m) {
      fake.savepoints.get(m[1])?.();
      fake.savepoints.delete(m[1]);
      return ok();
    }
    // Never reached while ../../lib/db is mocked; routed anyway so unmocking
    // it later is not a cliff.
    if (SQL.setConfig.test(text)) return ok([{ set_config: String(args[0] ?? '') }]);

    // ── reads ────────────────────────────────────────────────────────────
    if (SQL.snapshot.test(text)) {
      const fixture = fake.apps.get(String(args[0]));
      if (!fixture?.row) return ok();
      return ok([{ ...fixture.row, have_docs: visibleDocs(fixture) }]);
    }
    if (SQL.offerScan.test(text)) {
      return ok(fake.otherApps.map((entry) => ({ ...entry })));
    }
    if (SQL.jobIdOnly.test(text)) {
      const fixture = fake.apps.get(String(args[0]));
      return fixture?.row ? ok([{ job_id: fixture.row.job_id }]) : ok();
    }
    if (SQL.jobContext.test(text)) {
      const fixture = fake.apps.get(String(args[0]));
      if (!fixture?.row) return ok();
      return ok([{
        job_id: fixture.row.job_id,
        required_fields: fake.jobContextRequiredFields ?? fixture.row.required_fields,
      }]);
    }
    if (SQL.docReread.test(text)) {
      return ok(visibleDocs(appByJob(String(args[1]))).map((doc_type) => ({ doc_type })));
    }
    if (SQL.defaultsSelect.test(text)) {
      return fake.defaults === null ? ok() : ok([{ answers: fake.defaults }]);
    }
    if (SQL.seedAnswersSelect.test(text)) {
      const fixture = fake.apps.get(String(args[0]));
      return fixture?.row ? ok([{ application_answers: fixture.row.application_answers }]) : ok();
    }
    if (SQL.company.test(text)) return ok([{ company: fake.company }]);

    // ── document writes ──────────────────────────────────────────────────
    if (SQL.copyNonCert.test(text) || SQL.copyCert.test(text)) {
      if (fake.copyError) throw fake.copyError;
      const fixture = appByJob(String(args[0]));
      const wanted: string[] = SQL.copyCert.test(text) ? ['certification_doc'] : (args[2] as string[]);
      // L3: both INSERTs now carry `RETURNING doc_type`, and the engine
      // surfaces those rows as `snapshot.copiedDocuments` so the lane can
      // NAME the vault documents it attached. Only a row that was really
      // inserted comes back -- an already-copied doc returns nothing, which
      // is what makes a re-arm report nothing.
      const copied: { doc_type: string }[] = [];
      if (fixture) {
        for (const docType of wanted) {
          if (fixture.vaultDocs.includes(docType) && !fixture.haveDocs.includes(docType)) {
            fixture.haveDocs.push(docType);
            copied.push({ doc_type: docType });
          }
        }
      }
      return ok(copied);
    }
    if (SQL.docDelete.test(text)) {
      const fixture = appByJob(String(args[1]));
      if (fixture) fixture.haveDocs = fixture.haveDocs.filter((d) => d !== String(args[2]));
      return { rows: [], rowCount: 1 };
    }
    if (SQL.docInsert.test(text)) {
      const docType = String(args[2]);
      if (fake.docInsertError) {
        // A 23505/23514 here means the rows ALREADY EXIST -- committed by
        // another transaction (or by an earlier turn), so they survive our
        // ROLLBACK TO SAVEPOINT and the follow-up prompt must advance past
        // this slot.
        fake.concurrentDocs.push(docType);
        throw fake.docInsertError;
      }
      const fixture = appByJob(String(args[1]));
      if (fixture && !fixture.haveDocs.includes(docType)) fixture.haveDocs.push(docType);
      return { rows: [], rowCount: 1 };
    }

    // ── answer writes ────────────────────────────────────────────────────
    if (SQL.mergeUpdate.test(text)) {
      const fixture = fake.apps.get(String(args[1]));
      if (!fixture?.row) return ok();
      Object.assign(fixture.row.application_answers, JSON.parse(String(args[0])));
      const total = fake.answersTotal ?? JSON.stringify(fixture.row.application_answers).length;
      return { rows: [{ total }], rowCount: 1 };
    }
    if (SQL.clearAnswer.test(text)) {
      const fixture = fake.apps.get(String(args[1]));
      // Mirrors the real statement's `AND details_completed_at IS NULL`
      // guard, so a test cannot pass against a correction the DB refuses.
      if (!fixture?.row || fixture.row.details_completed_at) return { rows: [], rowCount: 0 };
      delete fixture.row.application_answers[String(args[0])];
      return { rows: [], rowCount: 1 };
    }
    if (SQL.detailsComplete.test(text)) {
      const fixture = fake.apps.get(String(args[0]));
      if (!fixture?.row || fixture.row.details_completed_at) return { rows: [], rowCount: 0 };
      fixture.row.details_completed_at = '2026-09-02T00:00:00.000Z';
      return { rows: [], rowCount: 1 };
    }
    if (SQL.defaultsUpsert.test(text)) {
      fake.defaultsWritten.push(JSON.parse(String(args[1])));
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`application-fill.test DB fake: unmocked SQL -> ${text.replace(/\s+/g, ' ').trim()}`);
  });
}

// ── find-by-SQL-shape assertion helpers ─────────────────────────────────
//
// These replace every `mockQuery.mock.calls[N]` in the pre-sprint-23 file.
// A miss THROWS with the full observed statement list, so a stale pattern is
// a loud failure instead of an `undefined` destructured three lines later.

function observedSql(): string {
  return mockQuery.mock.calls
    .map(([s]: any[], i: number) => `  [${i}] ${String(s).replace(/\s+/g, ' ').trim().slice(0, 160)}`)
    .join('\n');
}

function findCallIndex(pattern: RegExp): number {
  const index = mockQuery.mock.calls.findIndex(([s]: any[]) => pattern.test(String(s)));
  if (index === -1) throw new Error(`No query matched ${pattern}. Observed:\n${observedSql()}`);
  return index;
}

function findCall(pattern: RegExp): [string, any[]] {
  const [sql, params] = mockQuery.mock.calls[findCallIndex(pattern)];
  return [String(sql), (params ?? []) as any[]];
}

function findCalls(pattern: RegExp): [string, any[]][] {
  return mockQuery.mock.calls
    .filter(([s]: any[]) => pattern.test(String(s)))
    .map(([sql, params]: any[]) => [String(sql), (params ?? []) as any[]] as [string, any[]]);
}

function hasCall(pattern: RegExp): boolean {
  return mockQuery.mock.calls.some(([s]: any[]) => pattern.test(String(s)));
}

/** Global invocation order of the FIRST query matching `pattern` -- jest's
 * `invocationCallOrder` counter is shared across every mock, so these are
 * directly comparable with `deps.*` and `setInternalUserRlsContext` orders. */
function queryOrder(pattern: RegExp): number {
  return mockQuery.mock.invocationCallOrder[findCallIndex(pattern)];
}

function replyOrder(deps: FillDeps, index = 0): number {
  return (deps.queueReplyText as jest.Mock).mock.invocationCallOrder[index];
}

// ── per-turn fixtures ───────────────────────────────────────────────────

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

function lastReply(deps: FillDeps): string {
  const calls = (deps.queueReplyText as jest.Mock).mock.calls;
  return calls[calls.length - 1][3];
}

function allReplies(deps: FillDeps): string[] {
  return (deps.queueReplyText as jest.Mock).mock.calls.map((c: any[]) => c[3]);
}

const realValidate = jest.requireActual('../../../../../lambda/lib/application-answers').validateApplicationAnswers;

/** The one beforeEach every describe shares: fresh state, fresh router,
 * genuine validator. `mockReset` (not `clearAllMocks` alone) is used on
 * `mockQuery` so no stale implementation or once-queue can leak between
 * tests -- the router is then reinstalled. */
function resetFake(): void {
  jest.clearAllMocks();
  mockQuery.mockReset();
  fake = freshFake();
  installDbFake();
  (validateApplicationAnswers as jest.Mock).mockImplementation(realValidate);
}

// ─────────────────────────────────────────────────────────────────────────
// computeFillStep / fillStepFor -- the lane's step gate. Replaces the deleted
// `describe('computeNextStep')`: the walk itself (fields order, docs order,
// hasOwnProperty semantics, requirement widening) is the shared engine's and
// is covered in test/unit/lambda/lib/application-requirements.test.ts; what
// is pinned here is the LANE'S gate order and its two sprint-23 insertions
// (`details_not_requested`, `details_completed_at`), plus the deliberate
// absence of a certification step.
// ─────────────────────────────────────────────────────────────────────────

describe('computeFillStep / fillStepFor', () => {
  beforeEach(resetFake);

  it('walks required_fields in array order, skipping answered keys', async () => {
    setApp({
      required_fields: ['work_authorization', 'date_available', 'desired_pay'],
      application_answers: { work_authorization: true },
    });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'field', key: 'date_available', uncollectable: [] });
  });

  it('fields before docs: an unanswered field wins even when a required doc is also missing', async () => {
    setApp({ required_fields: ['work_authorization'], required_docs: ['resume'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'field', key: 'work_authorization', uncollectable: [] });
  });

  it('docs walk in required_docs array order, skipping present doc rows', async () => {
    setApp(
      { required_docs: ['resume', 'driver_license', 'work_auth_doc'] },
      { haveDocs: ['resume'] },
    );

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'doc', docType: 'driver_license', uncollectable: [] });
  });

  it('a vault-only doc is synced onto the job and never re-asked (syncDocumentSnapshots)', async () => {
    // The engine header's binding reason for `syncDocumentSnapshots: true`:
    // `have_docs` is JOB-SCOPED (091's hire gate counts job rows only), so
    // without the copy a resume uploaded through the web vault (job_id NULL)
    // would read as missing forever. The vault-inclusive predicate that used
    // to live in this lane's own doc probe now lives in
    // copyRequiredDocumentSnapshots (applications.ts:109).
    setApp(
      { required_docs: ['resume', 'driver_license'] },
      { haveDocs: [], vaultDocs: ['resume'] },
    );

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'doc', docType: 'driver_license', uncollectable: [] });
    const [copySql, copyParams] = findCall(SQL.copyNonCert);
    expect(copySql).toMatch(/\(job_id IS NULL OR job_id = \$1::uuid\)/);
    expect(copyParams).toEqual([JOB_ID, WORKER_ID, ['resume', 'driver_license']]);
    const [rereadSql, rereadParams] = findCall(SQL.docReread);
    expect(rereadSql).toMatch(/worker_id = \$1 AND job_id = \$2/);
    expect(rereadParams).toEqual([WORKER_ID, JOB_ID]);
  });

  it('sets the worker_documents RLS context before the snapshot copy write', async () => {
    setApp({ required_docs: ['resume'] });

    await computeFillStep(client, APPLICATION_ID);

    expect(setInternalUserRlsContext).toHaveBeenCalledWith(client, WORKER_ID);
    // worker_documents is FORCE ROW LEVEL SECURITY (005): with the GUC unset
    // the copy writes nothing and the re-read returns zero rows, so every
    // required doc reads as missing forever.
    const rlsOrder = (setInternalUserRlsContext as jest.Mock).mock.invocationCallOrder[0];
    expect(rlsOrder).toBeLessThan(queryOrder(SQL.copyNonCert));
    expect(rlsOrder).toBeLessThan(queryOrder(SQL.docReread));
  });

  it('a job with no documents issues exactly ONE query -- no GUC, no copy, no re-read', async () => {
    setApp({ required_fields: ['work_authorization'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'field', key: 'work_authorization', uncollectable: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(hasCall(SQL.copyNonCert)).toBe(false);
    expect(hasCall(SQL.docReread)).toBe(false);
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('uncollectable ssn never blocks the walk and is reported separately', async () => {
    setApp({ required_docs: ['ssn', 'resume'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'doc', docType: 'resume', uncollectable: ['ssn'] });
  });

  it('complete when only uncollectable items remain', async () => {
    setApp({ required_docs: ['ssn'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'complete', uncollectable: ['ssn'] });
  });

  it('exit application_gone when the application row is missing (and the snapshot is null)', async () => {
    setAppMissing();

    const { step, snapshot } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'exit', reason: 'application_gone', uncollectable: [] });
    expect(snapshot).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fillStepFor(null) is application_gone without touching the DB', () => {
    expect(fillStepFor(null)).toEqual({ kind: 'exit', reason: 'application_gone', uncollectable: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['filled', 'closed'])('exit job_inactive when job status is %s', async (job_status) => {
    setApp({ job_status, required_docs: ['ssn'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'exit', reason: 'job_inactive', uncollectable: ['ssn'] });
  });

  it.each(['hired', 'not_interested'])(
    'exit application_closed when application status is %s',
    async (application_status) => {
      setApp({ application_status, required_docs: ['ssn'] });

      const { step } = await computeFillStep(client, APPLICATION_ID);

      expect(step).toEqual({ kind: 'exit', reason: 'application_closed', uncollectable: ['ssn'] });
    },
  );

  it('exit details_not_requested for an apply-stage snapshot (sprint 23 stage gate)', async () => {
    // B4.0 section 7 / application-fill.ts:130 -- the lane arms only after
    // the employer asked, and applies the gate on EVERY turn.
    setApp({ details_requested_at: null, required_fields: ['work_authorization'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'exit', reason: 'details_not_requested', uncollectable: [] });
  });

  it('the stage gate reads the TIMESTAMP, not the literal status: details_requested -> contacted keeps the fill alive', async () => {
    setApp({ application_status: 'contacted', required_fields: ['work_authorization'] });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'field', key: 'work_authorization', uncollectable: [] });
  });

  it('details_completed_at set reads as complete even with an outstanding field', async () => {
    setApp({
      details_completed_at: '2026-09-01T12:00:00.000Z',
      required_fields: ['work_authorization'],
    });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'complete', uncollectable: [] });
  });

  it('certifications are deliberately NOT a step in this lane: a cert-only gap reads as complete', async () => {
    // application-fill.ts:76-82 -- the certification-claim collector is
    // web-only, so `fillStepFor` never returns a certification step. See the
    // production finding recorded in the completion tests below for what the
    // worker is actually told in this state.
    setApp({
      certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: false }],
    });

    const { step } = await computeFillStep(client, APPLICATION_ID);

    expect(step).toEqual({ kind: 'complete', uncollectable: [] });
  });

  it('paused jobs and contacted/talking applications continue (spec section 9)', async () => {
    for (const overrides of [
      { job_status: 'paused' },
      { application_status: 'contacted' },
      { application_status: 'talking' },
    ]) {
      resetFake();
      setApp(overrides);
      const { step } = await computeFillStep(client, APPLICATION_ID);
      expect(step).toEqual({ kind: 'complete', uncollectable: [] });
    }
  });

  it('the snapshot SELECT joins on ja.id = $1 with the applicationId param', async () => {
    await computeFillStep(client, APPLICATION_ID);

    const [sql, params] = findCall(SQL.snapshot);
    expect(sql).toMatch(/FROM job_applications ja JOIN jobs j ON j\.id = ja\.job_id/);
    expect(sql).toMatch(/ja\.id = \$1/);
    expect(params).toEqual([APPLICATION_ID]);
  });

  it('returns the snapshot alongside the step so completion needs no second synced load', async () => {
    setApp({ required_fields: ['work_authorization'] });

    const { snapshot } = await computeFillStep(client, APPLICATION_ID);

    expect(snapshot).toMatchObject({
      applicationId: APPLICATION_ID,
      workerId: WORKER_ID,
      jobId: JOB_ID,
      stage: 'details',
      requiredFields: ['work_authorization'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// fillCountsFor -- the intro's "N questions and M documents", now PURE
// (replaces the deleted `countRemainingRequirements` describe: that function
// moved to the shared engine and is tested there).
// ─────────────────────────────────────────────────────────────────────────

describe('fillCountsFor', () => {
  beforeEach(resetFake);

  async function snapshotOf(overrides: Record<string, unknown>, fixture: Partial<AppFixture> = {}) {
    setApp(overrides, fixture);
    const { snapshot } = await computeFillStep(client, APPLICATION_ID);
    return snapshot;
  }

  it('counts unanswered required fields and undelivered required docs', async () => {
    const snapshot = await snapshotOf({
      application_answers: { work_authorization: true },
      required_fields: ['work_authorization', 'date_available', 'desired_pay'],
      required_docs: ['resume', 'driver_license'],
    }, { haveDocs: ['resume'] });

    expect(fillCountsFor(snapshot)).toEqual({ nFields: 2, nDocs: 1, uncollectable: [] });
  });

  it('reports uncollectable doc types (legacy ssn) separately, never counted in nDocs', async () => {
    const snapshot = await snapshotOf({ required_docs: ['ssn'] });

    expect(fillCountsFor(snapshot)).toEqual({ nFields: 0, nDocs: 0, uncollectable: ['ssn'] });
  });

  it('zero counts when every field is answered and every doc is on file', async () => {
    const snapshot = await snapshotOf({
      application_answers: { work_authorization: true },
      required_fields: ['work_authorization'],
      required_docs: ['resume'],
    }, { haveDocs: ['resume'] });

    expect(fillCountsFor(snapshot)).toEqual({ nFields: 0, nDocs: 0, uncollectable: [] });
  });

  it('a null snapshot (vanished application) counts nothing rather than throwing', () => {
    expect(fillCountsFor(null)).toEqual({ nFields: 0, nDocs: 0, uncollectable: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// workerApplicationUrl / matchesFillEscape / localizeDocList -- the small
// exported helpers the arm and completion arms compose their copy from.
// ─────────────────────────────────────────────────────────────────────────

describe('workerApplicationUrl', () => {
  const ORIGINAL = process.env.PUBLIC_SITE_BASE_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_SITE_BASE_URL;
    else process.env.PUBLIC_SITE_BASE_URL = ORIGINAL;
  });

  it('honors PUBLIC_SITE_BASE_URL (wired onto the processor Lambda by whatsapp-stack.ts)', () => {
    process.env.PUBLIC_SITE_BASE_URL = 'https://staging.example.com';

    expect(workerApplicationUrl('es', APPLICATION_ID)).toBe(
      `https://staging.example.com/es/worker/applications/${APPLICATION_ID}`,
    );
  });

  it('strips trailing slashes so the path never doubles up', () => {
    process.env.PUBLIC_SITE_BASE_URL = 'https://staging.example.com///';

    expect(workerApplicationUrl('en', APPLICATION_ID)).toBe(
      `https://staging.example.com/en/worker/applications/${APPLICATION_ID}`,
    );
  });

  it('falls back to the literal production base rather than emitting "undefined/..."', () => {
    delete process.env.PUBLIC_SITE_BASE_URL;

    expect(workerApplicationUrl('en', APPLICATION_ID)).toBe(
      `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`,
    );
  });
});

describe('matchesFillEscape', () => {
  it.each(['chats', 'cerrar', 'ayuda', 'soporte', 'perfil', 'aplicaciones', 'applications'])(
    'reserved command "%s" is an escape',
    (body) => {
      expect(matchesFillEscape(body)).toBe(true);
    },
  );

  it.each(['jobs', 'trabajos', 'empleos', 'job', 'trabajo', 'empleo'])(
    'the EXACT jobs keyword "%s" is an escape',
    (body) => {
      expect(matchesFillEscape(body)).toBe(true);
    },
  );

  it.each(['1 aceptar', '3 no', '2 info'])('typed job action "%s" is an escape', (body) => {
    expect(matchesFillEscape(body)).toBe(true);
  });

  it.each([
    'trabajo de pintor 5 anos', // NOT isJobsKeyword's prefix grammar (spec 6.3)
    'hola',
    '1',
    'si',
    '1990-04-03',
    '25 an hour',
  ])('"%s" is a legitimate answer, not an escape', (body) => {
    expect(matchesFillEscape(body)).toBe(false);
  });
});

describe('localizeDocList', () => {
  it('localizes known doc types and falls back to the raw code for unknown ones', () => {
    expect(localizeDocList(['ssn', 'work_auth_doc'], 'en')).toBe('SSN card / ITIN, Work authorization document');
    expect(localizeDocList(['ssn'], 'es')).toBe('Tarjeta SSN / ITIN');
    expect(localizeDocList(['mystery_doc'], 'en')).toBe('mystery_doc');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// armFill (sprint 23) -- THE one place stage 2 is armed. Its snapshot
// argument is produced by running the REAL `loadRequirementSnapshot` through
// the fake, so the camelCase shape armFill gates on can never drift from the
// snake_case row fixture.
// ─────────────────────────────────────────────────────────────────────────

describe('armFill', () => {
  beforeEach(resetFake);

  /** Loads the production-shaped snapshot, then CLEARS the call log (keeping
   * the router installed) so every assertion below sees only armFill's own
   * traffic.
   *
   * UNSYNCED, exactly like the one real caller (processor.ts:2120): the
   * ownership check has to run before any write, so the vault-document copy
   * happens inside armFill's own synced load. A synced load here would do
   * the copying first and armFill would report nothing reused. */
  async function loadSnapshotAndClear(): Promise<RequirementSnapshot> {
    const snapshot = await loadRequirementSnapshot(client, APPLICATION_ID);
    mockQuery.mockClear();
    (setInternalUserRlsContext as jest.Mock).mockClear();
    return snapshot!;
  }

  it.each([
    ['an apply-stage application', { details_requested_at: null }, 'details_not_requested'],
    ['a hired application', { application_status: 'hired' }, 'application_closed'],
    ['a filled job', { job_status: 'filled' }, 'job_inactive'],
    ['a closed job', { job_status: 'closed' }, 'job_inactive'],
  ])('refuses to arm %s and returns the gate reason, writing nothing', async (_label, overrides, reason) => {
    setApp({ ...overrides, required_fields: ['work_authorization'] });
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    const outcome = await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(outcome).toEqual({ armed: false, reason });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('arms: announces the profile check, seeds, names what it reused, then the counted intro and the first question', async () => {
    setApp({ required_fields: ['work_authorization', 'date_available'] });
    fake.defaults = { work_authorization: true };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    const outcome = await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(outcome).toEqual({ armed: true });
    // The seed merged work_authorization, so the intro advertises the ONE
    // question actually left -- armFill re-derives the counts post-seed.
    expect(allReplies(deps)).toEqual([
      fillMessage('intro_profile_check', 'en'),
      `${fillMessage('reuse_fields_line', 'en', { labels: fieldLabel('work_authorization', 'en') })}\n`
        + `\n${fillMessage('reuse_change_footer', 'en')}`,
      fillMessage('intro', 'en', { company: COMPANY, n_fields: '1', n_docs: '0' }),
      fieldQuestion('date_available', 'en'),
    ]);
    expect(ctx.jobId).toBe(JOB_ID);
  });

  it('announces the profile check BEFORE reading the defaults row, not after (transparency decision)', async () => {
    setApp({ required_fields: ['work_authorization', 'date_available'] });
    fake.defaults = { work_authorization: true };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(replyOrder(deps, 0)).toBeLessThan(queryOrder(SQL.defaultsSelect));
  });

  it('names the documents it attached from the vault, alongside the reused fields', async () => {
    setApp(
      { required_fields: ['date_available'], required_docs: ['work_auth_doc'] },
      { vaultDocs: ['work_auth_doc'] },
    );
    fake.defaults = { date_of_birth: '1990-04-03' };
    // date_of_birth is not asked by this job, so nothing is SEEDED -- the
    // summary is carried by the copied document alone.
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(allReplies(deps)[1]).toBe(
      `${fillMessage('reuse_docs_line', 'en', { docLabels: localizeDocList(['work_auth_doc'], 'en') })}\n`
      + `\n${fillMessage('reuse_change_footer', 'en')}`,
    );
    // ... and the requirement really was satisfied by the copy, which is the
    // silent behaviour this message exists to expose (incident mechanism 3).
    expect(allReplies(deps)[2]).toBe(fillMessage('intro', 'en', { company: COMPANY, n_fields: '1', n_docs: '0' }));
  });

  it('sends NO reuse summary when nothing was seeded and nothing was copied', async () => {
    setApp({ required_fields: ['work_authorization'] });
    fake.defaults = null;
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(allReplies(deps)).toEqual([
      fillMessage('intro_profile_check', 'en'),
      fillMessage('intro', 'en', { company: COMPANY, n_fields: '1', n_docs: '0' }),
      fieldQuestion('work_authorization', 'en'),
    ]);
    // The arm write's scrub cleared it; nothing re-set it.
    expect(ctx.stateContext.fill_reused).toBeNull();
  });

  // ── THE INCIDENT ITSELF ───────────────────────────────────────────────
  // 2026-09-04T04:41:58Z: a worker tapped Start and got "Faltan 0 preguntas
  // y 0 documentos. Empezamos:" followed immediately by the completion
  // message -- their details went to the employer in the same turn, built
  // entirely out of answers given for a DIFFERENT job.
  it('with everything pre-filled it does NOT complete: it asks for an explicit LISTO and arms fill_confirm', async () => {
    setApp({ required_fields: ['work_authorization', 'date_of_birth'] });
    fake.defaults = { work_authorization: true, date_of_birth: '1990-04-03' };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    const outcome = await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(outcome).toEqual({ armed: true });
    expect(allReplies(deps)).toEqual([
      fillMessage('intro_profile_check', 'en'),
      `${fillMessage('reuse_fields_line', 'en', {
        labels: `${fieldLabel('work_authorization', 'en')}, ${fieldLabel('date_of_birth', 'en')}`,
      })}\n\n${fillMessage('reuse_change_footer', 'en')}`,
      fillMessage('confirm_all_prefilled', 'en'),
    ]);
    // The two messages the incident sent are BOTH absent.
    expect(allReplies(deps)).not.toContain(fillMessage('intro', 'en', { company: COMPANY, n_fields: '0', n_docs: '0' }));
    expect(allReplies(deps).some((r) => r.includes('we sent your details'))).toBe(false);
    // And nothing was recorded as complete.
    expect(hasCall(SQL.detailsComplete)).toBe(false);
    expect(ctx.stateContext.fill_confirm).toEqual({ at: NOW_MS });
    expect(ctx.stateContext.fill_reused).toEqual({
      fields: ['work_authorization', 'date_of_birth'],
      docs: [],
    });
  });

  it('keeps the web_handoff note on the confirm message when an uncollectable doc remains', async () => {
    setApp({ required_fields: ['work_authorization'], required_docs: ['ssn'] });
    fake.defaults = { work_authorization: true };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(lastReply(deps)).toBe(
      `${fillMessage('confirm_all_prefilled', 'en')}\n\n`
      + `${fillMessage('web_handoff', 'en', {
        doc: localizeDocList(['ssn'], 'en'),
        url: workerApplicationUrl('en', APPLICATION_ID),
      })}`,
    );
  });

  it('refuses to reuse a per_application default even when the job asks for it (decision D2)', async () => {
    setApp({ required_fields: ['date_available', 'worked_here_before'] });
    // Exactly the incident's two leaked answers, sitting in a legacy blob.
    fake.defaults = { date_available: '2026-09-10', worked_here_before: { answer: true } };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(allReplies(deps)).toEqual([
      fillMessage('intro_profile_check', 'en'),
      fillMessage('intro', 'en', { company: COMPANY, n_fields: '2', n_docs: '0' }),
      fieldQuestion('date_available', 'en'),
    ]);
  });

  it('seeds BEFORE the intro (order): the intro can never advertise a question the seed just answered', async () => {
    setApp({ required_fields: ['work_authorization', 'date_available'] });
    fake.defaults = { work_authorization: true };
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    // Index 2, not 0: L3 puts `intro_profile_check` and the reuse summary
    // ahead of the counted intro. The seed must still precede the COUNTS --
    // and `intro_profile_check` must precede the seed (asserted above).
    const introIndex = allReplies(deps).indexOf(
      fillMessage('intro', 'en', { company: COMPANY, n_fields: '1', n_docs: '0' }),
    );
    expect(introIndex).toBe(2);
    expect(queryOrder(SQL.defaultsSelect)).toBeLessThan(replyOrder(deps, introIndex));
    expect(queryOrder(SQL.mergeUpdate)).toBeLessThan(replyOrder(deps, introIndex));
    const [, seedParams] = findCall(SQL.mergeUpdate);
    expect(JSON.parse(seedParams[0])).toEqual({ work_authorization: true });
    expect(seedParams[1]).toBe(APPLICATION_ID);
  });

  it('a worker with no defaults row seeds nothing and still arms', async () => {
    setApp({ required_fields: ['work_authorization'] });
    fake.defaults = null;
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    const outcome = await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(outcome).toEqual({ armed: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fieldQuestion('work_authorization', 'en'));
  });

  it('the arm write clears BOTH lanes\' keys, the one-shot applications menu, and every L3 sub-state', async () => {
    // FILL_SCRUB (application-fill.ts:934): the fill lane and the sprint-23
    // prompt lane are mutually exclusive, and a stale numbered menu must
    // never stay addressable across an arm.
    setApp({ required_fields: ['work_authorization'] });
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({
      stateContext: {
        fill_pending: { key: 'desired_pay', stage: 'confirm', extracted: 1 } satisfies FillPendingConfirm,
        fill_cert_more_pending: true,
        fill_relay_override: true,
        fill_offer_application_id: 'stale-offer-id',
        prompt_application_id: 'stale-prompt-app',
        prompt_last_prompt_at: 123,
        applications_menu: { ids: ['x'], at: 1 },
        pending_picker: { kind: 'chats' as const, threads: [] },
        // L3 sub-states from a PREVIOUS fill: a stale change menu would let
        // a bare digit correct an answer on an application the worker has
        // moved on from, and a stale fill_confirm would let a later LISTO
        // send the wrong one.
        fill_reused: { fields: ['home_address'], docs: ['resume'] },
        fill_confirm: { at: 1 },
        fill_change_menu: { items: [{ kind: 'field' as const, key: 'home_address' as const }], at: 1 },
        fill_doc_replace: 'resume',
      },
    });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(deps.updateStateContext).toHaveBeenCalledWith(client, CONVERSATION_ID, {
      fill_application_id: APPLICATION_ID,
      fill_pending: null,
      fill_cert_more_pending: null,
      fill_relay_override: null,
      fill_offer_application_id: null,
      prompt_application_id: null,
      prompt_last_prompt_at: null,
      applications_menu: null,
      pending_picker: null,
      fill_reused: null,
      fill_confirm: null,
      fill_change_menu: null,
      fill_doc_replace: null,
    });
  });

  it('switched_job is sent only when a DIFFERENT application was already armed', async () => {
    setApp({ required_fields: ['work_authorization'] });
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: { fill_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(allReplies(deps)[0]).toBe(fillMessage('switched_job', 'en'));
  });

  it.each([
    ['nothing was armed', undefined],
    ['the SAME application was already armed', APPLICATION_ID],
  ])('switched_job is NOT sent when %s', async (_label, previous) => {
    setApp({ required_fields: ['work_authorization'] });
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({
      stateContext: previous === undefined ? {} : { fill_application_id: previous },
    });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(allReplies(deps)).not.toContain(fillMessage('switched_job', 'en'));
  });

  it('appends the web_handoff note (doc + url) to the intro when an uncollectable doc remains', async () => {
    setApp({ required_fields: ['work_authorization'], required_docs: ['ssn'] });
    const snapshot = await loadSnapshotAndClear();
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    await armFill(client, ctx, snapshot, 'SMarm', FROM, deps);

    expect(allReplies(deps)[1]).toBe(
      `${fillMessage('intro', 'en', { company: COMPANY, n_fields: '1', n_docs: '0' })}\n\n`
      + `${fillMessage('web_handoff', 'en', {
        doc: localizeDocList(['ssn'], 'en'),
        url: workerApplicationUrl('en', APPLICATION_ID),
      })}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// L3: the all-pre-filled confirmation gate (decision: "the worker must
// explicitly confirm before the application is marked complete") and the
// CAMBIAR/CHANGE correction menu (decision D3: "let them replace one").
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — fill_confirm (all pre-filled)', () => {
  beforeEach(resetFake);

  /** Arms an application whose every requirement is already answered, in the
   * confirm sub-state armFill leaves behind. */
  function confirmCtx(overrides: Record<string, unknown> = {}): FillContext {
    setApp({
      required_fields: ['work_authorization', 'date_of_birth'],
      application_answers: { work_authorization: true, date_of_birth: '1990-04-03' },
    });
    return makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_confirm: { at: NOW_MS - 60_000 },
        fill_reused: { fields: ['work_authorization', 'date_of_birth'], docs: [] },
        ...overrides,
      },
    });
  }

  it.each([['LISTO'], ['listo'], ['DONE'], ['done'], [' Listo ']])(
    '%s completes through the ordinary completion path (stamp, then the completion reply)',
    async (body) => {
      const ctx = confirmCtx();
      const deps = makeDeps(ctx);

      const res = await handleFillMessage(client, ctx, incomingMsg(body), deps);

      expect(res).toEqual({ handled: true });
      expect(hasCall(SQL.detailsComplete)).toBe(true);
      expect(lastReply(deps)).toBe(fillMessage('completion', 'en', { company: COMPANY }));
      // The stamp lands BEFORE the worker is told their details went out.
      expect(queryOrder(SQL.detailsComplete)).toBeLessThan(replyOrder(deps, 0));
      expect(ctx.stateContext.fill_confirm).toBeNull();
    },
  );

  it('an unrecognized reply repeats the confirm prompt exactly ONCE', async () => {
    const ctx = confirmCtx();
    const deps = makeDeps(ctx);

    const first = await handleFillMessage(client, ctx, incomingMsg('what?'), deps);
    expect(first).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('confirm_all_prefilled', 'en'));
    expect(ctx.stateContext.fill_confirm).toEqual({ at: NOW_MS - 60_000, repeated: true });
    expect(hasCall(SQL.detailsComplete)).toBe(false);

    const second = await handleFillMessage(client, ctx, incomingMsg('still what?'), deps);
    // Falls back to the lane's ordinary unknown handling -- no nagging.
    expect(second).toEqual({ handled: false });
    expect(allReplies(deps)).toHaveLength(1);
    // The state is KEPT, not cleared: a LISTO three turns later must still
    // work, and clearing it would leave the only way to send this
    // application a silent completion through some other route.
    expect(ctx.stateContext.fill_confirm).toEqual({ at: NOW_MS - 60_000, repeated: true });
    expect(hasCall(SQL.detailsComplete)).toBe(false);

    const later = await handleFillMessage(client, ctx, incomingMsg('LISTO'), deps);
    expect(later).toEqual({ handled: true });
    expect(hasCall(SQL.detailsComplete)).toBe(true);
  });

  it('never completes on its own: no reply at all can slip past the gate except LISTO/DONE/CAMBIAR', async () => {
    for (const body of ['1', 'si', 'yes', '2', 'ok', 'gracias']) {
      resetFake();
      const ctx = confirmCtx();
      const deps = makeDeps(ctx);
      await handleFillMessage(client, ctx, incomingMsg(body), deps);
      expect(hasCall(SQL.detailsComplete)).toBe(false);
    }
  });

  it('CHATS still escapes a confirm state (command escapes outrank the gate)', async () => {
    const ctx = confirmCtx();
    const deps = makeDeps(ctx);
    expect(await handleFillMessage(client, ctx, incomingMsg('CHATS'), deps)).toEqual({ handled: false });
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('CANCELAR still cancels a confirm state and scrubs it', async () => {
    const ctx = confirmCtx();
    const deps = makeDeps(ctx);
    expect(await handleFillMessage(client, ctx, incomingMsg('cancelar'), deps)).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('canceled', 'en'));
    expect(ctx.stateContext.fill_confirm).toBeNull();
    expect(hasCall(SQL.detailsComplete)).toBe(false);
  });
});

describe('handleFillMessage — CAMBIAR/CHANGE correction menu', () => {
  beforeEach(resetFake);

  function reusedCtx(
    reused: { fields: string[]; docs: string[] },
    appOverrides: Record<string, unknown> = {},
    fixture: Partial<{ haveDocs: string[]; vaultDocs: string[] }> = {},
  ): FillContext {
    setApp(appOverrides, fixture);
    return makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_reused: reused },
    });
  }

  it.each([['CAMBIAR'], ['cambiar'], ['CHANGE'], [' Change ']])(
    '%s lists the reused fields and copied docs as a numbered menu, and arms it',
    async (body) => {
      const ctx = reusedCtx(
        { fields: ['work_authorization', 'date_of_birth'], docs: ['resume'] },
        {
          required_fields: ['work_authorization', 'date_of_birth'],
          required_docs: ['resume'],
          application_answers: { work_authorization: true, date_of_birth: '1990-04-03' },
        },
        { haveDocs: ['resume'] },
      );
      const deps = makeDeps(ctx);

      const res = await handleFillMessage(client, ctx, incomingMsg(body), deps);

      expect(res).toEqual({ handled: true });
      expect(lastReply(deps)).toBe(
        `${fillMessage('change_menu_header', 'en')}\n\n`
        + `1. ${fieldLabel('work_authorization', 'en')}\n`
        + `2. ${fieldLabel('date_of_birth', 'en')}\n`
        + `3. ${localizeDocList(['resume'], 'en')}`,
      );
      expect(ctx.stateContext.fill_change_menu).toEqual({
        items: [
          { kind: 'field', key: 'work_authorization' },
          { kind: 'field', key: 'date_of_birth' },
          { kind: 'doc', docType: 'resume' },
        ],
        at: NOW_MS,
      });
    },
  );

  it('says so plainly when nothing was reused, instead of an empty menu', async () => {
    const ctx = reusedCtx({ fields: [], docs: [] }, { required_fields: ['work_authorization'] });
    const deps = makeDeps(ctx);

    expect(await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps)).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('change_nothing', 'en'));
    expect(ctx.stateContext.fill_change_menu).toBeUndefined();
  });

  it('works with no fill_reused key at all (a fill armed before this feature shipped)', async () => {
    const ctx = makeCtx({ stateContext: { fill_application_id: APPLICATION_ID } });
    setApp({ required_fields: ['work_authorization'] });
    const deps = makeDeps(ctx);

    expect(await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps)).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('change_nothing', 'en'));
  });

  it('picking a FIELD clears that key on THIS application only, then re-asks it', async () => {
    const ctx = reusedCtx(
      { fields: ['date_of_birth'], docs: [] },
      {
        required_fields: ['date_of_birth'],
        application_answers: { date_of_birth: '1990-04-03' },
      },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);

    const res = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(res).toEqual({ handled: true });
    const [, params] = findCall(SQL.clearAnswer);
    expect(params).toEqual(['date_of_birth', APPLICATION_ID]);
    // The key is really gone, so the engine re-derives it as the next step.
    expect(fake.apps.get(APPLICATION_ID)!.row!.application_answers).toEqual({});
    expect(lastReply(deps)).toBe(fieldQuestion('date_of_birth', 'en'));
    // The correction is NOT a profile edit: the saved default stands.
    expect(fake.defaultsWritten).toEqual([]);
    // One-shot menu, and the corrected item is off the reuse list.
    expect(ctx.stateContext.fill_change_menu).toBeNull();
    expect(ctx.stateContext.fill_reused).toEqual({ fields: [], docs: [] });
  });

  it('sets the RLS GUC before clearing (a missing GUC is a silent zero-row UPDATE)', async () => {
    const ctx = reusedCtx(
      { fields: ['date_of_birth'], docs: [] },
      { required_fields: ['date_of_birth'], application_answers: { date_of_birth: '1990-04-03' } },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    const setRlsOrder = (deps.setRls as jest.Mock).mock.invocationCallOrder[0];
    expect(setRlsOrder).toBeLessThan(queryOrder(SQL.clearAnswer));
  });

  it('picking a DOC deletes the job-scoped copy only -- never the vault row -- and re-asks for the file', async () => {
    const ctx = reusedCtx(
      { fields: [], docs: ['work_auth_doc'] },
      { required_docs: ['work_auth_doc'] },
      { haveDocs: ['work_auth_doc'], vaultDocs: ['work_auth_doc'] },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);

    const res = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(res).toEqual({ handled: true });
    const [sql, params] = findCall(SQL.docDelete);
    // job_id is bound, so the vault row (job_id IS NULL) can never match.
    expect(sql).toContain('job_id = $2');
    expect(params).toEqual([WORKER_ID, JOB_ID, 'work_auth_doc']);
    expect(fake.apps.get(APPLICATION_ID)!.vaultDocs).toEqual(['work_auth_doc']);
    expect(lastReply(deps)).toBe(docPrompt('work_auth_doc', 'en'));
    // The replacement slot is armed. Without it the next synced load would
    // re-copy the vault row and route the worker's replacement elsewhere.
    expect(ctx.stateContext.fill_doc_replace).toBe('work_auth_doc');
    expect((deps.setRls as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(queryOrder(SQL.docDelete));
  });

  it('the replacement upload lands on the replaced slot, then disarms it', async () => {
    const ctx = reusedCtx(
      { fields: [], docs: ['work_auth_doc'] },
      { required_docs: ['work_auth_doc', 'resume'] },
      { haveDocs: ['work_auth_doc'], vaultDocs: ['work_auth_doc'] },
    );
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PDF_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValue({ versionId: 'v1' });
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://api.twilio.test/m1', mediaContentType: 'application/pdf',
    }), deps);

    // Stored against work_auth_doc, NOT against `resume` (which is what the
    // engine's next-step walk would otherwise have said, since the vault
    // copy makes work_auth_doc read as satisfied again).
    const [, insertParams] = findCall(SQL.docInsert);
    expect(insertParams[2]).toBe('work_auth_doc');
    expect(ctx.stateContext.fill_doc_replace).toBeNull();
  });

  it('free text while a replacement is armed re-sends that doc prompt, not the next step', async () => {
    const ctx = reusedCtx(
      { fields: [], docs: ['work_auth_doc'] },
      { required_docs: ['work_auth_doc'] },
      { haveDocs: ['work_auth_doc'], vaultDocs: ['work_auth_doc'] },
    );
    const deps = makeDeps(ctx, { nowMs: () => NOW_MS + 10 * 60_000 });
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    await handleFillMessage(client, ctx, incomingMsg('un momento'), deps);

    expect(lastReply(deps)).toBe(docPrompt('work_auth_doc', 'en'));
  });

  it('an out-of-range number repeats the list once, then falls through', async () => {
    const ctx = reusedCtx(
      { fields: ['date_of_birth'], docs: [] },
      { required_fields: ['date_of_birth'], application_answers: { date_of_birth: '1990-04-03' } },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    const menuBody = lastReply(deps);

    expect(await handleFillMessage(client, ctx, incomingMsg('7'), deps)).toEqual({ handled: true });
    expect(allReplies(deps).slice(-2)).toEqual([
      fillMessage('change_menu_invalid', 'en'),
      menuBody,
    ]);
    expect(hasCall(SQL.clearAnswer)).toBe(false);

    expect(await handleFillMessage(client, ctx, incomingMsg('7'), deps)).toEqual({ handled: false });
    expect(ctx.stateContext.fill_change_menu).toBeNull();
  });

  it('is a ONE-SHOT menu: a non-digit reply clears it and is handled normally', async () => {
    const ctx = reusedCtx(
      { fields: ['work_authorization'], docs: [] },
      {
        required_fields: ['work_authorization', 'education'],
        application_answers: { work_authorization: true },
      },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);

    // A real answer to the current step (education) -- must NOT be eaten by
    // the menu, and must leave no stale menu behind to hijack a later digit.
    await handleFillMessage(client, ctx, incomingMsg('high school'), deps);

    expect(ctx.stateContext.fill_change_menu).toBeNull();
    expect(hasCall(SQL.clearAnswer)).toBe(false);
  });

  it('a CAMBIAR mid-fill (no confirm state) works the same way', async () => {
    const ctx = reusedCtx(
      { fields: ['date_of_birth'], docs: [] },
      {
        required_fields: ['date_of_birth', 'work_authorization'],
        application_answers: { date_of_birth: '1990-04-03' },
      },
    );
    const deps = makeDeps(ctx);

    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(findCall(SQL.clearAnswer)[1]).toEqual(['date_of_birth', APPLICATION_ID]);
    // date_of_birth is first in required_fields, so it is what gets re-asked.
    expect(lastReply(deps)).toBe(fieldQuestion('date_of_birth', 'en'));
  });

  // F7 (sprint 24). The only way `clearFieldAnswer` refuses is its
  // `details_completed_at IS NULL` guard -- i.e. the application was
  // completed somewhere else (the web stage-2 door) while this lane was
  // still armed. The worker must then be told the truth, never re-asked a
  // question about an application that is already sent, and never shown the
  // step that merely FOLLOWS the field they asked to fix.
  //
  // BEFORE F7 the refusal fell straight into `promptNextStep`, whose
  // `complete` arm answered a worker who had just asked to FIX something
  // with "we sent your details to <company>" -- a raced no-op reported as a
  // success, and the second time that copy was sent for the same
  // application.
  it('a refused clear (completed on the web meanwhile) says the application is locked, not the completion copy', async () => {
    const ctx = reusedCtx(
      { fields: ['date_of_birth'], docs: [] },
      {
        required_fields: ['date_of_birth', 'work_authorization'],
        application_answers: { date_of_birth: '1990-04-03', work_authorization: true },
        details_completed_at: '2026-09-03T00:00:00.000Z',
      },
    );
    const deps = makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);

    const res = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(res).toEqual({ handled: true });
    // The UPDATE ran and matched nothing, so the answer still stands.
    expect(findCall(SQL.clearAnswer)[1]).toEqual(['date_of_birth', APPLICATION_ID]);
    expect(fake.apps.get(APPLICATION_ID)!.row!.application_answers).toEqual({
      date_of_birth: '1990-04-03', work_authorization: true,
    });
    // The truth, with the one place the sent application can still be read.
    expect(lastReply(deps)).toBe(fillMessage('change_locked', 'en', {
      url: workerApplicationUrl('en', APPLICATION_ID),
    }));
    expect(allReplies(deps)).not.toContain(fillMessage('completion', 'en', { company: COMPANY }));
    expect(allReplies(deps)).not.toContain(fieldQuestion('work_authorization', 'en'));
    expect(allReplies(deps)).not.toContain(fieldQuestion('date_of_birth', 'en'));
    // No completion arm ran at all: no stamp attempt, no company lookup, no
    // continue-other scan.
    expect(hasCall(SQL.detailsComplete)).toBe(false);
    expect(hasCall(SQL.offerScan)).toBe(false);
    // The one-shot menu and both gates are gone, so no later digit or LISTO
    // can act on this application again...
    expect(ctx.stateContext.fill_change_menu).toBeNull();
    expect(ctx.stateContext.fill_confirm).toBeNull();
    expect(ctx.stateContext.fill_pending).toBeNull();
    // ...but the lane itself stays armed (F7 deliberately does not scrub):
    // the very next turn re-derives `complete` and the ordinary completion
    // arm disarms it then.
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
  });

  it('picking from a confirm state leaves the gate and lets the re-answer complete normally', async () => {
    setApp({
      required_fields: ['work_authorization'],
      application_answers: { work_authorization: true },
    });
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_confirm: { at: NOW_MS },
        fill_reused: { fields: ['work_authorization'], docs: [] },
      },
    });
    const deps = makeDeps(ctx);

    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);
    expect(ctx.stateContext.fill_confirm).toBeNull();
    expect(lastReply(deps)).toBe(fieldQuestion('work_authorization', 'en'));

    // Answering it themselves is an explicit act, so the ordinary
    // completion path applies -- no second confirmation.
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);
    expect(hasCall(SQL.detailsComplete)).toBe(true);
    expect(lastReply(deps)).toBe(fillMessage('completion', 'en', { company: COMPANY }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F2 (sprint 24): the CAMBIAR menu is a ONE-SHOT and must not outlive the
// turn after it was sent.
//
// `resolveChangeMenu` (step 5b) is what makes it one-shot -- but three
// branches of `handleFillMessage` return BEFORE 5b ever runs: the
// button/interactive payload escape (1), the media turn (2) and the
// picker-digit escape (4). A menu left standing through any of them hijacks
// the NEXT bare digit the worker types: several fields (work_authorization,
// education, military_service, worked_here_before, the entry loops) are
// answered with exactly '1'/'2', so the digit clears a stored answer instead
// of answering the question that was just asked.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — the CAMBIAR menu is a one-shot (F2)', () => {
  beforeEach(resetFake);

  /** Arms a menu over one reused field, on an application that still has
   * `work_authorization` outstanding -- so the question the worker is being
   * asked is answered with a bare '1', the exact digit a stale menu eats. */
  async function armedMenu(deps?: FillDeps): Promise<{ ctx: FillContext; deps: FillDeps }> {
    setApp({
      required_fields: ['education', 'work_authorization'],
      application_answers: { education: { level: 'high_school' } },
    });
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_reused: { fields: ['education'], docs: [] },
      },
    });
    const useDeps = deps ?? makeDeps(ctx);
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), useDeps);
    expect(ctx.stateContext.fill_change_menu).toEqual({
      items: [{ kind: 'field', key: 'education' }],
      at: NOW_MS,
    });
    return { ctx, deps: useDeps };
  }

  it('a media turn drops the menu, so the next digit answers the question instead of clearing an answer', async () => {
    const { ctx, deps } = await armedMenu();

    // The worker sends a photo rather than a number. The current step is a
    // FIELD step, so the media branch answers `field_step_media` and the
    // outstanding question (work_authorization) still stands.
    const media = await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://api.twilio.test/m1', mediaContentType: 'image/jpeg',
    }), deps);

    expect(media).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('field_step_media', 'en'));
    expect(ctx.stateContext.fill_change_menu).toBeNull();

    // ...so THIS '1' answers work_authorization and never touches education.
    await handleFillMessage(client, ctx, incomingMsg('1'), deps);
    expect(hasCall(SQL.clearAnswer)).toBe(false);
    expect(fake.apps.get(APPLICATION_ID)!.row!.application_answers).toEqual({
      education: { level: 'high_school' },
      work_authorization: true,
    });
  });

  it('a media turn that STORES a document also drops the menu', async () => {
    // TWO required docs on purpose: with only one, storing it completes the
    // application and `FILL_SCRUB` clears the menu for an unrelated reason,
    // so the test would pass against the bug.
    setApp(
      { required_docs: ['resume', 'driver_license'], application_answers: {} },
      { haveDocs: [], vaultDocs: [] },
    );
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_reused: { fields: [], docs: ['resume'] },
      },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PDF_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValue({ versionId: 'v1' });
    await handleFillMessage(client, ctx, incomingMsg('CAMBIAR'), deps);
    expect(ctx.stateContext.fill_change_menu).not.toBeNull();

    await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://api.twilio.test/m1', mediaContentType: 'application/pdf',
    }), deps);

    expect(findCall(SQL.docInsert)[1][2]).toBe('resume');
    // The fill advanced to the NEXT doc (no completion, so no FILL_SCRUB)...
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
    expect(hasCall(SQL.detailsComplete)).toBe(false);
    // ...and the menu is gone anyway.
    expect(ctx.stateContext.fill_change_menu).toBeNull();
  });

  it('a picker digit drops the menu and STILL escapes to the picker', async () => {
    const { ctx, deps } = await armedMenu();
    // A CHATS/list picker armed after the menu was sent: spec 6.4 gives the
    // picker every bare digit, so this '1' is NOT a menu pick.
    await deps.updateStateContext(client, CONVERSATION_ID, {
      pending_picker: { kind: 'chats' as const, threads: [] },
    });

    const res = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(res).toEqual({ handled: false });
    expect(ctx.stateContext.fill_change_menu).toBeNull();
    // The digit went to the picker, so nothing of the fill's own was touched.
    expect(hasCall(SQL.clearAnswer)).toBe(false);
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
  });

  it('a button payload drops the menu and STILL escapes', async () => {
    const { ctx, deps } = await armedMenu();

    const res = await handleFillMessage(client, ctx, incomingMsg('', {
      buttonPayload: 'accept:job-xyz',
    }), deps);

    expect(res).toEqual({ handled: false });
    expect(ctx.stateContext.fill_change_menu).toBeNull();
    expect(hasCall(SQL.clearAnswer)).toBe(false);
    // The escape itself is unchanged: fill state is KEPT, no reply queued.
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage -- field-step collection (parse, extract, confirm).
// `validateApplicationAnswers` runs for REAL in every test below except the
// two that deliberately override it.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage', () => {
  beforeEach(resetFake);

  it('deterministic boolean: "1" stores true for work_authorization, writes the defaults back, and prompts next step', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'date_available'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    // jobId is refreshed every turn from the step-5 job-context lookup.
    expect(ctx.jobId).toBe(JOB_ID);

    const [updateSql, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateSql).toMatch(/application_answers = application_answers \|\| \$1::jsonb/);
    expect(updateParams).toEqual([JSON.stringify({ work_authorization: true }), APPLICATION_ID]);

    // NEW in sprint 23: the merge now also writes the worker's cross-job
    // defaults back (B4.0 section 9) -- WhatsApp never did this before the
    // engine swap, so answering here pre-fills the NEXT application.
    expect(fake.defaultsWritten).toEqual([{ work_authorization: true }]);

    expect(lastReply(deps)).toBe(fieldQuestion('date_available', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('the merge is bounded by the engine SAVEPOINT: SAVEPOINT before the UPDATE, RELEASE after', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'date_available'] });

    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    const savepointIndex = mockQuery.mock.calls.findIndex(
      ([s]: any[]) => /^SAVEPOINT application_requirements_merge/.test(String(s)),
    );
    const releaseIndex = mockQuery.mock.calls.findIndex(
      ([s]: any[]) => /^RELEASE SAVEPOINT application_requirements_merge/.test(String(s)),
    );
    expect(savepointIndex).toBeGreaterThanOrEqual(0);
    expect(savepointIndex).toBeLessThan(findCallIndex(SQL.mergeUpdate));
    expect(releaseIndex).toBeGreaterThan(findCallIndex(SQL.mergeUpdate));
  });

  it('date answer echoes long-form confirm via fill_pending (no immediate write)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1990-04-03'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(ctx.stateContext.fill_pending).toEqual({
      key: 'date_of_birth', stage: 'confirm', extracted: '1990-04-03',
    });
    const reply = lastReply(deps);
    expect(reply).toContain('April 3, 1990');
    expect(reply).toContain(fillMessage('confirm_footer', 'en'));
  });

  it('confirm "1 si" merges validated value: UPDATE ... application_answers || $1 and clears fill_pending', async () => {
    // BINDING PIN (application-requirements.ts:580-587): the merge statement
    // text and its `[mergedJson, applicationId]` parameter pair are the one
    // contract the shared engine promises this lane. Only HOW the call is
    // selected changed (find-by-shape, not calls[1]); the two assertions
    // themselves are verbatim. The appended RETURNING is fine -- the regex is
    // unanchored and adds no parameter.
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'date_of_birth', stage: 'confirm', extracted: '1990-04-03' } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth', 'desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1 si'), deps);

    expect(result).toEqual({ handled: true });
    const [updateSql, updateParams] = findCall(SQL.mergeUpdate);
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
    setApp({ required_fields: ['home_address'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('2'), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1); // the step-5 job-context lookup only
    expect(hasCall(SQL.jobContext)).toBe(true);
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
    setApp({ required_fields: ['home_address'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('maybe?'), deps);

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
    setApp({ required_fields: ['home_address'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('vivo en 1 Main St Kyle TX 78640'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false); // no write yet
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
    setApp({ required_fields: ['education'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('preparatoria'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(expectedMessage);
  });

  it('too_long re-prompts with the mapped message, nothing written (never calls Bedrock)', async () => {
    const ctx = makeCtx();
    const invoke = jest.fn();
    const deps = makeDeps(ctx, { extraction: { invoke } });
    setApp({ required_fields: ['education'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('x'.repeat(2000)), deps);

    expect(result).toEqual({ handled: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
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
    setApp({ required_fields: ['references', 'military_service'] });

    // Step A: confirm the single entry -> "add another?" prompt, no merge yet.
    const resultA = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(resultA).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(ctx.stateContext.fill_pending).toEqual({
      key: 'references', stage: 'entry_another', entries: [oneReference],
    } satisfies FillPendingEntryAnother);
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));

    // Step B: "no more" -> validate + merge the WHOLE array once.
    const resultB = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(resultB).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ references: [oneReference] }), APPLICATION_ID]);
    expect(findCalls(SQL.mergeUpdate)).toHaveLength(1); // merged exactly once
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(lastReply(deps)).toBe(fieldQuestion('military_service', 'en'));
  });

  it('array key cap: confirming the 3rd entry auto-finalizes (merges the full 3-entry array), no entry_another offered', async () => {
    // validateReferences/validateWorkHistory (application-answers.ts) reject
    // arrays >3 -- without a matching cap here, a confirmed 4th entry would
    // sit in fill_pending.entries only for the whole-array validation to fail
    // at finalize time, discarding every already-confirmed entry.
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
    setApp({ required_fields: ['references', 'military_service'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ references: [e1, e2, e3] }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
    // Only ONE reply: the "merged, here's the next question" message --
    // entry_another is never offered once the cap is hit.
    expect(allReplies(deps)).toEqual([fieldQuestion('military_service', 'en')]);
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
    setApp({ required_fields: ['references', 'military_service'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ references: [e1, e2] }), APPLICATION_ID]);
    expect(ctx.stateContext.fill_pending).toBeNull();
  });

  it('CANCELAR clears every fill key, the PROMPT-lane keys, and the applications menu; sends canceled copy', async () => {
    // FILL_SCRUB (application-fill.ts:934) is shared by entry and every exit.
    // The prompt-lane keys are in it because the two lanes are mutually
    // exclusive; a stale fill_relay_override or fill_offer_application_id
    // would otherwise poison the worker's NEXT arm.
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
        fill_cert_more_pending: true,
        fill_relay_override: true,
        fill_offer_application_id: 'stale-offer-id',
        prompt_application_id: 'stale-prompt-app',
        prompt_last_prompt_at: 123,
        applications_menu: { ids: ['x'], at: 1 },
        fill_reused: { fields: ['home_address'], docs: [] },
        fill_confirm: { at: 1 },
        fill_change_menu: { items: [{ kind: 'field' as const, key: 'home_address' as const }], at: 1 },
        fill_doc_replace: 'resume',
      },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('  CanceLAR  '), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).not.toHaveBeenCalled(); // the guard short-circuits before any query
    expect(deps.updateStateContext).toHaveBeenCalledWith(client, CONVERSATION_ID, {
      fill_application_id: null,
      fill_pending: null,
      fill_cert_more_pending: null,
      fill_relay_override: null,
      fill_offer_application_id: null,
      fill_reused: null,
      fill_confirm: null,
      fill_change_menu: null,
      fill_doc_replace: null,
      prompt_application_id: null,
      prompt_last_prompt_at: null,
      applications_menu: null,
    });
    expect(lastReply(deps)).toBe(fillMessage('canceled', 'en'));
  });

  it('answers merge runs after deps.setRls and uses validated.value[key], never raw extraction', async () => {
    // setRls FIRST is binding: the engine's defaults write-back lands on
    // FORCE-RLS worker_application_defaults, and the engine only sets the GUC
    // itself on the document-sync path (skipped for a job with no docs).
    const rawExtracted = { street: '1 Main St', apartment: '  Unit 5  ', city: 'Kyle', state: 'TX', zip: '78640' };
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'home_address', stage: 'confirm', extracted: rawExtracted } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['home_address'] });

    await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(deps.setRls).toHaveBeenCalledWith(client, WORKER_ID);
    const setRlsOrder = (deps.setRls as jest.Mock).mock.invocationCallOrder[0];
    expect(setRlsOrder).toBeLessThan(queryOrder(SQL.mergeUpdate));

    const [, updateParams] = findCall(SQL.mergeUpdate);
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
    setApp({ required_fields: ['home_address'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    // MAX_PER_MERGE_JSON_LENGTH is checked before the SAVEPOINT, so neither
    // the guard nor the UPDATE ever runs.
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(hasCall(/^SAVEPOINT application_requirements_merge/)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('answer_too_long', 'en'));
  });

  it('desired_pay success: next prompt embeds the normalized amount/interval echo', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['desired_pay', 'work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('25/hour'), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
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
  ] as const)('desired_pay: "%s" parses to amount %i / %s', async (body, amount, interval) => {
    // "25 an hour" is the LITERAL worked example in this key's own
    // fieldQuestion/fieldRetryHint copy (application-fill-prompts.ts).
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['desired_pay', 'work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ desired_pay: { amount, interval } }), APPLICATION_ID]);
  });

  it('desired_pay "25 al ano" returns null (no yearly interval) and re-prompts', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('25 al ano'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fieldRetryHint('desired_pay', 'en'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// mergeFieldAnswers failure mapping. Every `MergeFailureReason` the shared
// engine can return has to land on worker-facing copy -- the lifecycle ones
// reuse the SAME exit copy `sendExitPrompt` sends, so a job that closed
// between the question and the answer reads identically whichever code path
// notices first (application-fill.ts:713 mergeFailureMessage).
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — mergeFieldAnswers failure reasons', () => {
  beforeEach(resetFake);

  function confirmingCtx() {
    return makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'date_of_birth', stage: 'confirm', extracted: '1990-04-03' } satisfies FillPendingConfirm,
      },
    });
  }

  it('too_large (post-merge column over MAX_ANSWERS_JSON_LENGTH) -> answer_too_long, rolled back to the savepoint', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth'] });
    fake.answersTotal = 20_000; // > 16384

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(/^ROLLBACK TO SAVEPOINT application_requirements_merge/)).toBe(true);
    expect(fake.defaultsWritten).toEqual([]); // never reached
    expect(lastReply(deps)).toBe(fillMessage('answer_too_long', 'en'));
    expect(ctx.stateContext.fill_pending).toBeNull();
  });

  it('not_found (application vanished between question and answer) -> exit_application_gone copy', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setAppMissing();

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('exit_application_gone', 'en'));
  });

  it('closed (application hired mid-turn) -> exit_application_closed copy', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth'], application_status: 'hired' });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('exit_application_closed', 'en'));
  });

  it('stage_locked (details never requested) -> exit_details_not_requested copy', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth'], details_requested_at: null });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('exit_details_not_requested', 'en'));
  });

  it('certification_document_limit (078 cap tripped by the doc sync) -> cert_cap copy', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    // The cap is raised by copyRequiredDocumentSnapshots inside the engine's
    // own snapshot load, so the job must ask for a document for the sync to
    // run at all.
    setApp({ required_fields: ['date_of_birth'], required_docs: ['certification_doc'] });
    fake.copyError = Object.assign(new Error('cap reached'), {
      code: '23514', constraint: 'certification_document_limit',
    });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('cert_cap', 'en'));
  });

  it('invalid (the validator rejects the confirmed value) -> the per-key retry hint', async () => {
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['date_of_birth'] });
    (validateApplicationAnswers as jest.Mock).mockReturnValueOnce({ ok: false, error: 'invalid_date_of_birth' });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fieldRetryHint('date_of_birth', 'en'));
    expect(ctx.stateContext.fill_pending).toBeNull();
  });

  it('invalid via unknown_answer_key: the engine refuses a key THIS job no longer asks for', async () => {
    // The lane's own de-required guard (application-fill.ts:1443) normally
    // catches this from `ctx.requiredFields`. This test pins the ENGINE'S
    // backstop underneath it, by making the two reads of the same turn
    // disagree -- a real intra-turn race: `fetchApplicationJobContext` (step
    // 5) still sees the key, then the employer's edit commits, and the merge's
    // own snapshot no longer lists it.
    const ctx = confirmingCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['desired_pay'] });
    fake.jobContextRequiredFields = ['date_of_birth', 'desired_pay'];

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(lastReply(deps)).toBe(fieldRetryHint('date_of_birth', 'en'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage — numbered-menu deterministic pre-parse.
// `education`/`military_service`/`worked_here_before` are extraction-bucket
// keys whose own FIELD_QUESTIONS copy is a numbered menu ("Responde con 1,
// 2, ... o 7." / "1. Si / 2. No") -- Bedrock extraction never sees that menu
// text, so a fully-compliant bare-digit reply was previously routed to
// extraction anyway, likely failing the confidence gate and looping the most
// compliant workers.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — numbered-menu deterministic pre-parse', () => {
  beforeEach(resetFake);

  it.each([
    ['1', 'none'],
    ['2', 'primary'],
    ['3', 'high_school'],
    ['4', 'ged'],
    ['5', 'some_college'],
    ['6', 'college'],
    ['7', 'trade_school'],
  ])('education: bare digit %s merges { level: %s } directly, no extraction call', async (digit, level) => {
    const ctx = makeCtx();
    const invoke = jest.fn();
    const deps = makeDeps(ctx, { extraction: { invoke } });
    setApp({ required_fields: ['education', 'military_service'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(digit), deps);

    expect(result).toEqual({ handled: true });
    expect(invoke).not.toHaveBeenCalled(); // never reaches Bedrock extraction
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ education: { level } }), APPLICATION_ID]);
    expect(lastReply(deps)).toBe(fieldQuestion('military_service', 'en'));
  });

  it.each([
    ['1', true],
    ['si', true],
    ['yes', true],
    ['2', false],
    ['no', false],
  ])('military_service: "%s" merges { served: %s } directly, no extraction call', async (body, served) => {
    const ctx = makeCtx();
    const invoke = jest.fn();
    const deps = makeDeps(ctx, { extraction: { invoke } });
    setApp({ required_fields: ['military_service', 'worked_here_before'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    expect(invoke).not.toHaveBeenCalled();
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ military_service: { served } }), APPLICATION_ID]);
    expect(lastReply(deps)).toBe(fieldQuestion('worked_here_before', 'en'));
  });

  it.each([
    ['1', true],
    ['si', true],
    ['yes', true],
    ['2', false],
    ['no', false],
  ])('worked_here_before: "%s" merges { answer: %s } directly, no extraction call', async (body, answer) => {
    const ctx = makeCtx();
    const invoke = jest.fn();
    const deps = makeDeps(ctx, { extraction: { invoke } });
    setApp({ required_fields: ['worked_here_before', 'education'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    expect(invoke).not.toHaveBeenCalled();
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ worked_here_before: { answer } }), APPLICATION_ID]);
    expect(lastReply(deps)).toBe(fieldQuestion('education', 'en'));
  });

  it('education: a non-menu free-text reply still goes to extraction (unaffected)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({ value: { level: 'high_school' }, confidence: { level: 0.9 } }),
    });
    setApp({ required_fields: ['education'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('preparatoria'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toMatchObject({ key: 'education', stage: 'confirm', extracted: { level: 'high_school' } });
  });

  it('military_service: a non-menu free-text reply still goes to extraction (unaffected)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({ value: { served: true, branch: 'Army' }, confidence: { served: 0.9, branch: 0.9 } }),
    });
    setApp({ required_fields: ['military_service'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('si, en el ejercito'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toMatchObject({ key: 'military_service', stage: 'confirm' });
  });

  it('worked_here_before: a non-menu free-text reply still extracts { answer, when } (unaffected)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({ value: { answer: true, when: '2022' }, confidence: { answer: 0.9, when: 0.9 } }),
    });
    setApp({ required_fields: ['worked_here_before'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('si, en 2022'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toMatchObject({
      key: 'worked_here_before',
      stage: 'confirm',
      extracted: { answer: true, when: '2022' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage — document steps. Real S3 key format:
// documents/${jobId}/${workerId}/${docType}/${uuid}.${ext} (worker-doc-
// upload-url.ts:93 scheme). copyRequiredDocumentSnapshots (applications.ts)
// runs FOR REAL here (not mocked) so its own INSERT...SELECT statements flow
// through the same routed fake -- only uploadDocumentToS3 (media.ts, real S3
// I/O) is mocked.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — document steps', () => {
  beforeEach(resetFake);

  const mediaMsg = (overrides: Partial<IncomingMessage> = {}) =>
    incomingMsg('', {
      numMedia: 1,
      mediaUrl: 'https://twilio.example/media/1',
      mediaContentType: 'image/jpeg',
      ...overrides,
    });

  it('media at doc step (non-cert): S3 PUT before the DB write, SAVEPOINT, DELETE-then-INSERT with version id, snapshot copy, next prompt', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-123' });
    setApp({ required_docs: ['resume', 'driver_license'] });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).toHaveBeenCalledWith(
      DOCUMENTS_BUCKET,
      expect.stringMatching(new RegExp(`^documents/${JOB_ID}/${WORKER_ID}/resume/[0-9a-f-]+\\.jpg$`)),
      JPEG_BYTES,
      'image/jpeg',
    );
    // Spec section 4.3's orphan-tolerated invariant: the S3 object is written
    // BEFORE the row that points at it.
    const s3Order = (uploadDocumentToS3 as jest.Mock).mock.invocationCallOrder[0];
    expect(s3Order).toBeLessThan(queryOrder(SQL.docInsert));
    // deps.setRls arms worker_documents' FORCE RLS policy before the write.
    expect((deps.setRls as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(queryOrder(SQL.docInsert));
    expect(findCallIndex(/^SAVEPOINT fill_doc/)).toBeLessThan(findCallIndex(SQL.docInsert));

    const [, deleteParams] = findCall(SQL.docDelete);
    expect(deleteParams).toEqual([WORKER_ID, JOB_ID, 'resume']);

    const [, insertParams] = findCall(SQL.docInsert);
    expect(insertParams).toEqual([
      WORKER_ID, JOB_ID, 'resume',
      expect.stringContaining('documents/'),
      'resume.jpg',
      JPEG_BYTES.length,
      'image/jpeg',
      'v-123',
      null, // cert_name -- always NULL for non-cert doc types (078's CHECK requires it)
    ]);
    expect(hasCall(/^RELEASE SAVEPOINT fill_doc/)).toBe(true);
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  it('certification_doc: plain INSERT (no DELETE), replies entry_another (cert loop), arms fill_cert_more_pending, does NOT advance', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-456' });
    setApp({ required_docs: ['certification_doc'] });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.docDelete)).toBe(false);
    const [, insertParams] = findCall(SQL.docInsert);
    expect(insertParams).toEqual([
      WORKER_ID, JOB_ID, 'certification_doc',
      expect.stringContaining('documents/'),
      'certification_doc.jpg',
      JPEG_BYTES.length,
      'image/jpeg',
      'v-456',
      null, // cert_name -- WhatsApp never collects a label; NULL lands in 078's unlabeled bucket
    ]);
    // promptNextStep never ran: only ONE snapshot load happened this turn
    // (the step derive), never a second one re-deriving after the store.
    expect(findCalls(SQL.snapshot)).toHaveLength(1);
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it.each(['certification_document_limit', 'certification_document_name_limit'])(
    'cert cap (%s): 23514 -> ROLLBACK TO SAVEPOINT -> cert_cap message -> advances',
    async (constraintName) => {
      const ctx = makeCtx();
      const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
      (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-789' });
      setApp({ required_docs: ['certification_doc', 'driver_license'] });
      fake.docInsertError = Object.assign(new Error('cap reached'), {
        code: '23514', constraint: constraintName,
      });

      const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

      expect(result).toEqual({ handled: true });
      expect(hasCall(/^ROLLBACK TO SAVEPOINT fill_doc/)).toBe(true);
      // 'satisfied' -> the requirement counts as met (the cap means rows
      // already exist), so the walk advances to the next doc.
      expect(allReplies(deps)).toEqual([fillMessage('cert_cap', 'en'), docPrompt('driver_license', 'en')]);
    },
  );

  it('non-cert 23505 -> ROLLBACK TO SAVEPOINT -> treated satisfied -> advances silently (first-write-wins)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-abc' });
    setApp({ required_docs: ['resume', 'driver_license'] });
    fake.docInsertError = Object.assign(new Error('duplicate'), { code: '23505' });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(/^ROLLBACK TO SAVEPOINT fill_doc/)).toBe(true);
    // No cert_cap / error reply -- exactly one reply, the advanced next-step prompt.
    expect(allReplies(deps)).toEqual([docPrompt('driver_license', 'en')]);
  });

  it('other SQLSTATE -> ROLLBACK TO SAVEPOINT -> rethrows (never mapped to satisfied/stay_pending)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-def' });
    setApp({ required_docs: ['resume'] });
    fake.docInsertError = Object.assign(new Error('server exploded'), { code: 'XX000' });

    await expect(handleFillMessage(client, ctx, mediaMsg(), deps)).rejects.toThrow('server exploded');

    expect(hasCall(/^ROLLBACK TO SAVEPOINT fill_doc/)).toBe(true);
    expect(findCalls(SQL.snapshot)).toHaveLength(1); // never reached promptNextStep
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('sniff mismatch vs claimed type -> doc_invalid_type reply, step stays pending, no S3 put', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PNG_BYTES) }); // real bytes sniff to image/png
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, mediaMsg({ mediaContentType: 'image/jpeg' }), deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(hasCall(SQL.docInsert)).toBe(false);
    expect(hasCall(/^SAVEPOINT fill_doc/)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('doc_invalid_type', 'en'));
  });

  it('oversize buffer (MediaTooLargeError) -> doc_too_large reply, no S3 put', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => { throw new MediaTooLargeError(); }) });
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('doc_too_large', 'en'));
  });

  it('downloadMedia throws a generic error -> doc_download_failed reply, no S3 put, NO rethrow (turn commits)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => { throw new Error('twilio 502'); }) });
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true }); // never rejects -- the turn commits
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('doc_download_failed', 'en'));
  });

  it('NumMedia>1 -> processes the first attachment, prepends doc_take_first to the resulting reply', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-multi' });
    setApp({ required_docs: ['resume', 'driver_license'] });

    const result = await handleFillMessage(client, ctx, mediaMsg({ numMedia: 2 }), deps);

    expect(result).toEqual({ handled: true });
    expect(uploadDocumentToS3).toHaveBeenCalledWith(DOCUMENTS_BUCKET, expect.any(String), JPEG_BYTES, 'image/jpeg');
    expect(lastReply(deps)).toBe(`${fillMessage('doc_take_first', 'en')}\n\n${docPrompt('driver_license', 'en')}`);
  });

  it('audio content type at a doc step -> voice_note_not_supported (templates.ts key, not v2_voice_not_supported), no download attempted', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, mediaMsg({ mediaContentType: 'audio/ogg' }), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.downloadMedia).not.toHaveBeenCalled();
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(t('voice_note_not_supported', 'en'));
  });

  it('media at a FIELD step -> field_step_media reply, nothing written', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization'] });

    const result = await handleFillMessage(client, ctx, mediaMsg(), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.downloadMedia).not.toHaveBeenCalled();
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(lastReply(deps)).toBe(fillMessage('field_step_media', 'en'));
  });

  it('free text at a doc step -> re-sends the doc prompt when outside the reprompt cooldown', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('hola'), deps);

    expect(result).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(docPrompt('resume', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('free text at a doc step within the reprompt cooldown -> absorbed silently, no duplicate prompt', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_last_prompt_at: NOW_MS - 1000 },
    });
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['resume'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('hola'), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.queueReplyText).not.toHaveBeenCalled();
  });

  it('outcome contract: stay_pending never triggers promptNextStep; stored does', async () => {
    // Scenario A: stay_pending (invalid type) -- no write and no SECOND
    // snapshot load (i.e. no promptNextStep re-derive).
    const ctxA = makeCtx();
    const depsA = makeDeps(ctxA, { downloadMedia: jest.fn(async () => PNG_BYTES) });
    setApp({ required_docs: ['resume'] });

    await handleFillMessage(client, ctxA, mediaMsg({ mediaContentType: 'image/jpeg' }), depsA);

    expect(findCalls(SQL.snapshot)).toHaveLength(1);
    expect(lastReply(depsA)).toBe(fillMessage('doc_invalid_type', 'en'));

    // Scenario B: stored -- promptNextStep DOES run (a second snapshot load,
    // and a DIFFERENT reply -- the next doc's prompt, not a doc-step error).
    resetFake();
    const ctxB = makeCtx();
    const depsB = makeDeps(ctxB, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-contract' });
    setApp({ required_docs: ['resume', 'driver_license'] });

    await handleFillMessage(client, ctxB, mediaMsg(), depsB);

    expect(findCalls(SQL.snapshot)).toHaveLength(2);
    expect(lastReply(depsB)).toBe(docPrompt('driver_license', 'en'));
  });

  it('cert loop: fill_cert_more_pending routes the next media straight to certification_doc, bypassing the step derive', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PDF_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-second-cert' });
    setApp({ required_docs: ['certification_doc'] }, { haveDocs: ['certification_doc'] });

    const result = await handleFillMessage(client, ctx, mediaMsg({
      mediaUrl: 'https://twilio.example/media/2', mediaContentType: 'application/pdf',
    }), deps);

    expect(result).toEqual({ handled: true });
    // computeFillStep never ran -- no snapshot SELECT at all this turn.
    expect(hasCall(SQL.snapshot)).toBe(false);
    const [, insertParams] = findCall(SQL.docInsert);
    expect(insertParams[2]).toBe('certification_doc');
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it('cert loop: "2 no" clears fill_cert_more_pending and advances (promptNextStep runs)', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['driver_license'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  // "1"/"si" is the exact affirmative entry_another's own copy invites
  // ("Responde con 1 o 2") -- it must NOT be treated the same as "no". The
  // flag stays armed and the worker gets told to send the file, with NO
  // advance (no step re-derive beyond the job-context lookup).
  it.each(['1', '1 si', 'si', 'yes'])('cert loop: "%s" keeps fill_cert_more_pending armed and re-sends docPrompt(certification_doc), no advance', async (body) => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['certification_doc'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).toHaveBeenCalledTimes(1); // the job-context lookup only
    expect(hasCall(SQL.snapshot)).toBe(false);
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
    expect(lastReply(deps)).toBe(docPrompt('certification_doc', 'en'));
  });

  it('cert loop: unclear text re-echoes (fillMessage reconfirm) and keeps the flag armed', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['certification_doc'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('maybe later'), deps);

    expect(result).toEqual({ handled: true });
    expect(hasCall(SQL.snapshot)).toBe(false);
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
    expect(lastReply(deps)).toBe(fillMessage('reconfirm', 'en'));
  });

  // The important regression test: a retryable error (invalid type here) on a
  // SECOND cert attempt must NOT clear the loop flag, or the worker's next
  // (valid) retry would route through the step derive to whatever's ACTUALLY
  // next and get stored under the WRONG doc_type.
  it('cert loop: invalid file during an active loop keeps the flag armed; the next valid upload still stores as certification_doc', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => PNG_BYTES) }); // claimed pdf, sniffs png -> mismatch
    setApp({ required_docs: ['certification_doc'] }, { haveDocs: ['certification_doc'] });

    const badResult = await handleFillMessage(client, ctx, mediaMsg({
      mediaUrl: 'https://twilio.example/media/bad', mediaContentType: 'application/pdf',
    }), deps);

    expect(badResult).toEqual({ handled: true });
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(hasCall(SQL.docInsert)).toBe(false);
    expect(lastReply(deps)).toBe(fillMessage('doc_invalid_type', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true); // NOT cleared

    mockQuery.mockClear();
    (uploadDocumentToS3 as jest.Mock).mockClear();
    (deps.queueReplyText as jest.Mock).mockClear();
    (deps.downloadMedia as jest.Mock).mockImplementation(async () => JPEG_BYTES);
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-retry-good' });

    const goodResult = await handleFillMessage(client, ctx, mediaMsg({
      mediaUrl: 'https://twilio.example/media/good',
    }), deps);

    expect(goodResult).toEqual({ handled: true });
    // Still routed as certification_doc, NOT mis-routed to some other doc
    // type via a step re-derive.
    expect(hasCall(SQL.snapshot)).toBe(false);
    const [, insertParams] = findCall(SQL.docInsert);
    expect(insertParams[2]).toBe('certification_doc');
    expect(lastReply(deps)).toBe(fillMessage('entry_another', 'en'));
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true);
  });

  it('cert loop: hitting the cap mid-loop (satisfied) clears the flag and advances', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-cap' });
    setApp({ required_docs: ['certification_doc', 'driver_license'] }, { haveDocs: ['certification_doc'] });
    fake.docInsertError = Object.assign(new Error('cap reached'), {
      code: '23514', constraint: 'certification_document_limit',
    });

    const result = await handleFillMessage(client, ctx, mediaMsg({ mediaUrl: 'https://twilio.example/media/cap' }), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
    expect(allReplies(deps)).toEqual([fillMessage('cert_cap', 'en'), docPrompt('driver_license', 'en')]);
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
// handleFillMessage — escapes / relay-override (spec section 6). The
// processor-level seam/dispatch-tail wiring lives in processor.test.ts; these
// tests lock down the precedence logic INSIDE handleFillMessage itself: which
// bodies return {handled:false} (an escape, fill state KEPT) vs
// {handled:true} (consumed by the fill), and in what order when two grammars
// could otherwise both match the same string.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — escapes / relay-override', () => {
  beforeEach(resetFake);

  it('a buttonPayload mid-fill escapes unconditionally, before even the media check -- no query, fill state untouched', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('', { buttonPayload: 'accept:job-xyz', numMedia: 1 }), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(deps.queueReplyText).not.toHaveBeenCalled();
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
  });

  it('an interactivePayload mid-fill escapes unconditionally -- no query, fill state untouched', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('', { interactivePayload: 'command:jobs' }), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
  });

  it('a bare 1-2 digit body escapes to the picker when pending_picker is set (spec 6.4) -- checked before any query', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        pending_picker: { kind: 'chats' as const, threads: [] },
      },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('the picker-digit escape wins even while the cert loop is armed (guarded conservatively: picker set always wins)', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        pending_picker: { kind: 'chats' as const, threads: [] },
        fill_cert_more_pending: true,
      },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('2'), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_cert_more_pending).toBe(true); // untouched
  });

  it('a bare digit WITHOUT a picker set is NOT an escape -- it resolves the pending confirmation as before', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toBeNull();
  });

  it('exact "trabajos" escapes the jobs listing (fill state kept)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('trabajos'), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).toHaveBeenCalledTimes(1); // the job-context refresh only
    expect(deps.queueReplyText).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
  });

  it('"trabajo de pintor 5 anos" is a legitimate field answer, NOT the jobs escape (spec 6.3: exact match only)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({ value: { level: 'high_school' }, confidence: { level: 0.2 } }),
    });
    setApp({ required_fields: ['education'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('trabajo de pintor 5 anos'), deps);

    expect(result).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fieldRetryHint('education', 'en'));
  });

  it.each([['chats'], ['cerrar'], ['ayuda'], ['soporte'], ['perfil']])(
    'command escape "%s" returns handled:false with fill state kept',
    async (body) => {
      const ctx = makeCtx();
      const deps = makeDeps(ctx);

      const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

      expect(result).toEqual({ handled: false });
      expect(mockQuery).toHaveBeenCalledTimes(1); // the job-context refresh only
      expect(deps.queueReplyText).not.toHaveBeenCalled();
      expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID);
    },
  );

  it('a typed job action ("3 aceptar") with no confirmation in flight escapes (spec section 6, item 9)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('3 aceptar'), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('"1 si" while fill_pending is awaiting confirmation is consumed as the confirmation FIRST, never as a typed job action escape (spec 6.3 exception)', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1 si'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(hasCall(SQL.mergeUpdate)).toBe(true);
    expect(lastReply(deps)).toBe(fieldQuestion('desired_pay', 'en'));
  });

  it('"2 no" while the cert loop is awaiting confirmation is consumed as the confirmation, not a typed job action escape', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_cert_more_pending: true },
    });
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['driver_license'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('2 no'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_cert_more_pending).toBeFalsy();
    expect(lastReply(deps)).toBe(docPrompt('driver_license', 'en'));
  });

  it('relay-override is consumed exactly once: clears the flag and falls through so the free text relays (spec 4.2)', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_relay_override: true },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('Hola, tengo una pregunta sobre el trabajo'), deps);

    expect(result).toEqual({ handled: false });
    expect(deps.updateStateContext).toHaveBeenCalledWith(client, CONVERSATION_ID, { fill_relay_override: null });
    expect(ctx.stateContext.fill_relay_override).toBeFalsy();
    expect(ctx.stateContext.fill_application_id).toBe(APPLICATION_ID); // only the one-turn flag is cleared
  });

  it('a SECOND free-text turn after the relay-override was already cleared feeds the fill normally (one-turn semantics)', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_relay_override: false },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateContext).not.toHaveBeenCalledWith(client, CONVERSATION_ID, { fill_relay_override: null });
  });

  it('CANCELAR still cancels even while relay-override is armed', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_relay_override: true },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('cancelar'), deps);

    expect(result).toEqual({ handled: true });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_relay_override).toBeNull();
    expect(lastReply(deps)).toBe(fillMessage('canceled', 'en'));
  });

  it('relay-override does not block a media turn -- a field-step photo still replies field_step_media', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_relay_override: true },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://twilio.example/media/x', mediaContentType: 'image/jpeg',
    }), deps);

    expect(result).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('field_step_media', 'en'));
    // The flag is only ever consumed on a TEXT turn (spec 4.2's "next
    // free-text message") -- the media branch never even inspects it.
    expect(ctx.stateContext.fill_relay_override).toBe(true);
  });

  it('a command escape (e.g. "ayuda") takes precedence over the relay-override consume, leaving the flag armed for the next real free-text turn', async () => {
    const ctx = makeCtx({
      stateContext: { fill_application_id: APPLICATION_ID, fill_relay_override: true },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('ayuda'), deps);

    expect(result).toEqual({ handled: false });
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(ctx.stateContext.fill_relay_override).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// promptNextStep -- the field/doc prompt plus the two terminal arms
// (completion, lifecycle exit).
// ─────────────────────────────────────────────────────────────────────────

describe('promptNextStep', () => {
  beforeEach(resetFake);

  it('sends the field question and stamps fill_last_prompt_at', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization'] });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fieldQuestion('work_authorization', 'en'));
    expect(ctx.stateContext.fill_last_prompt_at).toBe(NOW_MS);
  });

  it('complete: names the employer, scrubs every fill key AND the prompt-lane keys in one write', async () => {
    // A pre-existing STALE fill_offer_application_id must be cleared even
    // when THIS completion finds no new offer, and fill_relay_override must
    // not survive either -- neither has any other exit-time scrub site.
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
        fill_cert_more_pending: true,
        fill_relay_override: true,
        fill_offer_application_id: 'stale-offer-id',
        prompt_application_id: 'stale-prompt-app',
        prompt_last_prompt_at: 42,
        applications_menu: { ids: ['x'], at: 1 },
      },
    });
    const deps = makeDeps(ctx);

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fillMessage('completion', 'en', { company: COMPANY }));
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(ctx.stateContext.fill_cert_more_pending).toBeNull();
    expect(ctx.stateContext.fill_relay_override).toBeNull();
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(ctx.stateContext.prompt_application_id).toBeNull();
    expect(ctx.stateContext.prompt_last_prompt_at).toBeNull();
    expect(ctx.stateContext.applications_menu).toBeNull();
    expect(allReplies(deps)).toHaveLength(1); // completion only, no offer message
    // Exactly one state_context write carries the whole scrub.
    expect(deps.updateStateContext as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('complete: stamps details_completed_at BEFORE telling the worker their details went out', async () => {
    // BINDING order (application-fill.ts:853-868): the employer's applicant
    // list and 091's hire gate both read details_completed_at.
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(queryOrder(SQL.detailsComplete)).toBeLessThan(replyOrder(deps, 0));
    const [, params] = findCall(SQL.detailsComplete);
    expect(params).toEqual([APPLICATION_ID]);
    expect(findCall(SQL.detailsComplete)[0]).toMatch(/details_completed_at IS NULL/);
  });

  it('complete with uncollectable docs remaining: appends the web_handoff note naming them AND the worker\'s own stage-2 URL', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_docs: ['ssn'] });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(
      `${fillMessage('completion', 'en', { company: COMPANY })}\n\n`
      + `${fillMessage('web_handoff', 'en', {
        doc: localizeDocList(['ssn'], 'en'),
        url: workerApplicationUrl('en', APPLICATION_ID),
      })}`,
    );
  });

  it('complete with another incomplete application: offers continue_other and sets fill_offer_application_id in the SAME write', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    fake.otherApps = [{ id: OTHER_APPLICATION_ID, title: 'Cook' }];
    setOtherApp(OTHER_APPLICATION_ID, { job_id: OTHER_JOB_ID, required_fields: ['work_authorization'] });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(ctx.stateContext.fill_offer_application_id).toBe(OTHER_APPLICATION_ID);
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(allReplies(deps)).toEqual([
      fillMessage('completion', 'en', { company: COMPANY }),
      fillMessage('continue_other', 'en', { job_title: 'Cook' }),
    ]);
    // The offer id rides in the SAME write as the scrub -- never a second one.
    expect(deps.updateStateContext as jest.Mock).toHaveBeenCalledTimes(1);
    expect(deps.updateStateContext).toHaveBeenCalledWith(
      client,
      CONVERSATION_ID,
      expect.objectContaining({ fill_application_id: null, fill_offer_application_id: OTHER_APPLICATION_ID }),
    );
  });

  it('the continue-other SQL narrows on the stage columns themselves (sprint 23)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    const [sql, params] = findCall(SQL.offerScan);
    // An application nobody asked details for is NOT something to offer to
    // continue, and re-deriving that per candidate would burn a synced load.
    expect(sql).toMatch(/ja\.details_requested_at IS NOT NULL/);
    expect(sql).toMatch(/ja\.details_completed_at IS NULL/);
    expect(sql).toMatch(/j\.status IN \('active','paused'\)/);
    expect(sql).toMatch(/ja\.status IN \('pending','contacted','talking'\)/);
    expect(params).toEqual([WORKER_ID, APPLICATION_ID]);
  });

  it('continue-other scan skips an already-complete candidate and offers the next one', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    fake.otherApps = [
      { id: OTHER_APPLICATION_ID, title: 'Already Done' },
      { id: OTHER_APPLICATION_ID_2, title: 'Still Open' },
    ];
    setOtherApp(OTHER_APPLICATION_ID, { job_id: OTHER_JOB_ID }); // no gap
    setOtherApp(OTHER_APPLICATION_ID_2, { job_id: OTHER_JOB_ID_2, required_fields: ['work_authorization'] });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(ctx.stateContext.fill_offer_application_id).toBe(OTHER_APPLICATION_ID_2);
    expect(lastReply(deps)).toBe(fillMessage('continue_other', 'en', { job_title: 'Still Open' }));
  });

  it('continue-other scan caps at 5 candidates: a real gap on the 6th is never even loaded', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    const candidateIds = Array.from({ length: 6 }, (_, i) => `cand-${i}`);
    fake.otherApps = candidateIds.map((id) => ({ id, title: `Job ${id}` }));
    candidateIds.forEach((id, i) => {
      // The first five are already complete; the SIXTH has a real gap and
      // must never be reached.
      setOtherApp(id, {
        job_id: `job-${i}`,
        required_fields: i === 5 ? ['work_authorization'] : [],
      });
    });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(ctx.stateContext.fill_offer_application_id).toBeNull(); // always written, even with no offer
    expect(allReplies(deps)).toHaveLength(1); // completion only, no offer
    const loadedIds = findCalls(SQL.snapshot).map(([, params]) => params[0]);
    expect(loadedIds).toContain('cand-4');
    expect(loadedIds).not.toContain('cand-5');
  });

  // The full EXIT_MESSAGE_KEYS table (application-fill.ts:920): every
  // lifecycle reason maps to its copy, and every exit runs the SAME full
  // scrub the completion arm does -- but never an offer.
  it.each([
    ['job_inactive', { job_status: 'filled' }, 'exit_job_inactive'],
    ['application_closed', { application_status: 'hired' }, 'exit_application_closed'],
    ['details_not_requested', { details_requested_at: null }, 'exit_details_not_requested'],
  ] as const)('exit %s: mapped copy, full scrub, no continue-other scan', async (_reason, overrides, messageKey) => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
        fill_cert_more_pending: true,
        fill_relay_override: true,
        fill_offer_application_id: 'stale-offer-id',
        prompt_application_id: 'stale-prompt-app',
        prompt_last_prompt_at: 7,
        applications_menu: { ids: ['x'], at: 1 },
      },
    });
    const deps = makeDeps(ctx);
    setApp({ ...overrides, required_fields: ['work_authorization'] });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fillMessage(messageKey, 'en'));
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(ctx.stateContext.fill_cert_more_pending).toBeNull();
    expect(ctx.stateContext.fill_relay_override).toBeNull();
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(ctx.stateContext.prompt_application_id).toBeNull();
    expect(ctx.stateContext.prompt_last_prompt_at).toBeNull();
    expect(ctx.stateContext.applications_menu).toBeNull();
    expect(hasCall(SQL.offerScan)).toBe(false);
    expect(hasCall(SQL.detailsComplete)).toBe(false);
  });

  it('exit application_gone (application row missing): mapped copy, full scrub, one query only', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_cert_more_pending: true,
        fill_relay_override: true,
        fill_offer_application_id: 'stale-offer-id',
      },
    });
    const deps = makeDeps(ctx);
    setAppMissing();

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(lastReply(deps)).toBe(fillMessage('exit_application_gone', 'en'));
    expect(ctx.stateContext.fill_application_id).toBeNull();
    expect(ctx.stateContext.fill_cert_more_pending).toBeNull();
    expect(ctx.stateContext.fill_relay_override).toBeNull();
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('an outstanding CERTIFICATION is not stamped and DOES get the web_handoff link', async () => {
    // `fillStepFor` (application-fill.ts) never returns a certification step
    // -- that collector is web-only -- so a cert-only gap takes the
    // completion arm. Two halves must hold together:
    //   - `markDetailsCompleteIfDone` REFUSES to stamp (computeRemaining()
    //     .complete is false), so the employer's list and 091's hire gate
    //     still read the application as incomplete; and
    //   - the worker gets the `web_handoff` link naming the certification,
    //     which is exactly what the module header promises. Before the fix
    //     the link was appended only for an uncollectable DOC (the legacy
    //     `ssn` bucket), so a cert-only gap told the worker they were done
    //     and gave them no way to finish.
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({
      certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: false }],
    });

    await promptNextStep(client, ctx, 'SMinbound', FROM, deps);

    expect(hasCall(SQL.detailsComplete)).toBe(false); // the engine refuses to stamp
    const reply = allReplies(deps).join('\n');
    expect(reply).toContain(fillMessage('completion', 'en', { company: COMPANY }));
    // The employer's own requirement name is what the link names.
    expect(reply).toContain(fillMessage('web_handoff', 'en', {
      doc: 'OSHA 10',
      url: workerApplicationUrl('en', APPLICATION_ID),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage — continue-other offer resolution. The seam gate itself
// (processor.ts) is covered at the integration level in processor.test.ts;
// these lock down `resolveOfferOnlyTurn`'s own behavior when
// `fill_application_id` is unset but `fill_offer_application_id` is.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — continue-other offer resolution', () => {
  beforeEach(resetFake);

  it('neither fill_application_id nor fill_offer_application_id set: handled:false, untouched', async () => {
    const ctx = makeCtx({ stateContext: {} });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('hola'), deps);

    expect(result).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(deps.updateStateContext).not.toHaveBeenCalled();
  });

  it('offer reply "1" arms the offered application, clears the offer, and prompts its first gap', async () => {
    const ctx = makeCtx({ stateContext: { fill_offer_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);
    setOtherApp(OTHER_APPLICATION_ID, { job_id: OTHER_JOB_ID, required_fields: ['work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_application_id).toBe(OTHER_APPLICATION_ID);
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(lastReply(deps)).toBe(fieldQuestion('work_authorization', 'en'));
  });

  it.each(['si', 'yes', '1 si'])('offer reply "%s" also arms the offered application (parseFillConfirmation\'s full yes bucket)', async (body) => {
    const ctx = makeCtx({ stateContext: { fill_offer_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);
    setOtherApp(OTHER_APPLICATION_ID, { job_id: OTHER_JOB_ID, required_fields: ['work_authorization'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(body), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_application_id).toBe(OTHER_APPLICATION_ID);
  });

  it('an offered application that went stale (details never requested) exits instead of asking', async () => {
    // promptNextStep re-derives rather than trusting the offer's snapshot --
    // the offered application may have changed between the offer and the reply.
    const ctx = makeCtx({ stateContext: { fill_offer_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);
    setOtherApp(OTHER_APPLICATION_ID, {
      job_id: OTHER_JOB_ID, required_fields: ['work_authorization'], details_requested_at: null,
    });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(lastReply(deps)).toBe(fillMessage('exit_details_not_requested', 'en'));
    expect(ctx.stateContext.fill_application_id).toBeNull();
  });

  it('any non-"1" reply after the offer clears fill_offer_application_id and routes normally (one-shot, no nagging)', async () => {
    const ctx = makeCtx({ stateContext: { fill_offer_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('no gracias'), deps);

    expect(result).toEqual({ handled: false });
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(deps.queueReplyText).not.toHaveBeenCalled(); // no nagging reply
  });

  it('media while only the offer is armed clears the offer and returns handled:false (routes to normal media handling)', async () => {
    const ctx = makeCtx({ stateContext: { fill_offer_application_id: OTHER_APPLICATION_ID } });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg',
    }), deps);

    expect(result).toEqual({ handled: false });
    expect(ctx.stateContext.fill_offer_application_id).toBeNull();
    expect(deps.downloadMedia).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleFillMessage — de-required fill_pending discard. Two layers, both
// live: the lane's own guard (application-fill.ts:1443, from
// `fetchApplicationJobContext`) and, underneath it, the engine's
// `unknown_answer_key` rejection (covered in the failure-reason describe).
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — de-required fill_pending discard', () => {
  beforeEach(resetFake);

  it('fill_pending for a key no longer required is discarded SILENTLY on the next turn (re-derives instead of merging)', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    // The employer removed work_authorization from required_fields while
    // this confirmation was in flight; desired_pay is still required.
    setApp({ required_fields: ['desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toBeNull();
    // Never merged the stale work_authorization answer. NOTE: matching on
    // `/UPDATE job_applications/` alone would be wrong now -- the completion
    // stamp shares that prefix.
    expect(hasCall(SQL.mergeUpdate)).toBe(false);
    expect(allReplies(deps)).toEqual([fieldQuestion('desired_pay', 'en')]);
  });

  it('fill_pending for a key that IS still required merges normally (guard is a no-op)', async () => {
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: { key: 'work_authorization', stage: 'confirm', extracted: true } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'desired_pay'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    const [, updateParams] = findCall(SQL.mergeUpdate);
    expect(updateParams).toEqual([JSON.stringify({ work_authorization: true }), APPLICATION_ID]);
    expect(lastReply(deps)).toBe(fieldQuestion('desired_pay', 'en'));
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
  // damerauLevenshteinDistance -- flows.ts does not export either (same
  // rationale onboarding-language.ts documents for its own duplicate copy).
  // Spec 6.2 / 14 requires and documents: min distance 5, vs 'cerrar'/'saltar'.
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
    expect(Math.min(...distances)).toBe(5); // spec 14's documented value, vs cerrar/saltar
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

// ─────────────────────────────────────────────────────────────────────────
// PII sentinel guard (spec section 11). `logStep` is the ONLY
// console.log/error/warn call site in the fill flow (application-fill.ts /
// application-fill-extraction.ts / application-fill-prompts.ts) -- it emits
// exactly `{ event: 'ApplicationFillStep', key, outcome, reason }`, where
// `key` is a FillFieldKey/CollectableDocType/fixed literal and `reason` is a
// fixed enum literal, never worker-supplied text or an extracted value. These
// tests plant sentinel strings in the free text a worker sends, in the
// extraction double's returned value/summaryVars, and in the generated S3
// key, then prove none of them ever reach a spied console call -- while also
// proving the spies were genuinely capturing real log traffic (the structured
// ApplicationFillStep events) rather than silently missing everything.
//
// The shared engine's own `logStep` (application-requirements.ts:124) emits
// the SAME event name by design, so the structural check below covers both.
// ─────────────────────────────────────────────────────────────────────────

describe('handleFillMessage — PII sentinel guard', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetFake();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  /** Every arg of every spied call, flattened to strings, so a sentinel
   * hiding inside a JSON.stringify'd object argument is caught too. */
  function allLoggedText(): string[] {
    const spyCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls];
    return spyCalls.flatMap((args) =>
      args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))),
    );
  }

  function assertNoSentinelLogged(...sentinels: string[]) {
    const logged = allLoggedText();
    for (const sentinel of sentinels) {
      for (const line of logged) {
        expect(line).not.toContain(sentinel);
      }
    }
  }

  /** Structural check, independent of any particular sentinel string: every
   * console.log call in this flow must be exactly the ApplicationFillStep
   * shape (event/key/outcome/reason and nothing else) -- metadata only,
   * never a message body, prompt, or extracted value. */
  function assertAllLogCallsAreMetadataOnly() {
    for (const [first, ...rest] of logSpy.mock.calls) {
      expect(rest).toEqual([]);
      expect(typeof first).toBe('string');
      const parsed = JSON.parse(first as string);
      expect(parsed.event).toBe('ApplicationFillStep');
      expect(Object.keys(parsed).sort()).toEqual(
        [...new Set(['event', 'key', 'outcome', ...(('reason' in parsed) ? ['reason'] : [])])].sort(),
      );
    }
  }

  function findStepLog(key: string, outcome: string): boolean {
    return logSpy.mock.calls.some(([first]) => {
      if (typeof first !== 'string') return false;
      try {
        const parsed = JSON.parse(first);
        return parsed.event === 'ApplicationFillStep' && parsed.key === key && parsed.outcome === outcome;
      } catch {
        return false;
      }
    });
  }

  it('extraction turn + confirm merge: sentinel in the free text AND in the extracted value/summaryVars never logs', async () => {
    const SENTINEL_FREETEXT = 'SENTINEL_FREETEXT_XYZZY';
    const SENTINEL_ADDRESS = 'SENTINEL_ADDRESS_XYZZY';
    const ctx = makeCtx();
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({
        value: { street: SENTINEL_ADDRESS, city: 'Kyle', state: 'TX', zip: '78640' },
        confidence: { street: 0.9, city: 0.9, state: 0.9, zip: 0.9 },
      }),
    });
    // A second required field is left unanswered so the merge turn lands on
    // the next field rather than falling through to the completion path.
    setApp({ required_fields: ['home_address', 'date_available'] });

    const result = await handleFillMessage(
      client, ctx, incomingMsg(`vivo en ${SENTINEL_FREETEXT}, Kyle TX 78640`), deps,
    );

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toMatchObject({ key: 'home_address', stage: 'confirm' });
    expect(findStepLog('home_address', 'confirm_pending')).toBe(true);
    assertNoSentinelLogged(SENTINEL_FREETEXT, SENTINEL_ADDRESS);

    const result2 = await handleFillMessage(client, ctx, incomingMsg('1 si'), deps);

    expect(result2).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(findStepLog('home_address', 'merged')).toBe(true);
    assertNoSentinelLogged(SENTINEL_FREETEXT, SENTINEL_ADDRESS);
    assertAllLogCallsAreMetadataOnly();
  });

  it('deterministic parse turn (work_authorization): logs key/outcome only, no message text', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    setApp({ required_fields: ['work_authorization', 'date_available'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('1'), deps);

    expect(result).toEqual({ handled: true });
    expect(findStepLog('work_authorization', 'merged')).toBe(true);
    assertAllLogCallsAreMetadataOnly();
  });

  it('doc upload turn: the generated S3 key and stored file_name never appear in any logged line', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx, { downloadMedia: jest.fn(async () => JPEG_BYTES) });
    (uploadDocumentToS3 as jest.Mock).mockResolvedValueOnce({ versionId: 'v-sentinel' });
    setApp({ required_docs: ['resume', 'driver_license'] });

    const result = await handleFillMessage(client, ctx, incomingMsg('', {
      numMedia: 1, mediaUrl: 'https://twilio.example/media/1', mediaContentType: 'image/jpeg',
    }), deps);

    expect(result).toEqual({ handled: true });
    const s3Key = (uploadDocumentToS3 as jest.Mock).mock.calls[0][1] as string;
    expect(s3Key).toMatch(new RegExp(`^documents/${JOB_ID}/${WORKER_ID}/resume/[0-9a-f-]+\\.jpg$`));
    expect(findStepLog('resume', 'stored')).toBe(true);
    assertNoSentinelLogged(s3Key, 'resume.jpg');
    assertAllLogCallsAreMetadataOnly();
  });

  it('CANCELAR turn: a sentinel sitting in fill_pending at cancel time never logs', async () => {
    const SENTINEL_CANCEL = 'SENTINEL_CANCEL_ADDRESS_XYZZY';
    const ctx = makeCtx({
      stateContext: {
        fill_application_id: APPLICATION_ID,
        fill_pending: {
          key: 'home_address', stage: 'confirm',
          extracted: { street: SENTINEL_CANCEL, city: 'Kyle', state: 'TX', zip: '78640' },
        } satisfies FillPendingConfirm,
      },
    });
    const deps = makeDeps(ctx);

    const result = await handleFillMessage(client, ctx, incomingMsg('cancelar'), deps);

    expect(result).toEqual({ handled: true });
    expect(ctx.stateContext.fill_pending).toBeNull();
    expect(findStepLog('cancel', 'canceled')).toBe(true);
    assertNoSentinelLogged(SENTINEL_CANCEL);
    assertAllLogCallsAreMetadataOnly();
  });

  it('error path: extraction returns invalid (malformed shape) — sentinel free text and sentinel value never log', async () => {
    const SENTINEL_FREETEXT = 'SENTINEL_ERRORPATH_FREETEXT_XYZZY';
    const SENTINEL_VALUE = 'SENTINEL_ERRORPATH_VALUE_XYZZY';
    const ctx = makeCtx();
    // Missing city/state/zip -> validateApplicationAnswers rejects the shape
    // -> extractFieldAnswer resolves { ok: false, reason: 'invalid' }.
    const deps = makeDeps(ctx, {
      extraction: fakeExtraction({ value: { street: SENTINEL_VALUE } }),
    });
    setApp({ required_fields: ['home_address'] });

    const result = await handleFillMessage(client, ctx, incomingMsg(SENTINEL_FREETEXT), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.updateStateContext).not.toHaveBeenCalled();
    expect(findStepLog('home_address', 'extraction_failed')).toBe(true);
    assertNoSentinelLogged(SENTINEL_FREETEXT, SENTINEL_VALUE);
    assertAllLogCallsAreMetadataOnly();
  });
});
