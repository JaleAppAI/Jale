import type { PoolClient } from 'pg';
import {
  buildApplicationStageMessage,
  enqueueApplicationStageNotification,
} from '../../../../lambda/lib/application-stage-notify';

const APPLICATION_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
function notifyInput(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APPLICATION_ID,
    workerId: WORKER_ID,
    kind: 'details_requested' as const,
    jobId: JOB_ID,
    jobTitle: 'Concrete Finisher',
    companyName: 'Fixture Builders',
    frontendBaseUrl: 'https://jaleapp.ai/',
    ...overrides,
  };
}

describe('buildApplicationStageMessage', () => {
  const base = {
    kind: 'details_requested' as const,
    jobTitle: 'Concrete Finisher',
    companyName: 'NB Construction',
    applicationId: APPLICATION_ID,
    url: `https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`,
  };

  it('builds the Spanish details_requested content template', () => {
    const message = buildApplicationStageMessage('es', base);

    expect(message.contentTemplate).toBe('application_update_es');
    expect(message.body).toBe(
      'Actualizacion de tu aplicacion para Concrete Finisher: NB Construction solicito algunos datos adicionales '
      + 'para continuar con la revision. Escribe "aplicaciones" para responder aqui, '
      + `o abre https://jaleapp.ai/es/worker/applications/${APPLICATION_ID} para completarlos en linea.`,
    );
    expect(message.contentVariables).toEqual({
      '1': 'Concrete Finisher',
      '2': 'NB Construction',
      '3': `app-${APPLICATION_ID}`,
      '4': `https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`,
      __fallback_body: message.body,
    });
  });

  it('builds the English details_requested content template', () => {
    const url = `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`;
    const message = buildApplicationStageMessage('en', { ...base, url });

    expect(message.contentTemplate).toBe('application_update_en');
    expect(message.body).toBe(
      'Application update for Concrete Finisher: NB Construction requested additional details '
      + 'before continuing the review. Reply "applications" to answer here, '
      + `or open ${url} to submit them online.`,
    );
    expect(message.contentVariables['4']).toBe(url);
    expect(message.contentVariables.__fallback_body).toBe(message.body);
  });

  it('builds the Spanish hired content template', () => {
    const message = buildApplicationStageMessage('es', { ...base, kind: 'hired' });

    expect(message.contentTemplate).toBe('application_hired_es');
    expect(message.body).toBe(
      'Actualizacion del estado de tu aplicacion para Concrete Finisher: NB Construction te selecciono '
      + `para este puesto. Tu referencia de aplicacion es app-${APPLICATION_ID}. `
      + `Abre ${base.url} para ver los detalles y los siguientes pasos.`,
    );
  });

  it('builds the English hired content template', () => {
    const url = `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`;
    const message = buildApplicationStageMessage('en', { ...base, kind: 'hired', url });

    expect(message.contentTemplate).toBe('application_hired_en');
    expect(message.body).toBe(
      'Application status update for Concrete Finisher: NB Construction selected you for this position. '
      + `Your application reference is app-${APPLICATION_ID}. `
      + `Open ${url} to review the details and the next steps.`,
    );
  });

  it('emits ASCII-only copy', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const kind of ['details_requested', 'hired'] as const) {
        expect(buildApplicationStageMessage(lang, { ...base, kind }).body).toMatch(/^[\x00-\x7F]*$/);
      }
    }
  });

  // D6 (2026-09-04). These four strings travel as `__fallback_body` AND, with
  // {{n}} in place of the values, as the seeded WhatsApp Content templates
  // (scripts/seed-whatsapp-twilio-templates.mjs) -- byte-identically, asserted
  // in that script's own suite. So the rules Meta rejects or recategorises on
  // apply here too, and they are checked on this side as well: a MARKETING
  // classification makes the template unsendable outside the 24h window,
  // which is the only window this lane ever sends in.
  it('keeps every body strictly transactional (no promotional register)', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const kind of ['details_requested', 'hired'] as const) {
        const { body } = buildApplicationStageMessage(lang, { ...base, kind });
        for (const phrase of [
          'good news', 'great news', 'buenas noticias', 'opportunity', 'oportunidad',
          'congratulations', 'felicidades', 'gratis', 'free',
        ]) {
          expect(body.toLowerCase()).not.toContain(phrase);
        }
        expect(body).not.toContain('!');
      }
    }
  });

  it('opens every body with fixed text that names the job, never a value', () => {
    // "Variables can't be at the start or end of the template" was a literal
    // Meta rejection reason. On this side the values are already substituted,
    // so the check is that the body does not BEGIN with one of them.
    for (const lang of ['en', 'es'] as const) {
      for (const kind of ['details_requested', 'hired'] as const) {
        const { body } = buildApplicationStageMessage(lang, { ...base, kind });
        expect(body.startsWith(base.jobTitle)).toBe(false);
        expect(body.startsWith(base.companyName)).toBe(false);
        expect(body.indexOf(base.jobTitle)).toBeGreaterThan(15);
        // ...and the job title is named in the opening clause, before the
        // first sentence break, so a reviewer sees what the message is about.
        expect(body.indexOf(base.jobTitle)).toBeLessThan(body.indexOf(':') + 1);
        expect(body.trimEnd().endsWith('.')).toBe(true);
      }
    }
  });

  it('throws when the application id is not a UUID', () => {
    expect(() => buildApplicationStageMessage('es', { ...base, applicationId: 'app-1' })).toThrow(
      /application_id/,
    );
  });
});

