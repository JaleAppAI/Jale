// infra/test/unit/lambda/whatsapp/lib/application-prompts.test.ts
//
// The stage-1 prompt lane (sprint 23). The DB is a SQL-SHAPE-routed fake
// rather than a `mockResolvedValueOnce` queue: the lane's query sequence is
// an implementation detail of the shared engine
// (lib/application-requirements.ts), and a positional queue would turn every
// future change there into a red test here for no behavioral reason. Tests
// declare STATE (the application row) and assert on REPLIES and the
// state_context patches -- the two things that are actually contractual.
//
// templates.ts / application-fill-prompts.ts are left UNMOCKED: the copy is
// part of what is under test.
import {
  armPromptLane,
  handlePromptMessage,
  repromptPromptLane,
  type PromptContext,
  type PromptDeps,
} from '../../../../../lambda/whatsapp/lib/application-prompts';
import { fillMessage } from '../../../../../lambda/whatsapp/lib/application-fill-prompts';
import { t } from '../../../../../lambda/whatsapp/lib/templates';
import { MAX_PROMPT_ANSWER_LENGTH } from '../../../../../lambda/lib/pre-application-prompts';
import { REPROMPT_COOLDOWN_MS } from '../../../../../lambda/whatsapp/lib/onboarding-language';
import type { IncomingMessage } from '../../../../../lambda/whatsapp/lib/conversation-router';

const APPLICATION_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WORKER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const JOB_ID = 'cccccccc-0000-4000-8000-00000000000c';
const NOW_MS = 1_756_000_000_000;

const PROMPTS = [
  { id: 'p1', text: 'Do you have your own tools?' },
  { id: 'p2', text: 'When can you start?' },
];

// ── The routed DB fake ────────────────────────────────────────────────────
//
// One mutable row plus a merge sink. `promptMerges` records every jsonb
// object the write-once UPDATE was handed, so tests assert on WHAT was
// written without depending on WHERE in the call list it landed.
let row: Record<string, unknown>;
let promptMerges: Record<string, string>[];
let mergeError: { code: string; constraint: string } | null;

const mockQuery = jest.fn(async (sql: string, params?: unknown[]) => {
  if (/FROM job_applications ja JOIN jobs j/i.test(sql)) {
    return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
  }
  if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/i.test(sql.trim())) {
    return { rowCount: 0, rows: [] };
  }
  if (/SET prompt_answers = \$1::jsonb \|\| prompt_answers/i.test(sql)) {
    if (mergeError) throw Object.assign(new Error('check violation'), mergeError);
    const patch = JSON.parse((params as unknown[])[0] as string) as Record<string, string>;
    promptMerges.push(patch);
    // Write-once per id: the EXISTING value wins for a key present in both.
    row.prompt_answers = { ...patch, ...(row.prompt_answers as Record<string, string>) };
    return { rowCount: 1, rows: [{ total: 128 }] };
  }
  throw new Error(`unmocked query: ${sql}`);
});
const client: any = { query: mockQuery };

function setRow(overrides: Record<string, unknown> = {}): void {
  row = {
    id: APPLICATION_ID,
    worker_id: WORKER_ID,
    job_id: JOB_ID,
    application_status: 'pending',
    application_answers: {},
    prompt_answers: {},
    details_requested_at: null,
    details_completed_at: null,
    applied_at: 'ts',
    updated_at: 'ts',
    job_status: 'active',
    job_title: 'Electrician',
    required_fields: [],
    optional_fields: [],
    required_docs: [],
    optional_docs: [],
    certification_requirements: null,
    pre_application_prompts: PROMPTS,
    have_docs: [],
    ...overrides,
  };
}

function makeCtx(stateContext: Record<string, unknown> = {}): PromptContext {
  return { conversationId: 'conv-1', workerId: WORKER_ID, lang: 'en', stateContext };
}

interface TestDeps extends PromptDeps { replies: string[]; patches: Record<string, unknown>[] }

function makeDeps(ctx: PromptContext): TestDeps {
  const replies: string[] = [];
  const patches: Record<string, unknown>[] = [];
  return {
    replies,
    patches,
    queueReplyText: async (_c, _sid, _to, body) => { replies.push(body); },
    // Mirrors the processor's real updater: persist AND mutate in place.
    updateStateContext: async (_c, _id, patch) => {
      patches.push(patch);
      Object.assign(ctx.stateContext, patch);
    },
    nowMs: () => NOW_MS,
  };
}

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    from: 'whatsapp:+15125551234',
    body: '',
    messageSid: 'SM1',
    numMedia: 0,
    ...overrides,
  } as IncomingMessage;
}

beforeEach(() => {
  jest.clearAllMocks();
  promptMerges = [];
  mergeError = null;
  setRow();
});

