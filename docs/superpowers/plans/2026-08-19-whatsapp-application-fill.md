# WhatsApp Application-Fill Flow (Plan 1: Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worker accepts a job on WhatsApp, the bot collects the job's required application fields (one question per key into `job_applications.application_answers`) and required documents (in-chat uploads into `worker_documents`), deriving progress from the DB every turn.

**Architecture:** A deps-injected module `application-fill.ts` (RouterDeps pattern) owns `computeNextStep` (DB diff) and `handleFillMessage` (fill-lane dispatch); the processor arms it via `state_context.fill_application_id` at accept time. Documents go to the KMS documents bucket via a new document-specific put; answers merge through the shared validator, one key at a time. No new `ConversationState` values — the forced-idle writeback preserves `state_context` only.

**Tech Stack:** TypeScript lambdas (pg, AWS SDK v3 S3/Bedrock), Jest, PostgreSQL migrations with RLS/GUC, CDK.

**Spec:** `docs/superpowers/specs/2026-08-19-whatsapp-application-fill-design.md` (Plan 1 = §4–§9, §11–§14; §10/Stage 2 is OUT of this plan). Read it before starting; every rule below cites it.

## Global Constraints

- **Never `git commit`.** Each task ends by staging (`git add`) and proposing a commit message; the user commits. (`docs/` is gitignored — spec/plan files need `git add -f`, code does not.)
- Spanish copy: informal **tú**, **no accents, no inverted punctuation**, numbered options one per line with a "Responde con 1 o 2." footer (spec §7; see `templates.ts:151-165` for tone).
- All logging metadata-only: field **key names**, reason codes, char counts — never message bodies, Bedrock prompts/responses, or extracted values (spec §11).
- The validator `validateApplicationAnswers` is the only gate before any answers write; call shape `validateApplicationAnswers([key], [], {[key]: value})`, store `validated.value[key]` (spec §4.3).
- Doc cap 10MB (`MAX_DOCUMENT_BYTES`), allowed types exactly `application/pdf`, `image/jpeg`, `image/png`, magic-byte verified (spec §4.3).
- Bedrock: at most one call per turn, `requestTimeout: 10_000`, `maxAttempts: 1` (spec §4.3).
- Application status enum is `pending, contacted, talking, hired, not_interested` (`job-fields.ts:4-5`); job status enum is `active, paused, filled, closed`. Never use the legacy `reviewed`/`rejected` names in DB comparisons (spec §9).
- `state_context` writes must **spread the existing object** — `updateConversation` replaces the JSONB column wholesale (`processor.ts:460-483`).
- Every DB write in the fill runs after `setInternalUserRlsContext(client, workerId)` inside the turn transaction.
- Run `npx jest <file>` from `infra/`; run lint with `npm run lint` from `infra/` before staging each task.

---

