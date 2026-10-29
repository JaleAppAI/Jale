/**
 * r-paths-employer-messaging.integration.test.ts
 *
 * The employer's conversation endpoints -- POST /employer/conversations
 * (employer-conversations-create.ts) and POST
 * /employer/conversations/{conversationId}/messages
 * (employer-conversations-send.ts) -- driven end to end on their request
 * login, jale_api, against seeded data. jale_api holds no rights on the
 * worker lane's tables, so the worker's lifecycle and languages and the
 * employer_chat intent go through jale_cap.employer_worker_delivery_context
 * and jale_cap.employer_claim_worker_intent. These cases pin today's
 * behaviour on that path:
 *
 *   - a ready worker gets the v1 delivery: the approved invite template in
 *     the WhatsApp conversation's language outside the reply window (English
 *     for an English worker -- never a silent Spanish fallback -- and Spanish
 *     when there is no conversation language), or the employer's own words
 *     with the context header inside it; no intent is written;
 *   - a worker who is not ready (onboarding, or no onboarding row yet) gets
 *     one deferred employer_chat intent per message, named by that message,
 *     and the message waits for the worker's reply; nothing is sent;
 *   - a suspended worker's message is kept and its intent is rejected;
 *   - an employer cannot reach a worker who is not their applicant, and the
 *     two capability functions refuse anything outside the caller's own
 *     applicants.
 *
 * Twilio is replaced by a recorder; every assertion reads through the
 * superuser, so what is asserted is what the database holds.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createCheckedPool, setInternalUserRlsContext } from '../../../lambda/lib/db';
import { auditCallerFor } from '../../../lambda/lib/audit/caller';
import { setAuditContext } from '../../../lambda/lib/audit/context';
import { recordWorkerConversationReply } from '../../../lambda/lib/job-messaging';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginClient, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const sent: Array<{ to: string; template: string | null; body: string | null }> = [];
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: { content_template: string | null; body: string | null }) => {
      sent.push({ to, template: row.content_template, body: row.body });
      return `fake-sid-${randomUUID()}`;
    }),
  };
});

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: createHandler } = require('../../../lambda/api/employer-conversations-create');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: sendHandler } = require('../../../lambda/api/employer-conversations-send');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: inboxHandler } = require('../../../lambda/api/employer-inbox');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: listHandler } = require('../../../lambda/api/employer-conversations-list');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: detailHandler } = require('../../../lambda/api/employer-conversations-detail');

if (!databaseUrl) {
  test('CONCERN: the employer messaging DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const COMPANY = 'Fixture Messaging Co';
const JOB_TITLE = 'Fixture Welder';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface Applicant {
  id: string;
  phone: string | null;
  applicationId: string;
}

interface Scene {
  world: World;
  employer: { id: string; sub: string };
  otherEmployer: { id: string; sub: string };
  jobId: string;
  readyEn: Applicant;
  readyEs: Applicant;
  readyNoConversation: Applicant;
  onboardingEn: Applicant;
  noState: Applicant;
  suspended: Applicant;
  /** Applied to the other employer's job only. */
  stranger: Applicant;
  /** A message in the other employer's conversation with the stranger. */
  strangerMessageId: string;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: COMPANY });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
  const job = await world.job(employer.id, { title: JOB_TITLE });
  const otherJob = await world.job(otherEmployer.id, { title: 'Other Fixture Job' });

  async function applicant(opts: Parameters<World['worker']>[0], jobId = job.id): Promise<Applicant> {
    const worker = await world.worker(opts);
    const applicationId = await world.application(jobId, worker.id, 'pending');
    return { id: worker.id, phone: worker.phone, applicationId };
  }

  const readyEn = await applicant({ lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' });
  const readyEs = await applicant({ lifecycle: 'ready', whatsappLanguage: 'es', workflowLanguage: 'es' });
  const readyNoConversation = await applicant({ lifecycle: 'ready', workflowLanguage: 'en' });
  const onboardingEn = await applicant({ lifecycle: 'onboarding', workflowLanguage: 'en', whatsappLanguage: 'en' });
  const noState = await applicant({});
  const suspended = await applicant({ lifecycle: 'suspended', whatsappLanguage: 'es' });
  const stranger = await applicant({ lifecycle: 'onboarding', workflowLanguage: 'es' }, otherJob.id);

  const strangerConversation = await world.conversation({
    jobId: otherJob.id, employerId: otherEmployer.id, workerId: stranger.id, applicationId: stranger.applicationId,
  });
  const strangerMessageId = await world.message(strangerConversation, 'Other employer message', 'waiting_worker_reply');

  return {
    world, employer, otherEmployer, jobId: job.id,
    readyEn, readyEs, readyNoConversation, onboardingEn, noState, suspended, stranger, strangerMessageId,
  };
}

async function create(s: Scene, worker: Applicant, initialMessage: string) {
  return parseResponse(await createHandler(apiEvent({
    sub: s.employer.sub,
    httpMethod: 'POST',
    resource: '/employer/conversations',
    body: { job_id: s.jobId, worker_id: worker.id, initial_message: initialMessage },
  })));
}

async function send(s: Scene, conversationId: string, body: string) {
  return parseResponse(await sendHandler(apiEvent({
    sub: s.employer.sub,
    httpMethod: 'POST',
    resource: '/employer/conversations/{conversationId}/messages',
    pathParameters: { conversationId },
    body: { body },
  })));
}

/** An open conversation with `worker`, seeded directly, optionally inside the reply window. */
async function seededConversation(s: Scene, worker: Applicant, replyWindowOpen: boolean): Promise<string> {
  return s.world.conversation({
    jobId: s.jobId,
    employerId: s.employer.id,
    workerId: worker.id,
    applicationId: worker.applicationId,
    lastWorkerMessageAt: replyWindowOpen ? new Date(Date.now() - 60 * 60 * 1000) : null,
  });
}

async function rows(s: Scene, sql: string, params: unknown[]): Promise<any[]> {
  return (await s.world.su.query(sql, params)).rows;
}

async function messagesOf(s: Scene, conversationId: string) {
  return rows(s, `SELECT id, body, status FROM job_conversation_messages
                   WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]);
}

async function jobOutboxOf(s: Scene, conversationId: string) {
  return rows(s, `SELECT message_id, send_kind, body, content_template, content_variables, status
                    FROM job_message_outbox WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]);
}