interface StageScript {
  language?: 'en' | 'es';
  hasWhatsappNumber?: boolean;
  claim?: { action: string; reason: string };
  outboxMaterialized?: boolean;
  recipientError?: Error;
  claimError?: Error;
}

/** Answers the two capability calls by statement and records every call. */
function stageClient(script: StageScript = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/jale_cap\.employer_stage_recipient\(/.test(sql)) {
      if (script.recipientError) throw script.recipientError;
      return {
        rows: [{
          worker_id: WORKER_ID,
          language: script.language ?? 'es',
          has_whatsapp_number: script.hasWhatsappNumber ?? true,
        }],
        rowCount: 1,
      };
    }
    if (/jale_cap\.employer_claim_worker_intent\(/.test(sql)) {
      if (script.claimError) throw script.claimError;
      const decision = script.claim ?? { action: 'allow', reason: 'worker_ready' };
      const materialized = script.outboxMaterialized ?? decision.action === 'allow';
      return {
        rows: [{
          intent_id: 'intent-1',
          decision_action: decision.action,
          decision_reason: decision.reason,
          outbox_id: materialized ? 'outbox-1' : null,
          outbox_materialized: materialized,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, calls };
}

const WORKER_LANE_SQL = /worker_message_intents|whatsapp_outbox|worker_onboarding_state|worker_workflow_runs|whatsapp_runtime_controls|whatsapp_conversations/;

function claimCall(calls: Array<{ sql: string; params: unknown[] }>) {
  const claims = calls.filter((call) => /jale_cap\.employer_claim_worker_intent\(/.test(call.sql));
  expect(claims).toHaveLength(1);
  return claims[0];
}

describe('enqueueApplicationStageNotification', () => {
  it('reads the recipient through jale_cap.employer_stage_recipient, then claims through jale_cap.employer_claim_worker_intent, as the employer', async () => {
    const { client, calls } = stageClient();

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(result).toEqual({
      outcome: 'enqueued',
      intentId: 'intent-1',
      decision: { action: 'allow', reason: 'worker_ready' },
      outboxMaterialized: true,
    });
    expect(calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'SELECT worker_id, language, has_whatsapp_number FROM jale_cap.employer_stage_recipient($1)',
      'SELECT intent_id, decision_action, decision_reason, outbox_id, outbox_materialized FROM jale_cap.employer_claim_worker_intent($1, $2, $3, $4::jsonb, $5::jsonb)',
    ]);
    expect(calls[0].params).toEqual([APPLICATION_ID]);
    const [workerId, kind, sourceId] = claimCall(calls).params;
    expect([workerId, kind, sourceId]).toEqual([WORKER_ID, 'application_stage', APPLICATION_ID]);
    // The employer stays the caller for the whole transaction, and the
    // worker lane's tables are reached only through the two functions.
    expect(calls.filter((call) => /set_config/.test(call.sql))).toEqual([]);
    expect(calls.filter((call) => WORKER_LANE_SQL.test(call.sql))).toEqual([]);
  });

  it("keeps today's intent payload", async () => {
    const { client, calls } = stageClient();

    await enqueueApplicationStageNotification(client, notifyInput({ kind: 'hired' }));

    expect(JSON.parse(claimCall(calls).params[3] as string)).toEqual({
      kind: 'application_stage',
      status: 'hired',
      applicationId: APPLICATION_ID,
      jobId: JOB_ID,
      jobTitle: 'Concrete Finisher',
      companyName: 'Fixture Builders',
      frontendBaseUrl: 'https://jaleapp.ai/',
    });
  });

  it("pre-renders the content template in the recipient's language, with a normalized url", async () => {
    const { client, calls } = stageClient({ language: 'en' });

    await enqueueApplicationStageNotification(client, notifyInput());

    const url = `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`;
    const expected = buildApplicationStageMessage('en', {
      kind: 'details_requested', jobTitle: 'Concrete Finisher', companyName: 'Fixture Builders',
      applicationId: APPLICATION_ID, url,
    });
    const message = JSON.parse(claimCall(calls).params[4] as string);
    expect(message).toEqual({ content_template: 'application_update_en', content_variables: expected.contentVariables });
    expect(message.content_variables['4']).toBe(url);
    expect(message.content_variables.__fallback_body).toContain('Fixture Builders');
  });

  it('renders Spanish for a Spanish recipient, never English', async () => {
    const { client, calls } = stageClient({ language: 'es' });

    await enqueueApplicationStageNotification(client, notifyInput({ kind: 'hired' }));

    const message = JSON.parse(claimCall(calls).params[4] as string);
    expect(message.content_template).toBe('application_hired_es');
    expect(message.content_variables['4']).toBe(`https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`);
  });

  it('passes no message for a worker with no usable number, and reports renderer_unavailable without throwing', async () => {
    const { client, calls } = stageClient({
      hasWhatsappNumber: false,
      claim: { action: 'reject', reason: 'renderer_unavailable' },
    });

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(claimCall(calls).params[4]).toBeNull();
    expect(result).toEqual({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
  });

  it.each([
    ['an empty company name', { companyName: '' }],
    ['an empty job title', { jobTitle: '' }],
    ['an empty frontend base url', { frontendBaseUrl: '' }],
    ['an application id that is not a UUID', { applicationId: 'not-a-uuid' }],
  ])('passes no message when the copy cannot be built (%s)', async (_label, overrides) => {
    const { client, calls } = stageClient();

    await enqueueApplicationStageNotification(client, notifyInput(overrides));

    expect(claimCall(calls).params[4]).toBeNull();
  });

  it('a worker mid-onboarding is a plain success: the intent is deferred, nothing is sent yet', async () => {
    const { client } = stageClient({ claim: { action: 'defer', reason: 'worker_onboarding' } });

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(result).toEqual({
      outcome: 'enqueued',
      intentId: 'intent-1',
      decision: { action: 'defer', reason: 'worker_onboarding' },
      outboxMaterialized: false,
    });
  });

  it('a repeat of the same change reports no new outbox row', async () => {
    const { client } = stageClient({ outboxMaterialized: false });

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: false });
  });

  it('propagates any other error from either call', async () => {
    const refused = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(
      enqueueApplicationStageNotification(stageClient({ recipientError: refused }).client, notifyInput()),
    ).rejects.toThrow('permission denied');
    await expect(
      enqueueApplicationStageNotification(stageClient({ claimError: new Error('boom') }).client, notifyInput()),
    ).rejects.toThrow('boom');
  });
});