> **MERGE NOTE (2026-08-20, main merged in):** main took migration numbers
> 077-079 (jobs_structured_fields, worker_documents_cert_name,
> worker_application_defaults), so Task 1's migration was **renumbered to
> `080_whatsapp_application_fill.sql`** — Task 1 is already complete; read its
> 077 references as 080. Consequences for REMAINING tasks:
> - **Task 8:** migration 078 added a `cert_name` column to worker_documents
>   and a SECOND per-cert-name cap constraint. The cert-cap catch must match
>   the `CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS` set now defined in
>   `infra/lambda/lib/applications.ts` (both constraint names), NOT the single
>   `certification_document_limit` name. The worker_documents INSERT column
>   list must be read from 005+017+**078** (cert_name handling for
>   certification_doc uploads — read 078 to see whether it's required).
> - **Task 13:** the integration suite is
>   `whatsapp-application-fill-080.integration.test.ts`; all "077" test
>   descriptions become 080.
> - **Tasks 6/7 (design note):** migration 079 created
>   `worker_application_defaults` — per-worker saved answers for the same
>   field keys the bot collects. Whether the fill flow should seed/skip from
>   defaults is an OPEN product decision (asked to Ivan); until answered,
>   implement per the plan (bot asks; derive-from-DB unchanged).

### Task 1: Migration 077→080 — DELETE grant + 022-trigger GUC bypass (COMPLETE)

**Files:**
- Create: `infra/db/migrations/077_whatsapp_application_fill.sql`
- Modify: `scripts/run-migrations.sh` (MIGRATIONS array, ends at 076 today), `scripts/run-migrations.ps1` (same list)
- Modify: `infra/test/unit/db/migrations/apply-order.test.ts` (the `expectedBaselineMigrations` array)

**Interfaces:**
- Consumes: migration 022's trigger function `enforce_job_application_required_docs()` (verified — `job_applications_required_docs_guard` is the TRIGGER name, not the function; still read 022 before copying the body; the constraint it raises is `job_applications_required_docs_check`).
- Produces: session GUC contract `app.allow_incomplete_docs = 'on'` (read with `current_setting('app.allow_incomplete_docs', true)`); `jale_whatsapp` holds DELETE on `worker_documents`. Tasks 2 and 8 rely on both.

- [ ] **Step 1: Write the failing test** — add `'077_whatsapp_application_fill.sql'` to `expectedBaselineMigrations` in `apply-order.test.ts` (after `'076_ai_extraction_asr_metadata.sql'`).

- [ ] **Step 2: Run it to verify it fails**

Run (from `infra/`): `npx jest test/unit/db/migrations/apply-order.test.ts -t baseline`
Expected: FAIL — the directory has no 077 file.

- [ ] **Step 3: Write the migration**

```sql
-- 077_whatsapp_application_fill.sql
-- WhatsApp application-fill flow (spec: docs/superpowers/specs/
-- 2026-08-19-whatsapp-application-fill-design.md §5).
-- 1. jale_whatsapp gains DELETE on worker_documents: the fill's doc write is
--    DELETE-then-INSERT (mirrors worker-doc-confirm.ts; ON CONFLICT arbiters
--    stopped matching in 007/075). The worker-scoped RLS DELETE policy from
--    018 already applies (no TO clause) — no policy changes.
-- 2. The 022 required-docs INSERT guard learns a session GUC bypass so the
--    WhatsApp accept can create the application BEFORE docs are collected.
--    Every other writer keeps the guard.

BEGIN;

GRANT DELETE ON worker_documents TO jale_whatsapp;

-- Recreate the 022 trigger function with the GUC gate. Copy the existing
-- function body from 022_job_application_required_docs_guard.sql verbatim
-- and add ONLY the guard clause below as the first statement:
--   IF current_setting('app.allow_incomplete_docs', true) = 'on' THEN
--     RETURN NEW;
--   END IF;
-- (CREATE OR REPLACE FUNCTION keeps the existing trigger binding.)

-- ── self-verification (073 pattern) ─────────────────────────────
DO $$
DECLARE
  has_delete boolean;
  fn_src text;
BEGIN
  SELECT has_table_privilege('jale_whatsapp', 'worker_documents', 'DELETE')
    INTO has_delete;
  IF NOT has_delete THEN
    RAISE EXCEPTION 'jale_whatsapp DELETE grant on worker_documents missing';
  END IF;

  SELECT prosrc INTO fn_src FROM pg_proc
   WHERE proname = 'enforce_job_application_required_docs';
  IF fn_src IS NULL OR fn_src NOT ILIKE '%allow_incomplete_docs%' THEN
    RAISE EXCEPTION 'required-docs guard missing GUC bypass: %', COALESCE(left(fn_src, 80), '<absent>');
  END IF;
END $$;

COMMIT;
```

Before writing, `Read infra/db/migrations/022_job_application_required_docs_guard.sql` and copy the real function name and body; the SQL above marks the two spots that depend on it.

- [ ] **Step 4: Register in both runners** — append `"077_whatsapp_application_fill.sql"` after the 076 entry in `scripts/run-migrations.sh` (line ~220) and the equivalent list in `scripts/run-migrations.ps1`.

- [ ] **Step 5: Run tests to verify they pass**

Run (from `infra/`): `npx jest test/unit/db/migrations` — apply-order and sequence tests PASS.

- [ ] **Step 6: Stage & propose commit**

`git add infra/db/migrations/077_whatsapp_application_fill.sql scripts/run-migrations.sh scripts/run-migrations.ps1 infra/test/unit/db/migrations/apply-order.test.ts`
Proposed message: `feat(db): 077 whatsapp application-fill — worker_documents DELETE grant, GUC bypass for required-docs guard`

---

### Task 2: `applyWorkerToJob` — WhatsApp surface creates the row upfront

**Files:**
- Modify: `infra/lambda/lib/applications.ts` (the `missing_documents` bounce is at lines 159-162; the INSERT try/catch at ~204-245)
- Test: `infra/test/unit/lambda/lib/applications.test.ts`

**Interfaces:**
- Consumes: GUC contract from Task 1.
- Produces: for `surface === 'whatsapp'`: the docs pre-check is skipped, `SET LOCAL app.allow_incomplete_docs = 'on'` wraps the INSERT, and a new result variant `{ status: 'guard_blocked' }` is returned when 23514/`job_applications_required_docs_check` still fires. All other surfaces byte-identical. Task 9 consumes `applied`/`already_applied`/`guard_blocked`.

- [ ] **Step 1: Write the failing tests**

```ts
// applications.test.ts — follow the file's existing mock-client pattern.
it('whatsapp surface skips the missing-documents bounce and inserts', async () => {
  // job with required_docs ['resume'], worker has NO documents
  const res = await applyWorkerToJob(client, { jobId, workerId, surface: 'whatsapp' });
  expect(res.status).toBe('applied');
  expect(queries).toContainEqual(expect.stringContaining("set_config('app.allow_incomplete_docs'"));
});

it('web surface still bounces on missing documents', async () => {
  const res = await applyWorkerToJob(client, { jobId, workerId, surface: 'web' });
  expect(res.status).toBe('missing_documents');
});

it('maps 23514 job_applications_required_docs_check to guard_blocked', async () => {
  insertRejectsWith({ code: '23514', constraint: 'job_applications_required_docs_check' });
  const res = await applyWorkerToJob(client, { jobId, workerId, surface: 'whatsapp' });
  expect(res.status).toBe('guard_blocked');
});
```

- [ ] **Step 2: Run to verify they fail** — `npx jest test/unit/lambda/lib/applications.test.ts` → FAIL (bounce fires / no such status).

- [ ] **Step 3: Implement**

In `applyWorkerToJob`:

```ts
const missingDocs = await missingRequiredDocuments(client, workerId, jobId, requiredDocs);
// WhatsApp collects docs conversationally AFTER the row exists (fill flow,
// spec §6); the 022 DB guard is bypassed via GUC for this surface only.
if (missingDocs.length > 0 && surface !== 'whatsapp') {
  return { status: 'missing_documents', missing_docs: missingDocs };
}
```

Immediately before the INSERT (inside the existing try):

```ts
if (surface === 'whatsapp') {
  await client.query(`SELECT set_config('app.allow_incomplete_docs', 'on', true)`); // SET LOCAL semantics
}
```

In the existing catch (alongside the 42501 mapping):

```ts
if (err?.code === '23514' && err?.constraint === 'job_applications_required_docs_check') {
  return { status: 'guard_blocked' };
}
```

Add `| { status: 'guard_blocked' }` to the exported result union, and tighten
the `already_applied` variant so `application` is **required** (the code
always supplies it; the no-row fallback is the separate `forbidden` status) —
Task 9 narrows on `applyResult.application.id` under strict TS.

- [ ] **Step 4: Run tests + full file suite** — `npx jest test/unit/lambda/lib/applications.test.ts` → PASS.

- [ ] **Step 5: Stage & propose commit**
`git add infra/lambda/lib/applications.ts infra/test/unit/lambda/lib/applications.test.ts`
Proposed: `feat(applications): whatsapp accept creates application upfront (GUC-gated), guard_blocked mapping`

---

### Task 3: Bilingual prompts module

**Files:**
- Create: `infra/lambda/whatsapp/lib/application-fill-prompts.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill-prompts.test.ts`

**Interfaces:**
- Consumes: `REQUIRED_FIELD_TYPES`, `DOC_TYPES` from `infra/lambda/lib/job-fields.ts`; `Lang` from `./templates`.
- Produces (Tasks 7-11 consume):

```ts
export type FillFieldKey = (typeof REQUIRED_FIELD_TYPES)[number];
export type CollectableDocType = (typeof DOC_TYPES)[number]; // ssn excluded by DOC_TYPES itself
export function fieldQuestion(key: FillFieldKey, lang: Lang): string;
export function fieldRetryHint(key: FillFieldKey, lang: Lang): string;
export function docPrompt(docType: CollectableDocType, lang: Lang): string;
export function fillMessage(key: FillMessageKey, lang: Lang, vars?: Record<string, string>): string;
// FillMessageKey: 'intro' | 'confirm_footer' | 'entry_another' | 'completion'
//   | 'canceled' | 'doc_invalid_type' | 'doc_too_large' | 'doc_take_first'
//   | 'doc_step_media_pending' | 'field_step_media' | 'cert_cap' | 'extraction_failed'
//   | 'answer_too_long' | 'doc_download_failed' | 'web_handoff' | 'switched_job' | 'continue_other'
//   | 'exit_job_inactive' | 'exit_application_gone' | 'exit_application_closed'
//   | 'guard_error' | 'reconfirm'
```

Vars use the `{{name}}` placeholder convention (`templates.ts` `$`-safe substitution — copy that helper's approach).

- [ ] **Step 1: Write the failing parity test**

```ts
import { REQUIRED_FIELD_TYPES, DOC_TYPES } from '../../../../../lambda/lib/job-fields';
import * as prompts from '../../../../../lambda/whatsapp/lib/application-fill-prompts';

test.each(REQUIRED_FIELD_TYPES)('field %s has distinct en/es question and hint', (key) => {
  for (const fn of [prompts.fieldQuestion, prompts.fieldRetryHint]) {
    const en = fn(key, 'en'); const es = fn(key, 'es');
    expect(en.length).toBeGreaterThan(10);
    expect(es.length).toBeGreaterThan(10);
    expect(en).not.toBe(es);
  }
});
test.each(DOC_TYPES)('doc %s has distinct en/es prompt naming formats and 10MB', (dt) => {
  const es = prompts.docPrompt(dt, 'es');
  expect(es).toMatch(/PDF/); expect(es).toMatch(/10 ?MB/);
  expect(es).not.toBe(prompts.docPrompt(dt, 'en'));
});
test('es copy has no accents or inverted punctuation', () => {
  const all = [
    ...REQUIRED_FIELD_TYPES.flatMap(k => [prompts.fieldQuestion(k, 'es'), prompts.fieldRetryHint(k, 'es')]),
    ...DOC_TYPES.map(d => prompts.docPrompt(d, 'es')),
  ].join(' ');
  expect(all).not.toMatch(/[áéíóúñÁÉÍÓÚÑ¿¡]/);
});
```

- [ ] **Step 2: Run to verify it fails** (module missing).

- [ ] **Step 3: Implement** — one `Record<FillFieldKey, {en: string; es: string}>` per function, written out for all 11 keys and 4 doc types. Sample entries (write all in the same voice; per-entry array questions ask for ONE entry, and note only company+title are required for work_history):

```ts
const FIELD_QUESTIONS: Record<FillFieldKey, Bilingual> = {
  date_of_birth: {
    en: 'What is your date of birth? Reply like this: 1990-04-03 (year-month-day).',
    es: 'Cual es tu fecha de nacimiento? Responde asi: 1990-04-03 (ano-mes-dia).',
  },
  work_history: {
    en: 'Tell me about your most recent job: company and job title (dates and duties help too, but are optional).',
    es: 'Cuentame de tu trabajo mas reciente: empresa y puesto (fechas y tareas ayudan, pero son opcionales).',
  },
  // ...all 11 keys, each with a matching fieldRetryHint that names the expected format
};
```

`fillMessage('intro', ...)` copy: es `'Recibimos tu interes. Para completar tu aplicacion faltan {{n_fields}} preguntas y {{n_docs}} documentos. Empezamos:'`. `'confirm_footer'`: `'1. Si\n2. No\nResponde con 1 o 2.'`. `'canceled'` es: `'Listo, cancele el formulario. Para continuar responde "1 aceptar" al empleo o toca el boton del empleo otra vez.'` (spec §6.2 — no website promise). `'web_handoff'` es: `'El documento {{doc}} solo se puede completar con el empleador o en el sitio web.'`

- [ ] **Step 4: Run tests** → PASS. Also `npm run lint`.

- [ ] **Step 5: Stage & propose commit**
`git add infra/lambda/whatsapp/lib/application-fill-prompts.ts infra/test/unit/lambda/whatsapp/lib/application-fill-prompts.test.ts`
Proposed: `feat(whatsapp): bilingual application-fill prompts module`

---

### Task 4: Media — document category, magic-byte sniff, KMS-safe put

**Files:**
- Modify: `infra/lambda/whatsapp/lib/media.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/media.test.ts` (extend; check for an existing file first and follow its S3 mock pattern — `aws-sdk-client-mock` or manual jest mock, whichever the file already uses)

**Interfaces:**
- Produces (Task 8 consumes):

```ts
export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // web-policy parity (worker-doc-upload-url.ts:12)
export type DocumentMime = (typeof ALLOWED_DOCUMENT_TYPES)[number];
export function sniffDocumentType(buf: Buffer): DocumentMime | null;
export async function uploadDocumentToS3(
  bucketName: string, key: string, body: Buffer, contentType: DocumentMime,
): Promise<{ versionId: string | null }>;
export async function downloadTwilioMediaBounded(
  mediaUrl: string, accountSid: string, authToken: string, maxBytes: number,
): Promise<Buffer>; // throws MediaTooLargeError when Content-Length header OR the buffered body exceeds maxBytes — header checked BEFORE buffering (spec §4.3)
export class MediaTooLargeError extends Error {}
```

Note on mocking: `aws-sdk-client-mock` is NOT a dependency (adding one needs
explicit user approval) — use the repo's manual pattern
`jest.mock('@aws-sdk/client-s3', ...)` capturing the mocked client's `send`
calls (see `infra/test/unit/lambda/api/worker-doc-confirm.test.ts` for the
shape). The existing `media.test.ts` only tests pure functions today.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  [Buffer.from('%PDF-1.7 rest'), 'application/pdf'],
  [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'],
  [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
  [Buffer.from('GIF89a'), null],
  [Buffer.from('<html>'), null],
])('sniffDocumentType %#', (buf, expected) => {
  expect(sniffDocumentType(buf as Buffer)).toBe(expected);
});

it('uploadDocumentToS3 sends NO ServerSideEncryption header and returns VersionId', async () => {
  // jest.mock('@aws-sdk/client-s3') at module top; sendMock resolves { VersionId: 'v123' }
  const res = await uploadDocumentToS3('bkt', 'k', Buffer.from('%PDF-'), 'application/pdf');
  const input = sendMock.mock.calls[0][0].input;
  expect(input.ServerSideEncryption).toBeUndefined(); // bucket-default KMS must apply (spec §4.3)
  expect(res.versionId).toBe('v123');
});

it('downloadTwilioMediaBounded rejects on Content-Length header before reading the body', async () => {
  // fetch mock returns headers: { 'content-length': String(11 * 1024 * 1024) }; arrayBuffer spy
  await expect(downloadTwilioMediaBounded('url', 'sid', 'tok', MAX_DOCUMENT_BYTES))
    .rejects.toBeInstanceOf(MediaTooLargeError);
  expect(arrayBufferSpy).not.toHaveBeenCalled();
});

it('downloadTwilioMediaBounded rejects when the buffered body exceeds maxBytes despite a small/missing header', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

```ts
export function sniffDocumentType(buf: Buffer): DocumentMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return 'image/png';
  return null;
}

export async function uploadDocumentToS3(
  bucketName: string, key: string, body: Buffer, contentType: DocumentMime,
): Promise<{ versionId: string | null }> {
  // Deliberately NO ServerSideEncryption header: the documents bucket is
  // SSE-KMS by default and an explicit AES256 header would override it.
  const res = await s3.send(new PutObjectCommand({
    Bucket: bucketName, Key: key, Body: body, ContentType: contentType,
  }));
  return { versionId: res.VersionId ?? null };
}
```

- [ ] **Step 4: Run tests** → PASS. Existing photo/voice tests must be untouched and green.

- [ ] **Step 5: Stage & propose commit**
`git add infra/lambda/whatsapp/lib/media.ts infra/test/unit/lambda/whatsapp/lib/media.test.ts`
Proposed: `feat(whatsapp): document media category — magic-byte sniff, 10MB cap constant, KMS-safe put`

---

### Task 5: Extraction module (Bedrock, bounded, validated)

**Files:**
- Create: `infra/lambda/whatsapp/lib/application-fill-extraction.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill-extraction.test.ts`

**Interfaces:**
- Consumes: `validateApplicationAnswers` from `../../lib/application-answers`; Bedrock client injected.
- Produces (Task 7 consumes):

```ts
export const MAX_FREETEXT_CHARS = 1000;   // per-key input cap (spec §12 oversize prevention)
export type ExtractionOutcome =
  | { ok: true; value: unknown; summaryVars: Record<string, string> }
  | { ok: false; reason: 'low_confidence' | 'invalid' | 'too_long' | 'bedrock_error' };
export interface ExtractionClient { invoke(prompt: string): Promise<string> } // deps-injected
export async function extractFieldAnswer(
  bedrock: ExtractionClient, key: FillFieldKey, freeText: string, lang: Lang,
): Promise<ExtractionOutcome>;
export function makeBedrockExtractionClient(): ExtractionClient; // real impl, used by processor wiring
```

`makeBedrockExtractionClient` constructs `new BedrockRuntimeClient({ maxAttempts: 1, requestHandler: new NodeHttpHandler({ requestTimeout: 10_000 }) })` — the ONLY place those knobs live.

- [ ] **Step 1: Write the failing tests**

```ts
const fake = (json: unknown): ExtractionClient => ({ invoke: async () => JSON.stringify(json) });

it('extracts and validates a home_address', async () => {
  const out = await extractFieldAnswer(fake({
    value: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
    confidence: { street: 0.9, city: 0.95, state: 0.9, zip: 0.9 },
  }), 'home_address', 'vivo en 1 Main St Kyle TX 78640', 'es');
  expect(out).toMatchObject({ ok: true, value: { city: 'Kyle', state: 'TX' } });
});

it('rejects when any required subfield is below threshold', async () => {
  const out = await extractFieldAnswer(fake({
    value: { street: '1 Main St', city: 'Kyle', state: 'TX', zip: '78640' },
    confidence: { street: 0.9, city: 0.4, state: 0.9, zip: 0.9 },
  }), 'home_address', 'texto', 'es');
  expect(out).toEqual({ ok: false, reason: 'low_confidence' });
});

it('validator is the gate: malformed extraction is invalid', async () => {
  const out = await extractFieldAnswer(fake({ value: { zip: 'not-a-zip' }, confidence: {} }), 'home_address', 'x', 'es');
  expect(out).toEqual({ ok: false, reason: 'invalid' });
});

it('caps input length before calling Bedrock', async () => {
  const spy = jest.fn(); const client = { invoke: spy as any };
  const out = await extractFieldAnswer(client, 'work_history', 'x'.repeat(2000), 'es');
  expect(out).toEqual({ ok: false, reason: 'too_long' });
  expect(spy).not.toHaveBeenCalled();
});

it('bedrock throw maps to bedrock_error', async () => {
  const out = await extractFieldAnswer({ invoke: async () => { throw new Error('timeout'); } }, 'education', 'hs', 'es');
  expect(out).toEqual({ ok: false, reason: 'bedrock_error' });
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Per-key system prompt table (one entry per extraction key: `home_address, emergency_contact, worked_here_before, education, military_service, references, work_history` — for array keys the prompt extracts ONE entry). The prompt instructs: return only JSON `{"value": <shape>, "confidence": {<subfield>: 0..1}}`; the shape is copied from the validator's expectations (read `application-answers.ts:282-294` FIELD_VALIDATORS while writing). Flow:

```ts
export async function extractFieldAnswer(bedrock, key, freeText, lang): Promise<ExtractionOutcome> {
  const trimmed = freeText.trim();
  if (trimmed.length > MAX_FREETEXT_CHARS) return { ok: false, reason: 'too_long' };
  let raw: string;
  try { raw = await bedrock.invoke(buildPrompt(key, trimmed, lang)); }
  catch { return { ok: false, reason: 'bedrock_error' }; }
  let parsed: { value?: unknown; confidence?: Record<string, number> };
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'invalid' }; }
  const threshold = Number(process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD ?? '0.75');
  const required = REQUIRED_SUBFIELDS[key]; // e.g. home_address: ['street','city','state','zip']
  if (required.some((f) => (parsed.confidence?.[f] ?? 0) < threshold)) {
    return { ok: false, reason: 'low_confidence' };
  }
  // Array keys validate as a single-entry array; scalar keys as-is (Task 7 merges entries).
  const candidate = ARRAY_KEYS.has(key) ? [parsed.value] : parsed.value;
  const validated = validateApplicationAnswers([key], [], { [key]: candidate });
  if (!validated.ok) return { ok: false, reason: 'invalid' };
  const value = (validated.value as Record<string, unknown>)[key];
  return { ok: true, value: ARRAY_KEYS.has(key) ? (value as unknown[])[0] : value, summaryVars: buildSummaryVars(key, value) };
}
```

`buildSummaryVars` renders display strings per key mirroring `frontend/src/lib/format-application-answers.ts:33-80` shapes (address comma-joined; reference "name (phone)"). No logging of values anywhere in this module.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Stage & propose commit**
`git add infra/lambda/whatsapp/lib/application-fill-extraction.ts infra/test/unit/lambda/whatsapp/lib/application-fill-extraction.test.ts`
Proposed: `feat(whatsapp): bounded Bedrock extraction for application answers (validator-gated, confidence-gated)`

---

### Task 6: `application-fill.ts` — `computeNextStep`

**Files:**
- Create: `infra/lambda/whatsapp/lib/application-fill.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts`

**Interfaces:**
- Consumes: `DOC_TYPES` (collectable list) from `job-fields.ts`.
- Produces (Tasks 7-11 consume):

```ts
export type NextStep =
  | { kind: 'field'; key: FillFieldKey; uncollectable: string[] }
  | { kind: 'doc'; docType: CollectableDocType; uncollectable: string[] }
  | { kind: 'exit'; reason: 'job_inactive' | 'application_gone' | 'application_closed'; uncollectable: string[] }
  | { kind: 'complete'; uncollectable: string[] };
export async function computeNextStep(client: PoolClient, applicationId: string): Promise<NextStep>;
```

- [ ] **Step 1: Write the failing tests** (mock `client.query` by SQL shape, following `conversation-router.test.ts` conventions):

```ts
// One SELECT joining job_applications -> jobs returns:
// { job_status, application_status, required_fields, required_docs, application_answers, worker_id, job_id }
// A second SELECT returns DISTINCT doc_type rows from worker_documents.
it('walks required_fields in array order, skipping answered keys', ...);       // answers has key[0] -> returns key[1]
it('fields before docs; docs walk in array order, skipping present doc rows', ...);
it('a doc uploaded via web mid-flow is skipped (presence diff)', ...);
it('ssn is excluded from the walk and reported in uncollectable', ...);        // required_docs ['ssn','resume'], no docs -> {kind:'doc', docType:'resume', uncollectable:['ssn']}
it('complete when only uncollectable items remain', ...);                       // -> {kind:'complete', uncollectable:['ssn']}
it('exit application_gone when the application row is missing', ...);           // first SELECT returns 0 rows
it('exit job_inactive for job filled/closed', ...);
it('exit application_closed for application hired/not_interested', ...);
it('continues for application contacted and talking', ...);
it('continues for job paused (spec §9: active AND paused continue)', ...);
it('a key added to required_fields mid-fill becomes the next step (requirements widening)', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

```ts
const COLLECTABLE = new Set<string>(DOC_TYPES); // job-fields DOC_TYPES already excludes ssn

export async function computeNextStep(client: PoolClient, applicationId: string): Promise<NextStep> {
  const appRes = await client.query(
    `SELECT ja.worker_id, ja.job_id, ja.status AS application_status,
            ja.application_answers, j.status AS job_status,
            j.required_fields, j.required_docs
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1`, [applicationId]);
  if (appRes.rows.length === 0) return { kind: 'exit', reason: 'application_gone', uncollectable: [] };
  const row = appRes.rows[0];
  const uncollectable = (row.required_docs ?? []).filter((d: string) => !COLLECTABLE.has(d));
  if (row.job_status === 'filled' || row.job_status === 'closed')
    return { kind: 'exit', reason: 'job_inactive', uncollectable };
  if (row.application_status === 'hired' || row.application_status === 'not_interested')
    return { kind: 'exit', reason: 'application_closed', uncollectable };

  const answers = row.application_answers ?? {};
  for (const key of row.required_fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(answers, key)) return { kind: 'field', key, uncollectable };
  }
  const docRes = await client.query(
    `SELECT DISTINCT doc_type FROM worker_documents
      WHERE worker_id = $1 AND (job_id IS NULL OR job_id = $2)`, [row.worker_id, row.job_id]);
  const have = new Set(docRes.rows.map((r: any) => r.doc_type));
  for (const dt of row.required_docs ?? []) {
    if (!COLLECTABLE.has(dt)) continue;
    if (!have.has(dt)) return { kind: 'doc', docType: dt, uncollectable };
  }
  return { kind: 'complete', uncollectable };
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Stage & propose commit**
`git add infra/lambda/whatsapp/lib/application-fill.ts infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts`
Proposed: `feat(whatsapp): computeNextStep — DB-derived application-fill progress`

---

### Task 7: `handleFillMessage` — field steps (parse, extract, confirm)

**Files:**
- Modify: `infra/lambda/whatsapp/lib/application-fill.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5 `extractFieldAnswer`/`ExtractionClient`; Task 3 prompts; `validateApplicationAnswers`; `queueOutboxText` injected.
- Produces (Tasks 8-11 and the processor consume):

```ts
export interface FillDeps {
  extraction: ExtractionClient;
  queueReplyText(client: PoolClient, inboundSid: string, to: string, body: string): Promise<void>;
  setRls(client: PoolClient, workerId: string): Promise<void>;   // setInternalUserRlsContext
  updateStateContext(client: PoolClient, conversationId: string, patch: Record<string, unknown>): Promise<void>; // spread-merge
  nowMs(): number;
}
export interface FillContext {
  conversationId: string; workerId: string; jobId: string; lang: Lang;
  stateContext: Record<string, unknown>; // includes fill_application_id, fill_pending?, fill_last_prompt_at?, fill_relay_override?, fill_offer_application_id?
}
// jobId is resolved each turn from fill_application_id: computeNextStep's
// first SELECT already returns job_id — handleFillMessage surfaces it into
// ctx before any step handling (Task 8's doc writes consume it).
export type FillResult = { handled: true } | { handled: false }; // false => processor continues normal routing
export async function handleFillMessage(
  client: PoolClient, ctx: FillContext, msg: IncomingMessage, deps: FillDeps,
): Promise<FillResult>;
export async function promptNextStep(client, ctx, inboundSid, from, deps): Promise<void>; // queues question/doc prompt/completion/exit per computeNextStep; stamps fill_last_prompt_at
export function isFillCancel(body: string): boolean;   // exact 'cancelar' (case/trim-insensitive)
export function parseFillConfirmation(body: string): 'yes' | 'no' | null; // '1','2','si','no','1 si','2 no'
```

State keys written here: `fill_pending: { key, extracted, summaryVars? }`, `fill_last_prompt_at: number`. Scrub rule (spec §4.2): `fill_pending` cleared ONLY on confirm, discard, anchor switch, CANCELAR, completion, lifecycle exit.

- [ ] **Step 1: Write the failing tests** (representative — cover every branch below):

```ts
it('deterministic boolean: "1" stores true for work_authorization and prompts next step', ...);
it('date answer echoes long-form confirm via fill_pending (no immediate write)', ...);
it('confirm "1 si" merges validated value: UPDATE ... application_answers || $1 and clears fill_pending', ...);
it('discard "2" clears fill_pending and re-asks with fieldRetryHint', ...);
it('unrecognized text while fill_pending re-echoes the confirmation (reconfirm message)', ...);
it('extraction key: free text -> extractFieldAnswer -> fill_pending with summary echo', ...);
it('low_confidence/bedrock_error/too_long each re-prompt with the mapped message, nothing written', ...);
it('array key entry confirm asks entry_another; "2 no" merges accumulated entries as one validated array', ...);
it('CANCELAR clears fill_application_id and fill_pending, sends canceled copy', ...);
it('answers merge runs after deps.setRls and uses validated.value[key], never raw extraction', ...);
it('merge backstop >8192 bytes: answer_too_long reply, nothing written, step stays pending', ...);
it('isFillCancel distance lock: "cancelar" is >1 Damerau-Levenshtein from every COMMAND_KEYWORDS entry', ...); // import the real keyword list + distance fn from flows.ts
it('desired_pay success: next prompt embeds the normalized amount/interval echo', ...);
it('desired_pay "25 al ano" returns null (no yearly interval) and re-prompts', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Key logic in order (spec §6): CANCELAR check → `fill_pending` resolution (`parseFillConfirmation`; array keys accumulate into `fill_pending.entries` until "no more", then validate the whole array once and merge) → current-step handling. Deterministic parsers:

```ts
function parseDeterministic(key: FillFieldKey, body: string): { value: unknown } | { pendingDate: string } | null {
  const t = body.trim().toLowerCase();
  switch (key) {
    case 'work_authorization': {
      if (t === '1' || t === 'si' || t === 'yes') return { value: true };
      if (t === '2' || t === 'no') return { value: false };
      return null;
    }
    case 'date_of_birth':
    case 'date_available': {
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? { pendingDate: t } : null; // goes through fill_pending long-form confirm
    }
    case 'desired_pay': {
      const m = t.replace(',', '.').match(/(\d{1,4})(?:\.\d+)?\s*(?:\$|dolares|dollars)?\s*(?:por|per|\/|al?)?\s*(hora|hour|dia|day|semana|week|mes|month|ano|year|proyecto|project)?/);
      if (!m || !m[1]) return null;
      const interval = normalizePayInterval(m[2]); // maps es/en words -> PAY_INTERVALS values; default 'hourly' only if m[2] present? NO: require interval word, else null
      return interval ? { value: { amount: Number(m[1]), interval } } : null;
    }
    default: return null; // extraction bucket
  }
}
```

Merge (single choke point used by every field write):

```ts
type MergeResult = { ok: true } | { ok: false; reason: 'invalid' | 'too_large' };
async function mergeAnswer(client, ctx, key: FillFieldKey, value: unknown, deps: FillDeps): Promise<MergeResult> {
  const validated = validateApplicationAnswers([key], [], { [key]: value });
  if (!validated.ok) return { ok: false, reason: 'invalid' };
  const merged = JSON.stringify({ [key]: (validated.value as any)[key] });
  if (merged.length > 8192) return { ok: false, reason: 'too_large' }; // per-key backstop (spec §12)
  await deps.setRls(client, ctx.workerId);
  await client.query(
    `UPDATE job_applications
        SET application_answers = application_answers || $1::jsonb, updated_at = now()
      WHERE id = $2`, [merged, ctx.stateContext.fill_application_id]);
  return { ok: true };
}
// Caller maps reason 'too_large' -> fillMessage('answer_too_long') (step stays
// pending), 'invalid' -> fieldRetryHint(key).
```

`normalizePayInterval` word table (pin against the real `PAY_INTERVALS` values
in `job-fields.ts` — read it first): hora/hour → hourly value, dia/day →
daily, semana/week → weekly, mes/month → monthly, proyecto/project → the
fixed-price value. `ano`/`year` has NO target — the parser returns null (re-
prompt), never guesses. After a successful desired_pay parse the next prompt
message embeds the normalized `{{amount}}/{{interval_label}}` echo.

Structured logs: `console.log(JSON.stringify({ event: 'ApplicationFillStep', key, outcome, reason }))` — keys and reason codes only.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Stage & propose commit** — `feat(whatsapp): handleFillMessage field collection (deterministic + extracted, confirm loop)`

---

### Task 8: `handleFillMessage` — document steps

**Files:**
- Modify: `infra/lambda/whatsapp/lib/application-fill.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4 media exports; Task 1 grants; `downloadTwilioMedia` (injected via `FillDeps.downloadMedia(mediaUrl): Promise<Buffer>`), `copyRequiredDocumentSnapshots` (exported from `applications.ts` — export it if currently private).
- Produces: doc-step behavior for Tasks 9-10. FillDeps gains: `downloadMedia`, `documentsBucket: string`.

- [ ] **Step 1: Write the failing tests**

```ts
it('media at doc step: sniff ok -> S3 put -> SAVEPOINT -> DELETE-then-INSERT with version id -> snapshot copy -> next prompt', ...);
it('certification_doc uses plain INSERT (no DELETE) and then asks entry_another (cert loop)', ...);
it('cert cap: 23514 constraint certification_document_limit -> ROLLBACK TO SAVEPOINT -> cert_cap message -> advance', ...);
it('non-cert 23505 -> ROLLBACK TO SAVEPOINT -> treated satisfied -> advance (first-write-wins)', ...);
it('other SQLSTATE -> ROLLBACK TO SAVEPOINT -> rethrow', ...);
it('sniff mismatch vs claimed type -> doc_invalid_type reply, step pending, no S3 put', ...);
it('oversize buffer -> doc_too_large reply, no S3 put', ...);
it('NumMedia>1 -> processes first, prepends doc_take_first note', ...);
it('audio content type at doc step -> voice_note_not_supported reply (the ready-worker key, NOT v2_voice_not_supported)', ...);
it('media at a FIELD step -> field_step_media reply, nothing written', ...);
it('free text at a doc step -> re-sends doc prompt (cooldown-guarded)', ...);
it('downloadMedia throws -> doc_download_failed reply, no S3 put, NO rethrow (turn commits)', ...);
it('outcome contract: stay_pending outcomes do not trigger promptNextStep; stored/satisfied do', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

```ts
// Outcome contract: 'stored' (row written) | 'satisfied' (requirement already
// met: cert cap, non-cert 23505) | 'stay_pending' (error reply sent, step
// unchanged). The CALLER runs promptNextStep only for stored/satisfied —
// never for stay_pending (the error reply already told the worker what to do).
// handleFillMessage always runs inside the processor's turn transaction — the
// SAVEPOINT below depends on it; never call this standalone/autocommit.
async function handleDocUpload(client, ctx, msg, docType: CollectableDocType, deps: FillDeps): Promise<'stored' | 'satisfied' | 'stay_pending'> {
  let buf: Buffer;
  try {
    buf = await deps.downloadMedia(msg.mediaUrl!); // downloadTwilioMediaBounded(..., MAX_DOCUMENT_BYTES)
  } catch (err) {
    // Spec §12: caught -> commit + error reply; recovery = worker resends.
    if (err instanceof MediaTooLargeError) { await reply(deps, 'doc_too_large'); return 'stay_pending'; }
    await reply(deps, 'doc_download_failed'); return 'stay_pending';
  }
  const sniffed = sniffDocumentType(buf);
  if (!sniffed || (msg.mediaContentType && ALLOWED_DOCUMENT_TYPES.includes(msg.mediaContentType as any)
      && sniffed !== msg.mediaContentType)) { await reply(deps, 'doc_invalid_type'); return 'stay_pending'; }

  const ext = sniffed === 'application/pdf' ? 'pdf' : sniffed === 'image/png' ? 'png' : 'jpg';
  const key = `documents/${ctx.jobId}/${ctx.workerId}/${docType}/${randomUUID()}.${ext}`; // web scheme, worker-doc-upload-url.ts:93
  const { versionId } = await uploadDocumentToS3(deps.documentsBucket, key, buf, sniffed); // S3 BEFORE DB (spec §4.3 invariant)

  await deps.setRls(client, ctx.workerId);
  await client.query('SAVEPOINT fill_doc');
  try {
    if (docType !== 'certification_doc') {
      await client.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = $3`,
        [ctx.workerId, ctx.jobId, docType]);
    }
    await client.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ctx.workerId, ctx.jobId, docType, key, `${docType}.${ext}`, buf.length, sniffed, versionId]);
    await copyRequiredDocumentSnapshots(client, ctx.workerId, ctx.jobId, [docType]);
    await client.query('RELEASE SAVEPOINT fill_doc');
    return 'stored';
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT fill_doc');
    if (err?.code === '23514' && err?.constraint === 'certification_document_limit') { await reply(deps, 'cert_cap'); return 'satisfied'; }
    if (err?.code === '23505' && docType !== 'certification_doc') { return 'satisfied'; } // first-write-wins
    throw err;
  }
}
```

(Exact column list: read `005_document_vault.sql:26-37` + `017` before writing the INSERT; adjust names to match.) `file_name` is server-synthesized — never derived from message text.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Stage & propose commit** — `feat(whatsapp): application-fill document collection (savepoint, delete-then-insert, cert loop)`

---

### Task 9: Processor entry — arm the fill at accept (+ defaults seeding, Ivan's 2026-08-20 decision)

**Files:**
- Modify: `infra/lambda/whatsapp/processor.ts` (`handleJobAction` result handling, lines ~1925-1942)
- Create: `infra/db/migrations/081_whatsapp_application_defaults_read.sql` — exactly `GRANT SELECT ON worker_application_defaults TO jale_whatsapp;` with a 073-style self-verification block (NOT insert/update — write-back of collected answers to defaults is explicitly deferred; migration 079's header anticipates this grant). Register in both runner manifests + apply-order baseline + sequence-numbers array (081).
- Modify: `infra/lambda/whatsapp/lib/application-fill.ts` — add `seedAnswersFromDefaults(client, ctx, requiredFields, optionalFields): Promise<string[]>` (returns seeded keys): after `setInternalUserRlsContext`, SELECT the worker's `worker_application_defaults` row (read migration 079 for the exact column/shape and RLS before writing the query); for each job-relevant key present in defaults and ABSENT from `application_answers`, validate via `validateApplicationAnswers([key], [], {[key]: value})` and merge `validated.value[key]` with the existing `||` UPDATE; keys whose default fails validation are simply not seeded (the bot asks instead — never an error to the worker). Called once at fill-arm time, BEFORE computeNextStep/intro counts, for both fresh accepts and re-arms.
- Test: `infra/test/unit/lambda/whatsapp/processor.test.ts` (extend; Bedrock enters only via FillDeps, so no new jest.mock); `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (seeding unit tests)

Additional Step-1 test cases (defaults): seeded keys are never asked (intro counts reflect post-seed gaps); an invalid stored default is skipped and its question asked; existing application_answers keys are never overwritten by defaults; worker with no defaults row seeds nothing.

**Interfaces:**
- Consumes: Task 2 statuses; Task 6/7 `computeNextStep`, `promptNextStep`; Task 3 intro copy.
- Produces: `state_context.fill_application_id` armed; intro + first prompt queued (ordered via outbox `sequence`).

- [ ] **Step 1: Write the failing tests**

```ts
it('accept on a job with requirements: arms fill, sends intro with N/M counts then first question (no job_accepted)', ...);
it('accept on a job with NO requirements: legacy job_accepted, fill not armed', ...);
it('already_applied with missing collectable items: re-arms fill and prompts the gap', ...);
it('accept mid-fill for another job: switches fill_application_id, scrubs fill_pending, acks switched_job', ...);
it('guard_blocked: generic guard_error reply, turn commits (no throw)', ...);
it('intro appends web_handoff when required_docs contains ssn', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** In `handleJobAction` after `applyWorkerToJob`:

```ts
if (applyResult.status === 'applied' || applyResult.status === 'already_applied') {
  const gaps = await computeNextStep(client, applyResult.application.id);
  if (gaps.kind === 'field' || gaps.kind === 'doc') {
    const prevPending = conv.state_context?.fill_pending;
    await updateConversation(client, conv.id, {
      state_context: {
        ...conv.state_context,
        fill_application_id: applyResult.application.id,
        ...(prevPending ? { fill_pending: undefined } : {}), // scrub on switch
        pending_picker: undefined,
      },
    });
    await queueIntroAndFirstPrompt(client, conv, applyResult.application.id, inboundMessageSid, from); // counts N/M via one SELECT of required_fields/docs + answers/docs presence
    return;
  }
  // no gaps -> legacy behavior
  await queueReply(client, inboundMessageSid, from, applyResult.status === 'applied' ? 'job_accepted' : 'job_already_applied', conv.language);
} else if (applyResult.status === 'guard_blocked') {
  // fillMessage('guard_error') from Task 3 — 'generic_error' does NOT exist
  // in templates.ts, and queueReply is typed on the TemplateKey union.
  await queueOutboxText(client, inboundMessageSid, from, fillMessage('guard_error', conv.language));
}
```

(Use the file's real `updateConversation` signature and existing helpers; for
the no-gaps legacy branch reuse the template keys already at this call site —
read processor.ts:1925-1945 first and keep whatever key the current
already_applied branch sends.) Remove the now-dead `missing_documents` branch for this call site only if `applyWorkerToJob` can still return it for whatsapp (it cannot after Task 2 — delete the branch and its test expectations).

- [ ] **Step 4: Run processor tests** → PASS (including untouched existing accept tests, updated where the old bounce was asserted).

- [ ] **Step 5: Stage & propose commit** — `feat(whatsapp): arm application-fill at accept; intro with requirement counts`

---

### Task 10: Processor dispatch — fill lane precedence

**Files:**
- Modify: `infra/lambda/whatsapp/processor.ts` (seams verified by review: after the forced-idle writeback ~1288, before `handlePickerResponse` ~1349; escapes at 1356-1379; relay at 1381; voice guard 1794-1797)
- Modify: `infra/lambda/whatsapp/lib/conversation-router.ts` — `setFocusedConversation` (~284-299) is the SINGLE set-site for `fill_relay_override` (it is shared by the CHATS picker resolution AND the `conversation:focus` button path, so both are covered); set the flag there only when `fill_application_id` is armed
- Test: `infra/test/unit/lambda/whatsapp/processor.test.ts` (extend)

**Interfaces:**
- Consumes: Task 7/8 `handleFillMessage`, `promptNextStep`, `isFillCancel`, `parseFillConfirmation`.
- Produces: the precedence contract of spec §6, encoded once.

- [ ] **Step 1: Write the failing tests** (the interruption matrix):

```ts
it('media message mid-fill routes to fill lane before any text parsing (caption preserved as untouched)', ...);
it('CANCELAR mid-fill aborts fill; "cancelar" never reaches command fuzzy-matching', ...);
it('"1 si" while fill_pending confirms the answer, does NOT accept recent_jobs[0]', ...);
it('exact "trabajos" escapes to jobs list, then dispatch tail re-prompts pending question', ...);
it('"trabajo de pintor 5 anos" mid-fill is treated as an answer, not the jobs keyword', ...);
it('picker set by CHATS mid-fill wins the next bare digit; fill re-echoes after', ...);
it('CHATS pick sets fill_relay_override; next free text relays to employer then fill re-prompts', ...);
it('fill_relay_override is ONE-TURN: the second free text after the relayed turn feeds the fill', ...);
it('help command escapes and the dispatch tail re-prompts (cooldown-guarded)', ...);
it('profile/support/CERRAR mid-fill escape to their handlers and the tail re-prompts', ...);
it('dispatch-tail cooldown: two escapes within 30s produce one re-prompt', ...);
it('CANCELAR turn gets NO tail re-prompt (updateStateContext mutated conv in place)', ...);
it('voice note at a field step -> field_step_media reply; at a doc step -> voice_note_not_supported', ...);
it('button payload mid-fill returns handled:false and routes normally (job button, legal reply)', ...);
it('redelivered SID after commit resumes outbox only — no second answers merge, no second worker_documents row', ...);
it('happy path end-to-end: accept -> field answer -> confirm -> doc upload -> completion message', ...);
it('worker with NO fill armed: all existing routing byte-identical (regression: relay, pickers, jobs)', ...);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Insert into the ready-worker path **just before
the `pending_picker` dispatch at processor.ts:1349** (i.e. AFTER button-payload
routing :1312-1323, legal replies :1329-1337, and the interactive
commandPayload unwrap :1339-1347 — spec §6: button/list payloads keep top
priority). Two additional escapes are mandatory inside `handleFillMessage`:
(a) a message carrying `buttonPayload` or `interactivePayload` returns
`{handled: false}` unconditionally; (b) a bare 1-2 digit body while
`state_context.pending_picker` is set returns `{handled: false}` so the picker
wins (spec §6.4).

```ts
const fillArmed = typeof conv.state_context?.fill_application_id === 'string';
if (fillArmed) {
  const fillResult = await handleFillMessage(client, fillCtxFrom(conv), msg, fillDeps(client));
  if (fillResult.handled) return;
  // handled:false => escape/command/relay-override — fall through to existing routing
}
```

`handleFillMessage` internally implements the §6 order (buttonPayload/
interactivePayload escape → picker-digit escape → media → CANCELAR →
fill_pending confirmation parse → escape detection returns `{handled:false}`
for: exact jobs keyword, typed job actions, CHATS/CERRAR, help/support/profile
exact+fuzzy matches → relay-override turn → otherwise field/doc handling).
The relay-override branch **clears `fill_relay_override` (spread write via
`deps.updateStateContext`) in the same turn it returns `{handled:false}`** —
one-turn semantics, spec §4.2; without the clear every later free text relays
forever and the fill deadlocks. Escape detection reuses the exported matchers
from `flows.ts` (`parseTypedJobAction`, `matchCommandFuzzy`,
`normalizeCommandText`) — import, don't reimplement; the jobs check uses an
exact-match comparison (`['jobs','trabajos','empleos','job','trabajo','empleo'].includes(normalized)` — exact word only, spec §6.3).
`FillDeps.updateStateContext` writes the DB **and mutates the passed
`conv.state_context` object in place** (the `setFocusedConversation` pattern)
so the dispatch tail below never reads stale state.

Dispatch tail — at the end of `routeMessage` for ready workers (single wrapper around the existing return points; extract the current body into `routeMessageInner` and wrap):

```ts
const result = await routeMessageInner(...);
// conv.state_context is fresh here: every fill-lane write goes through
// FillDeps.updateStateContext, which mutates conv in place after the DB
// write — a CANCELAR/completion turn therefore skips this tail.
if (conv.state_context?.fill_application_id && !fillPromptQueuedThisTurn(conv)) {
  await maybeRepromptFill(client, conv, inboundMessageSid, from); // REPROMPT_COOLDOWN_MS via fill_last_prompt_at
}
return result;
```

`REPROMPT_COOLDOWN_MS`: import from `onboarding-language.ts` (it is exported; if not, export it there — one-line change).

- [ ] **Step 4: Run the full processor suite** → PASS.

- [ ] **Step 5: Stage & propose commit** — `feat(whatsapp): fill-lane dispatch precedence (media-first, CANCELAR, escapes, relay override, reprompt tail)`

---

### Task 11: Completion, multi-app offer, lifecycle exits

**Files:**
- Modify: `infra/lambda/whatsapp/lib/application-fill.ts` (`promptNextStep` exit/complete arms)
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (extend)

**Interfaces:**
- Consumes: `NextStep.exit`/`complete` from Task 6.
- Produces: terminal behaviors for the processor, plus the offer mechanism:
  on completion with another incomplete application, `promptNextStep` writes
  `state_context.fill_offer_application_id = <offered id>` (alongside clearing
  `fill_application_id`/`fill_pending`). The Task 10 fill-lane gate becomes
  `fill_application_id OR fill_offer_application_id armed`; when only the
  offer key is set, `handleFillMessage` handles exactly two inputs — "1"
  (or "1 si") arms `fill_application_id` with the offered id, clears the offer
  key, and prompts that application's first gap; ANY other input clears the
  offer key and returns `{handled: false}` (one-shot offer, no nagging).

- [ ] **Step 1: Write the failing tests**

```ts
it('complete: completion message (+web_handoff when uncollectable non-empty), fill state cleared', ...);
it('complete with another incomplete application: offers continue_other for the most recently updated one', ...);
it('offer reply "1" arms the offered application (via fill_offer_application_id) and prompts its first gap', ...);
it('any non-"1" reply after the offer clears fill_offer_application_id and routes normally (one-shot)', ...);
it('exit job_inactive/application_gone/application_closed: mapped message, full scrub, disarm', ...);
it('fill_pending for a key no longer required is discarded silently on next turn', ...);
```

The "other incomplete applications" query (single statement, covered by existing SELECT grants):

```sql
SELECT ja.id, j.title
  FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
 WHERE ja.worker_id = $1 AND ja.id <> $2
   AND j.status IN ('active','paused')
   AND ja.status IN ('pending','contacted','talking')
 ORDER BY ja.updated_at DESC
```

then filter in code with `computeNextStep` per candidate until one returns `field`/`doc` (cap the scan at 5 candidates); offer at most one.

- [ ] **Step 2-4:** fail → implement → pass (implementation is the `promptNextStep` switch over `NextStep.kind`; every terminal arm writes `state_context` with `fill_application_id: undefined, fill_pending: undefined` via spread).

- [ ] **Step 5: Stage & propose commit** — `feat(whatsapp): fill completion, continue-other offer, lifecycle exits`

---

### Task 12: CDK — documents bucket to the processor

**Files:**
- Modify: `infra/bin/jale-app.ts` (WhatsAppStack at :182, DocumentsStack at :198 — reorder so DocumentsStack is instantiated first, or export the bucket/key by name and import)
- Modify: `infra/lib/stacks/whatsapp-stack.ts` (processor env ~219, grants ~590)
- Modify: `infra/lib/stacks/documents-stack.ts` (expose bucket + key as public readonly props if not already)
- Test: `infra/test/unit/stacks/whatsapp-stack.test.ts` (the existing processor env/IAM assertions live here — the processor lambda is defined in WhatsAppStack, not ApiStack)

**Interfaces:**
- Produces: `DOCUMENTS_BUCKET` env on the processor lambda; IAM `s3:PutObject` on `documents/*` + `kms:GenerateDataKey` on the docs key (both via `documentsBucket.grantPut(processorFn)`).

- [ ] **Step 1: Write the failing stack test** — assert the processor lambda's env contains `DOCUMENTS_BUCKET` and its role policy includes `kms:GenerateDataKey*` referencing the docs key (use `Template.fromStack` `hasResourceProperties`, matching the file's existing assertion style).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Reorder instantiation in `bin/jale-app.ts` (move the `DocumentsStack` block above `WhatsAppStack`; pass `documentsBucket: documentsStack.bucket` as a new WhatsAppStack prop). In `whatsapp-stack.ts`: `props.documentsBucket.grantPut(processorFn); processorFn.addEnvironment('DOCUMENTS_BUCKET', props.documentsBucket.bucketName);`. **Check for cycles:** run `npx cdk synth --quiet` from `infra/` — if it reports a cyclic reference through the shared RestApi, switch to name-based import (`s3.Bucket.fromBucketAttributes` + `kms.Key.fromKeyArn` with values passed as strings through props) instead of the construct reference.
- [ ] **Step 4: Run stack tests + `npx cdk synth --quiet`** → PASS, no cycles.
- [ ] **Step 5: Stage & propose commit** — `feat(infra): grant whatsapp processor put access to documents bucket (KMS)`

---

### Task 13: DB integration suite (grants, RLS, GUC, cert cap)

**Files:**
- Create: `infra/test/unit/db/whatsapp-application-fill-080.integration.test.ts`
- Modify: `infra/scripts/run-whatsapp-v2-db-tests.sh` (append the suite to the `exec npx jest` list; bump the schema-coverage header comment)
- Modify: `infra/test/unit/scripts/run-whatsapp-v2-db-tests.test.ts` (the lock test's suite list)

**Interfaces:** none new — proves Task 1's DB contract end-to-end against a real cluster (the runner's env/secret handling is already in the script).

- [ ] **Step 1: Write the failing lock test change** (add the new filename to the expected list) and the integration suite:

```ts
// as jale_whatsapp with app.current_internal_user_id set:
it('DELETE then INSERT on worker_documents succeeds for own row and fails RLS for another worker', ...);
it('application_answers || merge succeeds under the 073 column grant', ...);
it('job_applications INSERT with missing required docs fails 23514 without GUC and succeeds with set_config(..., true)', ...);
it('GUC is transaction-local: next transaction is guarded again', ...);
it('6th certification INSERT raises 23514 constraint certification_document_limit under RLS context', ...);
it('cert-cap COUNT is RLS-scoped: with GUC identity unset the cap does not fire (documents the footgun)', ...);
it('savepoint rollback leaves nothing: doc INSERT + snapshot copy inside a savepoint, force cert-cap 23514, ROLLBACK TO SAVEPOINT -> neither the worker_documents row nor the snapshot row survives', ...);
```

- [ ] **Step 2: Run the lock test to verify it fails**, then the suite via the runner against a dev cluster: `infra/scripts/run-whatsapp-v2-db-tests.sh` (see the script header for the required env; never print secrets).
- [ ] **Step 3-4:** implement fixtures (reuse the seeding helpers the sibling `*.integration.test.ts` files use — read `retrigger-sweep-definer.integration.test.ts` first and copy its role-switching pattern) → both unit lock test and integration suite PASS.
- [ ] **Step 5: Stage & propose commit** — `test(db): 080 integration coverage — grants, GUC bypass, cert cap under RLS`

---

### Task 14: PII sentinel + final sweep

**Files:**
- Test: `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (extend)
- Modify: only if the sweep finds leaks.

- [ ] **Step 1: Write the sentinel test** (pattern: `onboarding-v2-voice.test.ts:753-803`): run a full extraction-confirm-merge cycle with sentinel strings (`'SENTINEL_ADDRESS_XYZZY'` in the free text and extraction result) through `handleFillMessage` with a spied `console.log`/`console.error`; assert no logged line contains the sentinel; assert logged events DO contain `event: 'ApplicationFillStep'` with key names only.
- [ ] **Step 2: Run — if it fails, remove the offending log fields; re-run to green.**
- [ ] **Step 3: Full regression:** from `infra/`: `npx jest test/unit/lambda/whatsapp test/unit/lambda/lib test/unit/db/migrations test/unit/scripts test/unit/stacks && npx cdk synth --quiet && npm run lint`. All green (stacks + synth cover Task 12's CDK wiring).
- [ ] **Step 4: Stage & propose commit** — `test(whatsapp): PII sentinel guard for application fill`

---

## Self-review notes (already applied)

- Spec coverage: §4 → Tasks 5-8; §5 → Tasks 1-2, 12; §6 → Tasks 9-11 (+10 for precedence); §7 → Tasks 3, 5, 7; §8 → Task 8; §9 → Tasks 6, 11; §11 → Tasks 5, 7, 14; §12 → Tasks 2, 5, 7, 8; §14 → every task's tests + Task 13-14. §10/Stage 2 intentionally absent (separate plan). §13/§15 are non-code.
- Type consistency: `FillDeps`/`FillContext`/`NextStep`/`ExtractionOutcome` defined once (Tasks 5-7) and consumed by name everywhere later.
- Two deliberate read-before-write steps exist (022 function body in Task 1; `worker_documents` column list in Task 8) because copying stale column lists into the plan would be riskier than reading the source at execution time.