async function intentsOf(s: Scene, workerId: string) {
  return rows(s, `SELECT id, category, owner_service, source_type, source_id, dedupe_key, priority, status,
                         decision_reason, payload, outbox_id, expires_at, created_at
                    FROM worker_message_intents WHERE user_id = $1 ORDER BY created_at, id`, [workerId]);
}

async function workerOutboxCount(s: Scene, workerId: string): Promise<number> {
  const [row] = await rows(s, `SELECT count(*)::int AS n FROM whatsapp_outbox o
                                 JOIN worker_message_intents i ON i.outbox_id = o.id
                                WHERE i.user_id = $1`, [workerId]);
  return row.n;
}

async function conversationWith(s: Scene, workerId: string): Promise<{ id: string; worker_thread_number: number | null }> {
  const found = await rows(s, `SELECT id, worker_thread_number FROM job_conversations
                                WHERE job_id = $1 AND employer_id = $2 AND worker_id = $3`,
  [s.jobId, s.employer.id, workerId]);
  expect(found).toHaveLength(1);
  return found[0];
}

/** Runs `sql` as jale_api inside a transaction carrying `caller`'s context; returns the error, if any. */
async function asEmployer(caller: { id: string; sub: string }, sql: string, params: unknown[]) {
  const client = loginClient('jale_api');
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
    try {
      const result = await client.query(sql, params);
      return { rows: result.rows, error: null as null | { code?: string } };
    } catch (err) {
      return { rows: [] as any[], error: err as { code?: string } };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'employer messaging on jale_api', () => {
  let s: Scene;
  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    sent.length = 0;
    s = await scene();
  });
  afterEach(async () => {
    await s.world.cleanup();
    await s.world.end();
  });

  describe('a ready worker gets the v1 delivery', () => {
    it('a new conversation with an English worker opens with the English invite template and fallback, and writes no intent', async () => {
      const response = await create(s, s.readyEn, 'Fixture hello');
      expect(response.statusCode).toBe(201);

      const conversation = await conversationWith(s, s.readyEn.id);
      expect(response.body.conversation.id).toBe(conversation.id);
      expect(response.body.messages.map((m: { body: string }) => m.body)).toEqual(['Fixture hello']);
      expect(conversation.worker_thread_number).not.toBeNull();

      const [message] = await messagesOf(s, conversation.id);
      expect(message).toMatchObject({ body: 'Fixture hello', status: 'waiting_worker_reply' });

      const outbox = await jobOutboxOf(s, conversation.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ message_id: message.id, send_kind: 'template', content_template: 'employer_message_invite_en' });
      // world.employer() saves no contact name, so the label is the company alone.
      expect(outbox[0].content_variables).toMatchObject({
        '1': COMPANY,
        '2': JOB_TITLE,
        '5': `conversation:open:${conversation.id}`,
        '6': `conversation:decline:${conversation.id}`,
        __fallback_body: `${COMPANY} sent you a message about ${JOB_TITLE}. Reply here to open the conversation.`,
      });
      // The flush after COMMIT sent it, on the same login.
      expect(sent).toEqual([{ to: `whatsapp:${s.readyEn.phone}`, template: 'employer_message_invite_en', body: null }]);
      expect(outbox[0].status).toBe('sent');

      expect(await intentsOf(s, s.readyEn.id)).toEqual([]);
    });

    it('a Spanish worker gets the Spanish invite template', async () => {
      const response = await create(s, s.readyEs, 'Fixture hola');
      expect(response.statusCode).toBe(201);
      const conversation = await conversationWith(s, s.readyEs.id);
      const outbox = await jobOutboxOf(s, conversation.id);
      expect(outbox.map((row) => row.content_template)).toEqual(['employer_message_invite_es']);
      expect(outbox[0].content_variables.__fallback_body).toBe(
        `${COMPANY} te envio un mensaje sobre ${JOB_TITLE}. Responde aqui para abrir la conversacion.`,
      );
    });

    it('a worker with no WhatsApp conversation language gets the Spanish invite template, as before', async () => {
      const response = await create(s, s.readyNoConversation, 'Fixture hola');
      expect(response.statusCode).toBe(201);
      const conversation = await conversationWith(s, s.readyNoConversation.id);
      expect((await jobOutboxOf(s, conversation.id)).map((row) => row.content_template)).toEqual(['employer_message_invite_es']);
    });

    it('a follow-up outside the reply window gets the resume template in the worker language', async () => {
      const conversationId = await seededConversation(s, s.readyEn, false);
      const response = await send(s, conversationId, 'Fixture follow-up');
      expect(response.statusCode).toBe(200);
      const outbox = await jobOutboxOf(s, conversationId);
      expect(outbox.map((row) => row.content_template)).toEqual(['employer_message_resume_en']);
    });

    it('a second follow-up outside the reply window queues no second template while the first is un-actioned', async () => {
      const conversationId = await seededConversation(s, s.readyEn, false);
      expect((await send(s, conversationId, 'Fixture first follow-up')).statusCode).toBe(200);
      expect((await send(s, conversationId, 'Fixture second follow-up')).statusCode).toBe(200);

      // Both messages are stored and wait for the worker; the dedupe read of
      // the outbox sees the first template, so exactly one is queued.
      const messages = await messagesOf(s, conversationId);
      expect(messages.map((row) => [row.body, row.status])).toEqual([
        ['Fixture first follow-up', 'waiting_worker_reply'],
        ['Fixture second follow-up', 'waiting_worker_reply'],
      ]);
      const outbox = await jobOutboxOf(s, conversationId);
      expect(outbox.map((row) => [row.send_kind, row.content_template, row.message_id])).toEqual([
        ['template', 'employer_message_resume_en', messages[0].id],
      ]);
    });

    it("a follow-up inside the reply window sends the employer's own words with the context header", async () => {
      const conversationId = await seededConversation(s, s.readyEs, true);
      const response = await send(s, conversationId, 'Fixture follow-up');
      expect(response.statusCode).toBe(200);

      const [message] = await messagesOf(s, conversationId);
      expect(message.body).toBe('Fixture follow-up');
      const outbox = await jobOutboxOf(s, conversationId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ message_id: message.id, send_kind: 'freeform', content_template: null });
      expect(outbox[0].body).toMatch(new RegExp(`^🏢 ${COMPANY} — ${JOB_TITLE}( \\(#\\d+\\))?\\nFixture follow-up$`));
      // Sent by the flush, so the employer's message is marked sent.
      expect((await messagesOf(s, conversationId))[0].status).toBe('sent');
      expect(await intentsOf(s, s.readyEs.id)).toEqual([]);
    });
  });

  // Phase 4: the worker sees the person who wrote, "{contact} ({company})",
  // read on jale_api through jale_cap.employer_contact_name and
  // employer_display_name (the owner's company), and the flush on the
  // worker's reply (jale_whatsapp) heads each waiting message with its own
  // writer.
  describe('the worker sees the person who wrote', () => {
    async function foremanScene() {
      const foreman = await s.world.foreman(s.employer.id, { contactName: 'Fer Gómez' });
      const job = await s.world.job(foreman.id, { title: 'Fixture Roofer' });
      const applicationId = await s.world.application(job.id, s.readyEn.id, 'pending');
      return { foreman, jobId: job.id, applicationId };
    }

    it("a foreman's first message: the invite's {{1}} and fallback carry the foreman's label", async () => {
      const f = await foremanScene();
      const response = parseResponse(await createHandler(apiEvent({
        sub: f.foreman.sub,
        httpMethod: 'POST',
        resource: '/employer/conversations',
        body: { job_id: f.jobId, worker_id: s.readyEn.id, initial_message: 'Fixture foreman hello' },
      })));
      expect(response.statusCode).toBe(201);
      const [outbox] = await jobOutboxOf(s, response.body.conversation.id);
      expect(outbox.content_variables['1']).toBe(`Fer Gómez (${COMPANY})`);
      expect(outbox.content_variables.__fallback_body)
        .toBe(`Fer Gómez (${COMPANY}) sent you a message about Fixture Roofer. Reply here to open the conversation.`);
    });

    it("waiting messages from the foreman and then the owner are each headed with their writer's label when the worker replies", async () => {
      const f = await foremanScene();
      await s.world.su.query(`UPDATE employer_profiles SET contact_name = 'Olga' WHERE user_id = $1`, [s.employer.id]);
      const conversationId = await s.world.conversation({
        jobId: f.jobId, employerId: f.foreman.id, workerId: s.readyEn.id, applicationId: f.applicationId,
      });
      const sendAs = (who: { sub: string }, body: string) => sendHandler(apiEvent({
        sub: who.sub,
        httpMethod: 'POST',
        resource: '/employer/conversations/{conversationId}/messages',
        pathParameters: { conversationId },
        body: { body },
      }));
      expect(parseResponse(await sendAs(f.foreman, 'Fixture from F')).statusCode).toBe(200);
      expect(parseResponse(await sendAs(s.employer, 'Fixture from O')).statusCode).toBe(200);
      // A row with no sender, as rows from before 118 are: it is named by
      // the conversation's employer, the foreman.
      await s.world.message(conversationId, 'Fixture with no sender', 'waiting_worker_reply');
      const waiting = await rows(s, `SELECT body, sender_user_id, status FROM job_conversation_messages
                                      WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]);
      expect(waiting).toEqual([
        { body: 'Fixture from F', sender_user_id: f.foreman.id, status: 'waiting_worker_reply' },
        { body: 'Fixture from O', sender_user_id: s.employer.id, status: 'waiting_worker_reply' },
        { body: 'Fixture with no sender', sender_user_id: null, status: 'waiting_worker_reply' },
      ]);
      // The worker replies on WhatsApp as the processor does: jale_whatsapp,
      // the worker as the caller, inside one transaction.
      const wa = loginClient('jale_whatsapp');
      await wa.connect();
      try {
        await wa.query('BEGIN');
        await setInternalUserRlsContext(wa as unknown as PoolClient, s.readyEn.id);
        await setAuditContext(wa as unknown as PoolClient,
          auditCallerFor(`fixture-${randomUUID()}`, { kind: 'worker', id: s.readyEn.id }, 'whatsapp'), 'whatsapp.inbound');
        const routed = await recordWorkerConversationReply(
          wa as unknown as PoolClient, s.readyEn.id, 'Fixture reply', `whatsapp:${s.readyEn.phone}`,
          `SMfixture${randomUUID().replace(/-/g, '')}`, conversationId,
        );
        expect(routed).toEqual({ status: 'routed', conversationId });
        await wa.query('COMMIT');
      } catch (err) {
        await wa.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        await wa.end();
      }

      // In the messages' own order, by created_at: the rows are written in
      // one transaction, each stamped with clock_timestamp().
      const freeform = (await jobOutboxOf(s, conversationId)).filter((row) => row.send_kind === 'freeform');
      expect(freeform.map((row) => row.body)).toEqual([
        `🏢 Fer Gómez (${COMPANY}) — Fixture Roofer\nFixture from F`,
        `🏢 Olga (${COMPANY}) — Fixture Roofer\nFixture from O`,
        `🏢 Fer Gómez (${COMPANY}) — Fixture Roofer\nFixture with no sender`,
      ]);
      // Compared in SQL: microseconds, which a JS Date would round away.
      const [stamps] = await rows(s, `SELECT count(DISTINCT created_at)::int AS n FROM job_message_outbox
                                       WHERE conversation_id = $1 AND send_kind = 'freeform'`, [conversationId]);
      expect(stamps.n).toBe(3);
    });

    it('a system row is never the preview; a thread with only system rows has none', async () => {
      const f = await foremanScene();
      const conversationId = await s.world.conversation({
        jobId: f.jobId, employerId: f.foreman.id, workerId: s.readyEn.id, applicationId: f.applicationId,
      });
      const system = (body: string) => s.world.su.query(
        `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
         VALUES ($1, 'system', 'outbound', $2, 'sent')`, [conversationId, body]);
      const previews = async () => {
        const inbox = parseResponse(await inboxHandler(apiEvent({ sub: s.employer.sub, resource: '/employer/inbox' })));
        const list = parseResponse(await listHandler(apiEvent({ sub: s.employer.sub, resource: '/employer/conversations' })));
        const detail = parseResponse(await detailHandler(apiEvent({
          sub: s.employer.sub, resource: '/employer/conversations/{conversationId}', pathParameters: { conversationId },
        })));
        expect([inbox.statusCode, list.statusCode, detail.statusCode]).toEqual([200, 200, 200]);
        return [
          inbox.body.items.find((i: { conversation_id: string | null }) => i.conversation_id === conversationId).last_message_preview,
          list.body.conversations.find((c: { id: string }) => c.id === conversationId).last_message_preview,
          detail.body.conversation.last_message_preview,
        ];
      };

      await system('Fixture move notice');
      expect(await previews()).toEqual([null, null, null]);

      await s.world.message(conversationId, 'Fixture employer words', 'sent');
      await system('Fixture second notice');
      expect(await previews()).toEqual(['Fixture employer words', 'Fixture employer words', 'Fixture employer words']);
    });
  });

  describe('a worker who is not ready gets one deferred intent per message', () => {
    it('an onboarding worker: the message waits for the reply, and a deferred employer_chat intent names it', async () => {
      // Inside the reply window on purpose: an onboarding worker is never sent the text.
      const conversationId = await seededConversation(s, s.onboardingEn, true);
      const before = Date.now();
      const response = await send(s, conversationId, 'Fixture words for later');
      expect(response.statusCode).toBe(200);

      const [message] = await messagesOf(s, conversationId);
      expect(message).toMatchObject({ body: 'Fixture words for later', status: 'waiting_worker_reply' });
      expect(await jobOutboxOf(s, conversationId)).toEqual([]);
      expect(sent).toEqual([]);

      const intents = await intentsOf(s, s.onboardingEn.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        category: 'employer_chat',
        owner_service: 'job-messaging',
        source_type: 'job_conversation_message',
        source_id: message.id,
        dedupe_key: `employer-chat:${message.id}`,
        priority: 40,
        status: 'deferred',
        decision_reason: 'worker_onboarding',
        outbox_id: null,
      });
      expect(intents[0].payload).toEqual({ conversationId, companyName: COMPANY, jobTitle: JOB_TITLE });
      const expiresAt = new Date(intents[0].expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 60_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS + 60_000);
      expect(await workerOutboxCount(s, s.onboardingEn.id)).toBe(0);
    });

    it('a worker with no onboarding row yet is treated as onboarding', async () => {
      const conversationId = await seededConversation(s, s.noState, true);
      expect((await send(s, conversationId, 'Fixture hola')).statusCode).toBe(200);
      expect((await messagesOf(s, conversationId))[0].status).toBe('waiting_worker_reply');
      expect(await jobOutboxOf(s, conversationId)).toEqual([]);
      const intents = await intentsOf(s, s.noState.id);
      expect(intents.map((row) => [row.status, row.decision_reason])).toEqual([['deferred', 'worker_onboarding']]);
    });

    it('a new conversation with an onboarding worker claims the intent for its first message', async () => {
      const response = await create(s, s.onboardingEn, 'Fixture first words');
      expect(response.statusCode).toBe(201);
      const conversation = await conversationWith(s, s.onboardingEn.id);
      const [message] = await messagesOf(s, conversation.id);
      expect(message.status).toBe('waiting_worker_reply');
      expect(await jobOutboxOf(s, conversation.id)).toEqual([]);
      const intents = await intentsOf(s, s.onboardingEn.id);
      expect(intents.map((row) => [row.source_id, row.status])).toEqual([[message.id, 'deferred']]);
      expect(intents[0].payload).toEqual({ conversationId: conversation.id, companyName: COMPANY, jobTitle: JOB_TITLE });
    });

    it('two messages give two intents, each named by its own message', async () => {
      const conversationId = await seededConversation(s, s.onboardingEn, false);
      expect((await send(s, conversationId, 'Fixture one')).statusCode).toBe(200);
      expect((await send(s, conversationId, 'Fixture two')).statusCode).toBe(200);
      const messages = await messagesOf(s, conversationId);
      const intents = await intentsOf(s, s.onboardingEn.id);
      expect(intents.map((row) => row.source_id).sort()).toEqual(messages.map((row) => row.id).sort());
      expect(new Set(intents.map((row) => row.dedupe_key)).size).toBe(2);
    });

    it("a suspended worker's message is kept and its intent is rejected, as before", async () => {
      const conversationId = await seededConversation(s, s.suspended, false);
      expect((await send(s, conversationId, 'Fixture hola')).statusCode).toBe(200);
      expect((await messagesOf(s, conversationId))[0].status).toBe('waiting_worker_reply');
      expect(await jobOutboxOf(s, conversationId)).toEqual([]);
      const intents = await intentsOf(s, s.suspended.id);
      expect(intents.map((row) => [row.status, row.decision_reason, row.outbox_id])).toEqual([
        ['rejected', 'worker_suspended', null],
      ]);
    });
  });

  describe('the caller reaches its own applicants only', () => {
    it('cannot open a conversation with a worker who is not their applicant', async () => {
      const response = await create(s, s.stranger, 'Fixture hola');
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: 'applicant_not_found' });
      expect(await rows(s, `SELECT 1 FROM job_conversations WHERE worker_id = $1 AND employer_id = $2`,
        [s.stranger.id, s.employer.id])).toEqual([]);
      expect(await intentsOf(s, s.stranger.id)).toEqual([]);
    });

    it("the delivery context answers for the caller's applicant, with the worker's lifecycle and languages", async () => {
      const { rows: ready, error } = await asEmployer(s.employer,
        `SELECT lifecycle, workflow_language, whatsapp_language FROM jale_cap.employer_worker_delivery_context($1)`,
        [s.readyEn.id]);
      expect(error).toBeNull();
      expect(ready).toEqual([{ lifecycle: 'ready', workflow_language: 'en', whatsapp_language: 'en' }]);

      const { rows: none } = await asEmployer(s.employer,
        `SELECT lifecycle, workflow_language, whatsapp_language FROM jale_cap.employer_worker_delivery_context($1)`,
        [s.noState.id]);
      expect(none).toEqual([{ lifecycle: null, workflow_language: 'es', whatsapp_language: null }]);
    });

    it('the delivery context refuses a worker who is not the caller\'s applicant', async () => {
      const { error } = await asEmployer(s.employer,
        `SELECT * FROM jale_cap.employer_worker_delivery_context($1)`, [s.stranger.id]);
      expect(error?.code).toBe('42501');
    });

    it("the claim refuses another employer's message, and a worker other than the message's", async () => {
      const foreign = await asEmployer(s.employer,
        `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'employer_chat', $2, '{}'::jsonb, NULL)`,
        [s.stranger.id, s.strangerMessageId]);
      expect(foreign.error?.code).toBe('42501');

      const conversationId = await seededConversation(s, s.onboardingEn, false);
      const ownMessage = await s.world.message(conversationId, 'Fixture own message', 'waiting_worker_reply');
      const mismatched = await asEmployer(s.employer,
        `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'employer_chat', $2, '{}'::jsonb, NULL)`,
        [s.readyEn.id, ownMessage]);
      expect(mismatched.error?.code).toBe('42501');

      expect(await intentsOf(s, s.stranger.id)).toEqual([]);
      expect(await intentsOf(s, s.readyEn.id)).toEqual([]);
    });
  });
});