describe('armPromptLane', () => {
  it('asks the first prompt as "Question i of n" and arms the lane', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await armPromptLane(client, ctx, APPLICATION_ID, 'SM1', '+15125551234', deps);

    expect(deps.replies).toEqual([
      fillMessage('prompt_ask', 'en', { i: '1', n: '2', text: PROMPTS[0].text }),
    ]);
    expect(ctx.stateContext.prompt_application_id).toBe(APPLICATION_ID);
    expect(ctx.stateContext.prompt_last_prompt_at).toBe(NOW_MS);
  });

  it('scrubs EVERY fill-lane key and the applications menu in the arm write', async () => {
    // The two lanes are mutually exclusive: a worker cannot be mid-prompts
    // and mid-document-upload at once.
    const ctx = makeCtx({
      fill_application_id: 'other-app',
      fill_pending: { key: 'date_of_birth', stage: 'confirm', extracted: 'x' },
      fill_cert_more_pending: true,
      fill_relay_override: true,
      fill_offer_application_id: 'offer-app',
      applications_menu: { ids: ['x'], at: 1 },
    });
    const deps = makeDeps(ctx);

    await armPromptLane(client, ctx, APPLICATION_ID, 'SM1', '+15125551234', deps);

    const arm = deps.patches[0];
    expect(arm.fill_application_id).toBeNull();
    expect(arm.fill_pending).toBeNull();
    expect(arm.fill_cert_more_pending).toBeNull();
    expect(arm.fill_relay_override).toBeNull();
    expect(arm.fill_offer_application_id).toBeNull();
    expect(arm.applications_menu).toBeNull();
    expect(arm.prompt_application_id).toBe(APPLICATION_ID);
  });

  it('confirms immediately and arms NOTHING when the job asks no prompts', async () => {
    setRow({ pre_application_prompts: [] });
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await armPromptLane(client, ctx, APPLICATION_ID, 'SM1', '+15125551234', deps);

    expect(deps.replies).toEqual([t('job_accepted', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
  });

  it('uses job_already_applied when the accept was a re-tap on a fully answered job', async () => {
    setRow({ prompt_answers: { p1: 'yes', p2: 'monday' } });
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await armPromptLane(client, ctx, APPLICATION_ID, 'SM1', '+15125551234', deps, {
      completeKey: 'job_already_applied',
    });

    expect(deps.replies).toEqual([t('job_already_applied', 'en')]);
  });

  it('exits instead of asking when the job is already filled', async () => {
    setRow({ job_status: 'filled' });
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await armPromptLane(client, ctx, APPLICATION_ID, 'SM1', '+15125551234', deps);

    expect(deps.replies).toEqual([fillMessage('exit_job_inactive', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
  });
});

describe('handlePromptMessage', () => {
  function armedCtx(extra: Record<string, unknown> = {}): PromptContext {
    return makeCtx({ prompt_application_id: APPLICATION_ID, prompt_last_prompt_at: 0, ...extra });
  }

  it('is not ours when no lane is armed', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    expect(await handlePromptMessage(client, ctx, msg({ body: 'hello' }), deps)).toEqual({ handled: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('merges the answer and asks the NEXT prompt', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(client, ctx, msg({ body: '  Yes, all of them  ' }), deps);

    expect(result).toEqual({ handled: true });
    // Trimmed by normalizePromptAnswers, keyed on the prompt id.
    expect(promptMerges).toEqual([{ p1: 'Yes, all of them' }]);
    expect(deps.replies).toEqual([
      fillMessage('prompt_ask', 'en', { i: '2', n: '2', text: PROMPTS[1].text }),
    ]);
    expect(ctx.stateContext.prompt_application_id).toBe(APPLICATION_ID);
  });

  it('clears the lane and sends the revised job_accepted after the LAST prompt', async () => {
    setRow({ prompt_answers: { p1: 'yes' } });
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    await handlePromptMessage(client, ctx, msg({ body: 'Monday' }), deps);

    expect(promptMerges).toEqual([{ p2: 'Monday' }]);
    expect(deps.replies).toEqual([t('job_accepted', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
    expect(ctx.stateContext.prompt_last_prompt_at).toBeNull();
  });

  it('answers media with prompt_text_only and KEEPS the lane', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(client, ctx, msg({ numMedia: 1, mediaUrl: 'u' }), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.replies).toEqual([fillMessage('prompt_text_only', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBe(APPLICATION_ID);
    expect(promptMerges).toEqual([]);
  });

  it('rejects an over-long answer without writing anything', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(
      client, ctx, msg({ body: 'x'.repeat(MAX_PROMPT_ANSWER_LENGTH + 1) }), deps,
    );

    expect(result).toEqual({ handled: true });
    expect(deps.replies).toEqual([fillMessage('prompt_too_long', 'en')]);
    expect(promptMerges).toEqual([]);
    // Bounded BEFORE any query -- a hostile 100KB body never reaches the DB.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts an answer exactly at the per-answer bound', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    await handlePromptMessage(client, ctx, msg({ body: 'y'.repeat(MAX_PROMPT_ANSWER_LENGTH) }), deps);

    expect(promptMerges).toEqual([{ p1: 'y'.repeat(MAX_PROMPT_ANSWER_LENGTH) }]);
  });

  it('cancelar clears the lane and KEEPS the application with its partial answers', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(client, ctx, msg({ body: 'CANCELAR' }), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.replies).toEqual([fillMessage('prompt_canceled', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
    // Locked decision: nothing is deleted and nothing is rolled back.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('stands aside for a button/interactive payload', async () => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);
    expect(
      await handlePromptMessage(client, ctx, msg({ buttonPayload: 'accept:job-1' }), deps),
    ).toEqual({ handled: false });
    expect(
      await handlePromptMessage(client, ctx, msg({ interactivePayload: '{}' }), deps),
    ).toEqual({ handled: false });
  });

  it.each([
    ['help', 'a reserved command'],
    ['chats', 'the chats keyword'],
    ['trabajos', 'the exact jobs keyword'],
    ['1 aceptar', 'a typed job action'],
    ['aplicaciones', 'the applications command'],
  ])('stands aside for %s (%s)', async (body) => {
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(client, ctx, msg({ body }), deps);

    expect(result).toEqual({ handled: false });
    expect(promptMerges).toEqual([]);
    expect(ctx.stateContext.prompt_application_id).toBe(APPLICATION_ID);
  });

  it('stands aside for a picker digit while pending_picker is armed', async () => {
    const ctx = armedCtx({ pending_picker: { kind: 'chats' } });
    const deps = makeDeps(ctx);
    expect(await handlePromptMessage(client, ctx, msg({ body: '2' }), deps)).toEqual({ handled: false });
  });

  it('answers a lifecycle exit and clears the lane when the application closed mid-flow', async () => {
    setRow({ application_status: 'not_interested' });
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    await handlePromptMessage(client, ctx, msg({ body: 'yes' }), deps);

    expect(deps.replies).toEqual([fillMessage('exit_application_closed', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
    expect(promptMerges).toEqual([]);
  });

  it('answers exit_application_gone when the row vanished', async () => {
    (row as unknown) = null;
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    await handlePromptMessage(client, ctx, msg({ body: 'yes' }), deps);

    expect(deps.replies).toEqual([fillMessage('exit_application_gone', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBeNull();
  });

  it('maps the DB byte-cap violation to prompt_too_long instead of a 500', async () => {
    // Only the DB can see the POST-MERGE accumulated size; the app-side
    // per-answer bound above cannot.
    mergeError = { code: '23514', constraint: 'job_applications_prompt_answers_valid' };
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    const result = await handlePromptMessage(client, ctx, msg({ body: 'ok' }), deps);

    expect(result).toEqual({ handled: true });
    expect(deps.replies).toEqual([fillMessage('prompt_too_long', 'en')]);
    expect(ctx.stateContext.prompt_application_id).toBe(APPLICATION_ID);
  });

  it('re-derives the outstanding prompt from the DB, never from a cursor in state', async () => {
    // The employer answered nothing; the WORKER already answered p1 through
    // the web door since the lane was armed. The next question must be p2.
    setRow({ prompt_answers: { p1: 'already answered on the web' } });
    const ctx = armedCtx();
    const deps = makeDeps(ctx);

    await handlePromptMessage(client, ctx, msg({ body: 'Monday' }), deps);

    expect(promptMerges).toEqual([{ p2: 'Monday' }]);
  });
});

describe('repromptPromptLane', () => {
  it('re-sends the outstanding prompt after an escape queued its own reply', async () => {
    const ctx = makeCtx({ prompt_application_id: APPLICATION_ID, prompt_last_prompt_at: NOW_MS - REPROMPT_COOLDOWN_MS - 1 });
    const deps = makeDeps(ctx);

    await repromptPromptLane(client, ctx, 'SM1', '+15125551234', deps);

    expect(deps.replies).toEqual([
      fillMessage('prompt_ask', 'en', { i: '1', n: '2', text: PROMPTS[0].text }),
    ]);
  });

  it('stays silent inside the cooldown window', async () => {
    const ctx = makeCtx({ prompt_application_id: APPLICATION_ID, prompt_last_prompt_at: NOW_MS - 1_000 });
    const deps = makeDeps(ctx);

    await repromptPromptLane(client, ctx, 'SM1', '+15125551234', deps);

    expect(deps.replies).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is a no-op when no lane is armed', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    await repromptPromptLane(client, ctx, 'SM1', '+15125551234', deps);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
