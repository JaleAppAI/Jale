/**
 * r-paths-worker-naming.integration.test.ts -- Phase 4 end to end: a worker
 * sees the right person at the company before and after a job is
 * reassigned or its foreman removed, through the real handlers, with no new
 * Twilio template (spec: "What workers see", "Reassignment and removal").
 *
 * TEAM_MANAGEMENT_ENABLED is 'true'. The employer and worker API handlers
 * run on jale_api (getDbPool is mocked to a checked pool on that login, with
 * the team dispatcher's session timeouts); the worker's WhatsApp reply runs
 * on jale_whatsapp through the worker lane's own function, followed by the
 * worker flush the processor runs. Twilio is a recorder (template,
 * variables, body); applyMemberAccess (Cognito) is a recorder. No AWS is
 * reached.
 *
 * One company (owner Olga, "Olga" at "Acme", on Pro) lives through the
 * story, in order:
 *   1. foreman Fer ("Fer Gómez", profile phone 15550100000) holds job J, on
 *      which worker W is hired with the hire contact Fer Gómez / +1 555 010
 *      0000. Fer writes to W outside the reply window: the invite's {{1}} is
 *      "Fer Gómez (Acme)". W replies, which opens the window. Fer hires a
 *      second applicant: the hired notice names "Fer Gómez (Acme)".
 *   2. W's job detail names Fer; a worker who never applied gets null.
 *   3. Olga reassigns J to herself: the employer thread gets the move notice
 *      (never the preview), W's hire contact stays Fer's (a reassign never
 *      re-points), and nothing is queued for W.
 *   4. Olga writes inside the window: the header names Olga.
 *   5. W's job detail now names Olga; Olga hires a third applicant of J: the
 *      hired notice names "Olga (Acme)".
 *   6. Fer posts K and writes to W, who does not reply; Olga removes Fer,
 *      reassigning to herself. J's hire contact is untouched (J was no longer
 *      Fer's). W's reply on K flushes Fer's waiting message with Fer's label
 *      (Review Focus 5); Olga's next message carries hers.
 *   7. In a fresh company: a removal while the foreman still holds the job
 *      re-points the hire contact to the new holder, with no phone.
 *   Label variants, each in a fresh company: an owner whose company is the
 *   'Empleador' placeholder is named by contact alone; a foreman with no
 *   contact is named by the company alone (and an applicant sees no contact
 *   line); an owner writing on a foreman's job is named as the sender.
 *   8. The templates the story queued and sent are exactly the expected
 *      existing keys of TwilioSecret['templates'] (lambda/whatsapp/lib/twilio.ts).
 *
 * The story cases share state and must run in order, as jest runs them.
 * Every assertion on stored state reads through the superuser. Rows the
 * handlers create (posted jobs, conversations, outbox rows, intents) are
 * removed in afterAll.
 *
 * Run:
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *     --container <name> --port <port> -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/r-paths-worker-naming.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { createCheckedPool, setInternalUserRlsContext } from '../../../lambda/lib/db';
import { TEAM_DISPATCHER_DB_TIMEOUTS } from '../../../lib/stacks/billing-stack';
import { auditCallerFor } from '../../../lambda/lib/audit/caller';
import { setAuditContext } from '../../../lambda/lib/audit/context';
import { recordWorkerConversationReply, sendPendingJobMessageOutbox } from '../../../lambda/lib/job-messaging';
import {
  apiEvent, FIXTURE_TOS_VERSION, parseResponse, World,
  type ApiEventInput, type ParsedResponse, type UserFixture,
} from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const FRONTEND_BASE_URL = 'https://fixture.invalid';
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
process.env.TEAM_MANAGEMENT_ENABLED = 'true';
process.env.PUBLIC_SITE_BASE_URL = 'https://app.fixture.test';
process.env.FRONTEND_BASE_URL = FRONTEND_BASE_URL;
delete process.env.DLQ_URL;
jest.setTimeout(60_000);

// ── Twilio: a recorder ───────────────────────────────────────────────
// mockSent is cleared before every test; mockSentTemplates keeps every
// template key the suite sent, for step 8.
type Sent = { to: string; template: string | null; variables: Record<string, string> | null; body: string | null };
const mockSent: Sent[] = [];
const mockSentTemplates = new Set<string>();
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: {
      content_template: string | null; content_variables: Record<string, string> | null; body: string | null;
    }) => {
      mockSent.push({ to, template: row.content_template, variables: row.content_variables, body: row.body });
      if (row.content_template) mockSentTemplates.add(row.content_template);
      return `fake-sid-${randomUUID()}`;
    }),
  };
});

// ── Cognito: applyMemberAccess is a recorder ─────────────────────────
const mockAccessCalls: Array<Array<{ cognitoSub: string; enabled: boolean }>> = [];
jest.mock('../../../lambda/lib/member-access', () => ({
  ...jest.requireActual('../../../lambda/lib/member-access'),
  applyMemberAccess: jest.fn(async (changes: Array<{ cognitoSub: string; enabled: boolean }>) => {
    mockAccessCalls.push(changes.map((c) => ({ ...c })));
    return { converged: changes.length, failed: [] };
  }),
}));

// ── The database: jale_api for every API handler ─────────────────────
let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockPool) throw new Error('r-paths-worker-naming: no pool is open');
      return mockPool;
    },
  };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { handler: team } = require('../../../lambda/api/employer-team');
const { handler: createJob } = require('../../../lambda/api/employer-jobs-create');
const { handler: convCreate } = require('../../../lambda/api/employer-conversations-create');
const { handler: convSend } = require('../../../lambda/api/employer-conversations-send');
const { handler: convDetail } = require('../../../lambda/api/employer-conversations-detail');
const { handler: convList } = require('../../../lambda/api/employer-conversations-list');
const { handler: inbox } = require('../../../lambda/api/employer-inbox');
const { handler: statusUpdate } = require('../../../lambda/api/employer-application-status-update');
const { handler: workerJobDetail } = require('../../../lambda/api/worker-jobs-detail');
/* eslint-enable @typescript-eslint/no-var-requires */

if (!databaseUrl) {
  test('CONCERN: the worker-naming end-to-end DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;

const TEAM_TIMEOUTS = {
  statement_timeout: Number(TEAM_DISPATCHER_DB_TIMEOUTS.DB_STATEMENT_TIMEOUT_MS),
  lock_timeout: Number(TEAM_DISPATCHER_DB_TIMEOUTS.DB_LOCK_TIMEOUT_MS),
} as const;

const COMPANY = 'Acme';
const J_TITLE = 'Fixture Roofer';
const K_TITLE = 'Fixture Framer';
const FER_PROFILE_PHONE = '15550100000';
const FER_HIRE_PHONE = '+1 555 010 0000';
/** A hire-details date well before the run, so a re-point's stamp is visibly newer. */
const OLD_STAMP = new Date(Date.now() - 30 * 864e5);
const NOTICE_TO_OLGA = 'Conversación transferida a Olga / Conversation moved to Olga';
/** The templates the whole story queues and sends: the real pin of "no new template". */
const EXPECTED_QUEUED_TEMPLATES = ['application_hired_en', 'employer_message_invite_en'];
const EXPECTED_SENT_TEMPLATES = ['employer_message_invite_en'];

/**
 * The template keys TwilioSecret['templates'] declares (twilio.ts), read from
 * the source, since a type has no runtime shape. This is only a sanity
 * check that each key the story used is a declared one; the real pin is the
 * exact EXPECTED_* sets in step 8, so a new template anywhere on these paths
 * fails there even if someone also declares it in twilio.ts.
 */
function existingTemplateKeys(): Set<string> {
  const source = readFileSync(join(__dirname, '../../../lambda/whatsapp/lib/twilio.ts'), 'utf8');
  const start = source.indexOf('templates?: {');
  const end = source.indexOf('\n  };', start);
  if (start < 0 || end < 0) throw new Error('r-paths-worker-naming: TwilioSecret.templates not found in twilio.ts');
  const keys = [...source.slice(start, end).matchAll(/^\s+([a-z0-9_]+)\?: string;/gm)].map((m) => m[1]);
  if (keys.length === 0) throw new Error('r-paths-worker-naming: no template keys parsed from twilio.ts');
  return new Set(keys);
}

type Handler = (event: unknown) => Promise<{ statusCode: number; body?: string }>;
type Worker = UserFixture & { phone: string | null };

async function call(handler: Handler, user: UserFixture, input: Omit<ApiEventInput, 'sub'>): Promise<ParsedResponse> {
  return parseResponse(await handler(apiEvent({ sub: user.sub, ...input })));
}

describeInProfiles([...ALL_PROFILES], 'worker-facing naming before and after a move, through the handlers', () => {
  let world: World;
  let apiPool: Pool;
  let whatsappPool: Pool;

  let olga: UserFixture;
  let fer: UserFixture;
  let w: Worker;
  let stranger: Worker;
  let jobJ: string;
  let applicationJ: string;
  let convJ: string;
  let jobK: string;
  let convK: string;
  let originalDeferredDelivery: boolean | null = null;

  beforeAll(async () => {
    apiPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 2, ...TEAM_TIMEOUTS }, 'jale_api', 'test');
    whatsappPool = await createCheckedPool({ connectionString: loginUrl('jale_whatsapp'), max: 1 }, 'jale_whatsapp', 'test');
    mockPool = apiPool;
    world = new World(databaseUrl!);
    await world.connect();
    // A ready worker's application notice is queued only while deferred
    // delivery is on (r-paths-stage-notify does the same); put back
    // whatever the bed had in afterAll.
    const control = await world.su.query<{ enabled: boolean }>(
      `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`);
    originalDeferredDelivery = control.rows[0]?.enabled ?? null;
    await world.su.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`);
  });

  afterAll(async () => {
    try {
      if (world && originalDeferredDelivery !== null) {
        await world.su.query(
          `UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`,
          [originalDeferredDelivery]);
      }
      if (world) {
        // What the handlers wrote for the suite's users, before the World
        // removes the companies (their members first) and then the users.
        const users = [...world.users];
        await world.su.query(
          `DELETE FROM job_message_outbox WHERE conversation_id IN (
              SELECT id FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[]))`, [users]);
        await world.su.query(`DELETE FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[])`, [users]);
        await world.su.query(
          `DELETE FROM whatsapp_outbox WHERE source_type = 'worker_intent'
              AND source_id IN (SELECT id FROM worker_message_intents WHERE user_id = ANY($1::uuid[]))`, [users]);
        await world.su.query(`DELETE FROM worker_message_intents WHERE user_id = ANY($1::uuid[])`, [users]);
        await world.su.query(`DELETE FROM job_visibility_events WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = ANY($1::uuid[]))`, [users]);
        await world.su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [users]);
        await world.su.query(`DELETE FROM worker_thread_counters WHERE worker_id = ANY($1::uuid[])`, [users]);
        await world.cleanup();
      }
    } finally {
      await world?.end();
      for (const pool of [apiPool, whatsappPool]) await pool?.end();
      mockPool = undefined;
    }
  });

  beforeEach(() => {
    mockPool = apiPool;
    mockSent.length = 0;
    mockAccessCalls.length = 0;
  });

  // ── helpers ─────────────────────────────────────────────────────────

  /** An owner ("Olga" at Acme unless given, on Pro). */
  async function owner(opts: { companyName?: string; contactName?: string } = {}): Promise<UserFixture> {
    const o = await world.employer({
      companyName: opts.companyName ?? COMPANY, contactName: opts.contactName ?? 'Olga', fullName: 'Fixture Owner',
    });
    const orgId = (await world.su.query<{ organization_id: string }>(
      `SELECT organization_id FROM organization_members WHERE user_id = $1`, [o.id])).rows[0].organization_id;
    await world.su.query(
      `INSERT INTO subscriptions (user_id, organization_id, plan_code, status) VALUES ($1, $2, 'employer_pro', 'active')`,
      [o.id, orgId],
    );
    return o;
  }

  /** Olga at Acme, on Pro, and her foreman "Fer Gómez" (profile phone 15550100000). */
  async function company(): Promise<{ owner: UserFixture; foreman: UserFixture }> {
    const o = await owner();
    const foreman = await world.foreman(o.id, { contactName: 'Fer Gómez', fullName: 'Fixture Fer' });
    await world.su.query(`UPDATE employer_profiles SET phone = $2 WHERE user_id = $1`, [foreman.id, FER_PROFILE_PHONE]);
    return { owner: o, foreman };
  }

  async function readyWorker(): Promise<Worker> {
    return world.worker({ lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' });
  }

  /** A hired application on jobId whose hire contact names Fer, dated OLD_STAMP. */
  async function hiredWithFerContact(jobId: string, workerId: string): Promise<string> {
    const applicationId = await world.application(jobId, workerId, 'hired');
    await world.su.query(
      `UPDATE job_applications SET hire_contact_name = 'Fer Gómez', hire_contact_phone = $2, hire_details_updated_at = $3
        WHERE id = $1`, [applicationId, FER_HIRE_PHONE, OLD_STAMP]);
    return applicationId;
  }

  async function hireContact(applicationId: string) {
    return (await world.su.query<{ hire_contact_name: string | null; hire_contact_phone: string | null; stamp: Date | null }>(
      `SELECT hire_contact_name, hire_contact_phone, hire_details_updated_at AS stamp FROM job_applications WHERE id = $1`,
      [applicationId])).rows[0];
  }

  async function teamPost(user: UserFixture, action: string, body: unknown): Promise<ParsedResponse> {
    return call(team, user, { httpMethod: 'POST', resource: '/employer/team/{action}', pathParameters: { action }, body });
  }

  async function startConversation(employer: UserFixture, jobId: string, workerId: string, message: string): Promise<string> {
    const res = await call(convCreate, employer, {
      httpMethod: 'POST', resource: '/employer/conversations',
      body: { job_id: jobId, worker_id: workerId, initial_message: message },
    });
    expect(res.statusCode).toBe(201);
    return res.body.conversation.id;
  }

  async function sendAs(employer: UserFixture, conversationId: string, body: string): Promise<void> {
    const res = await call(convSend, employer, {
      httpMethod: 'POST', resource: '/employer/conversations/{conversationId}/messages',
      pathParameters: { conversationId }, body: { body },
    });
    expect(res.statusCode).toBe(200);
  }

  /**
   * The worker answers on WhatsApp, as the processor does: jale_whatsapp,
   * the worker as the caller, in one transaction; then, after COMMIT, the
   * worker flush of the conversation's outbox.
   */
  async function workerReplies(worker: Worker, conversationId: string, body: string): Promise<void> {
    const client = await whatsappPool.connect();
    try {
      await client.query('BEGIN');
      await setInternalUserRlsContext(client, worker.id);
      await setAuditContext(client, auditCallerFor(`fixture-${randomUUID()}`, { kind: 'worker', id: worker.id }, 'whatsapp'), 'whatsapp.inbound');
      const routed = await recordWorkerConversationReply(
        client as PoolClient, worker.id, body, `whatsapp:${worker.phone}`,
        `SMfixture${randomUUID().replace(/-/g, '')}`, conversationId,
      );
      await client.query('COMMIT');
      expect(routed).toEqual({ status: 'routed', conversationId });
      await sendPendingJobMessageOutbox(client as PoolClient, { conversationId, actorUserId: worker.id, actorKind: 'worker' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** PATCH the applicant to hired through the real handler; returns the notice's label and template. */
  async function hireThroughHandler(employer: UserFixture, jobId: string, worker: Worker): Promise<{
    companyName: string; template: string; variable2: string;
  }> {
    const res = await call(statusUpdate, employer, {
      httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}/applicants/{workerId}',
      pathParameters: { jobId, workerId: worker.id }, body: { status: 'hired' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'hired', notified: true });
    const { rows } = await world.su.query<{ payload: { companyName: string }; content_template: string; content_variables: Record<string, string> }>(
      `SELECT i.payload, o.content_template, o.content_variables
         FROM worker_message_intents i JOIN whatsapp_outbox o ON o.id = i.outbox_id
        WHERE i.source_id = $1 AND i.source_type = 'application_stage'`, [res.body.application_id]);
    expect(rows).toHaveLength(1);
    return { companyName: rows[0].payload.companyName, template: rows[0].content_template, variable2: rows[0].content_variables['2'] };
  }

  async function workerSeesContact(worker: UserFixture, jobId: string): Promise<unknown> {
    const res = await call(workerJobDetail, worker, { resource: '/worker/jobs/{jobId}', pathParameters: { jobId } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('contact_name');
    return res.body.contact_name;
  }

  async function outboxOf(conversationId: string) {
    return (await world.su.query<{
      send_kind: string; content_template: string | null; content_variables: Record<string, string> | null; body: string | null;
    }>(
      `SELECT send_kind, content_template, content_variables, body FROM job_message_outbox
        WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId])).rows;
  }

  async function messagesOf(conversationId: string) {
    return (await world.su.query<{ sender_type: string; direction: string; body: string; status: string; sender_user_id: string | null }>(
      `SELECT sender_type, direction, body, status, sender_user_id FROM job_conversation_messages
        WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId])).rows;
  }

  /**
   * What could reach the worker: job-message outbox rows, intents, and
   * whatsapp_outbox rows -- through an intent, or plain rows to the worker's
   * number.
   */
  async function queuedFor(worker: Worker): Promise<{ jobOutbox: number; intents: number; workerOutbox: number }> {
    const { rows } = await world.su.query<{ job_outbox: number; intents: number; worker_outbox: number }>(
      `SELECT (SELECT count(*)::int FROM job_message_outbox o JOIN job_conversations jc ON jc.id = o.conversation_id
                WHERE jc.worker_id = $1) AS job_outbox,
              (SELECT count(*)::int FROM worker_message_intents WHERE user_id = $1) AS intents,
              (SELECT count(*)::int FROM whatsapp_outbox o
                WHERE o.whatsapp_number::text IN ($2::text, 'whatsapp:' || $2::text)
                   OR o.id IN (SELECT i.outbox_id FROM worker_message_intents i WHERE i.user_id = $1)) AS worker_outbox`,
      [worker.id, worker.phone]);
    return { jobOutbox: rows[0].job_outbox, intents: rows[0].intents, workerOutbox: rows[0].worker_outbox };
  }

  /** The employer's three previews of one conversation: inbox, list, detail. */
  async function previews(employer: UserFixture, conversationId: string): Promise<unknown[]> {
    const fromInbox = await call(inbox, employer, { resource: '/employer/inbox' });
    const fromList = await call(convList, employer, { resource: '/employer/conversations' });
    const fromDetail = await call(convDetail, employer, {
      resource: '/employer/conversations/{conversationId}', pathParameters: { conversationId },
    });
    expect([fromInbox.statusCode, fromList.statusCode, fromDetail.statusCode]).toEqual([200, 200, 200]);
    return [
      fromInbox.body.items.find((i: { conversation_id: string | null }) => i.conversation_id === conversationId)?.last_message_preview,
      fromList.body.conversations.find((c: { id: string }) => c.id === conversationId)?.last_message_preview,
      fromDetail.body.conversation.last_message_preview,
    ];
  }

  const header = (label: string, title: string, body: string) =>
    new RegExp(`^🏢 ${label.replace(/[()]/g, '\\$&')} — ${title}( \\(#\\d+\\))?\\n${body}$`);

  // ── the story ───────────────────────────────────────────────────────

  it('1. Fer writes to W outside the reply window: the template\'s {{1}} is "Fer Gómez (Acme)"; Fer\'s hire notice names him', async () => {
    ({ owner: olga, foreman: fer } = await company());
    w = await readyWorker();
    stranger = await readyWorker();
    // Four wanted, so three hires leave J active (and readable by a non-applicant).
    jobJ = (await world.job(fer.id, { title: J_TITLE, numberOfWorkersNeeded: 4 })).id;
    applicationJ = await hiredWithFerContact(jobJ, w.id);

    convJ = await startConversation(fer, jobJ, w.id, 'Fixture from Fer');
    const [invite] = await outboxOf(convJ);
    expect(invite).toMatchObject({ send_kind: 'template', content_template: 'employer_message_invite_en' });
    expect(invite.content_variables).toMatchObject({
      '1': `Fer Gómez (${COMPANY})`,
      '2': J_TITLE,
      __fallback_body: `Fer Gómez (${COMPANY}) sent you a message about ${J_TITLE}. Reply here to open the conversation.`,
    });
    expect(mockSent).toEqual([{
      to: `whatsapp:${w.phone}`, template: 'employer_message_invite_en', variables: invite.content_variables, body: null,
    }]);

    // W answers: the window opens and Fer's waiting message goes out headed with Fer's label.
    await workerReplies(w, convJ, 'Fixture W hello');
    const freeform = (await outboxOf(convJ)).filter((r) => r.send_kind === 'freeform');
    expect(freeform.map((r) => r.body)).toEqual([expect.stringMatching(header(`Fer Gómez (${COMPANY})`, J_TITLE, 'Fixture from Fer'))]);
    expect(mockSent.map((s) => s.body)).toEqual([null, freeform[0].body]);

    // Fer hires another applicant of J (before any move): the notice names Fer.
    const h1 = await readyWorker();
    await world.application(jobJ, h1.id, 'talking');
    expect(await hireThroughHandler(fer, jobJ, h1)).toEqual({
      companyName: `Fer Gómez (${COMPANY})`, template: 'application_hired_en', variable2: `Fer Gómez (${COMPANY})`,
    });
  });

  it('2. W\'s job detail names Fer; a worker who never applied gets null', async () => {
    expect(await workerSeesContact(w, jobJ)).toBe('Fer Gómez');
    expect(await workerSeesContact(stranger, jobJ)).toBeNull();
  });

  it('3. Olga reassigns J to herself: the thread notice, never the preview; the hire contact stays; nothing is queued for W', async () => {
    const before = await queuedFor(w);
    const moved = await teamPost(olga, 'reassign', { jobId: jobJ, userId: olga.id });
    expect(moved).toEqual({ statusCode: 200, body: { jobId: jobJ, assigneeUserId: olga.id, changed: true } });

    // The employer thread: the notice, a system row with no sender, after W's reply.
    const detail = await call(convDetail, olga, {
      resource: '/employer/conversations/{conversationId}', pathParameters: { conversationId: convJ },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body.messages.at(-1)).toEqual(expect.objectContaining({
      sender_type: 'system', direction: 'outbound', body: NOTICE_TO_OLGA,
    }));
    expect((await messagesOf(convJ)).filter((m) => m.sender_type === 'system'))
      .toEqual([{ sender_type: 'system', direction: 'outbound', body: NOTICE_TO_OLGA, status: 'sent', sender_user_id: null }]);
    // The preview is the last real message (W's reply), not the notice.
    expect(await previews(olga, convJ)).toEqual(['Fixture W hello', 'Fixture W hello', 'Fixture W hello']);

    // A reassign never re-points a hire contact.
    expect(await hireContact(applicationJ)).toEqual({
      hire_contact_name: 'Fer Gómez', hire_contact_phone: FER_HIRE_PHONE, stamp: OLD_STAMP,
    });
    // The move queued nothing for W (and sent nothing).
    expect(await queuedFor(w)).toEqual(before);
    expect(mockSent).toEqual([]);
  });

  it('4. Olga writes inside the window: the header is "🏢 Olga (Acme) — "', async () => {
    await sendAs(olga, convJ, 'Fixture from Olga');
    const last = (await outboxOf(convJ)).at(-1)!;
    expect(last.send_kind).toBe('freeform');
    expect(last.body).toMatch(header(`Olga (${COMPANY})`, J_TITLE, 'Fixture from Olga'));
    expect(last.body!.startsWith(`🏢 Olga (${COMPANY}) — `)).toBe(true);
    expect(mockSent.map((s) => s.body)).toEqual([last.body]);
  });

  it('5. W\'s job detail now names Olga; Olga\'s hire on J names her', async () => {
    expect(await workerSeesContact(w, jobJ)).toBe('Olga');
    expect(await workerSeesContact(stranger, jobJ)).toBeNull();

    const h2 = await readyWorker();
    await world.application(jobJ, h2.id, 'talking');
    expect(await hireThroughHandler(olga, jobJ, h2)).toEqual({
      companyName: `Olga (${COMPANY})`, template: 'application_hired_en', variable2: `Olga (${COMPANY})`,
    });
  });

  it('6. Fer writes on K, unanswered; Olga removes Fer: J\'s hire contact stays, Fer\'s waiting message keeps Fer\'s label, Olga\'s next names Olga', async () => {
    const posted = await call(createJob, fer, {
      httpMethod: 'POST', resource: '/employer/jobs',
      body: { title: K_TITLE, location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' },
    });
    expect(posted.statusCode).toBe(201);
    jobK = posted.body.id;
    world.track('job', jobK);
    await world.application(jobK, w.id);

    convK = await startConversation(fer, jobK, w.id, 'Fixture Fer about K');
    expect((await messagesOf(convK)).map((m) => [m.body, m.status])).toEqual([['Fixture Fer about K', 'waiting_worker_reply']]);
    const [inviteK] = await outboxOf(convK);
    expect(inviteK).toMatchObject({ send_kind: 'template', content_template: 'employer_message_invite_en' });
    expect(inviteK.content_variables!['1']).toBe(`Fer Gómez (${COMPANY})`);

    const before = await queuedFor(w);
    mockSent.length = 0;
    const removed = await teamPost(olga, 'remove', { userId: fer.id, reassignTo: olga.id });
    expect(removed).toEqual({ statusCode: 200, body: { removed: true, movedJobs: 1, accessUpdated: true } });
    expect(mockAccessCalls).toEqual([[{ cognitoSub: fer.sub, enabled: false }]]);
    expect((await world.su.query(`SELECT employer_id FROM jobs WHERE id = $1`, [jobK])).rows[0].employer_id).toBe(olga.id);
    expect((await messagesOf(convK)).filter((m) => m.sender_type === 'system').map((m) => m.body)).toEqual([NOTICE_TO_OLGA]);
    // J was no longer Fer's: its hire contact is not re-pointed.
    expect(await hireContact(applicationJ)).toEqual({
      hire_contact_name: 'Fer Gómez', hire_contact_phone: FER_HIRE_PHONE, stamp: OLD_STAMP,
    });
    // J's thread got no second notice.
    expect((await messagesOf(convJ)).filter((m) => m.sender_type === 'system').map((m) => m.body)).toEqual([NOTICE_TO_OLGA]);
    expect(await queuedFor(w)).toEqual(before);
    expect(mockSent).toEqual([]);

    // W replies on K: Fer's waiting message goes out under Fer's label (Review Focus 5).
    await workerReplies(w, convK, 'Fixture W on K');
    const flushed = (await outboxOf(convK)).filter((r) => r.send_kind === 'freeform');
    expect(flushed.map((r) => r.body)).toEqual([expect.stringMatching(header(`Fer Gómez (${COMPANY})`, K_TITLE, 'Fixture Fer about K'))]);

    // Olga's next message on K names Olga.
    await sendAs(olga, convK, 'Fixture Olga on K');
    expect((await outboxOf(convK)).filter((r) => r.send_kind === 'freeform').map((r) => r.body)).toEqual([
      expect.stringMatching(header(`Fer Gómez (${COMPANY})`, K_TITLE, 'Fixture Fer about K')),
      expect.stringMatching(header(`Olga (${COMPANY})`, K_TITLE, 'Fixture Olga on K')),
    ]);
    expect(await workerSeesContact(w, jobK)).toBe('Olga');
  });

  it('7. (a fresh company) a removal while the foreman still holds the job re-points the hire contact to the new holder, no phone', async () => {
    const { owner: o2, foreman: f2 } = await company();
    const w2 = await readyWorker();
    const other = await readyWorker();
    const job2 = (await world.job(f2.id, { title: J_TITLE, numberOfWorkersNeeded: 3 })).id;
    const hired = await hiredWithFerContact(job2, w2.id);
    // A hire whose contact names someone else stays as it is.
    const otherHire = await world.application(job2, other.id, 'hired');
    await world.su.query(
      `UPDATE job_applications SET hire_contact_name = 'Site boss', hire_contact_phone = '+1 555 010 9999',
              hire_details_updated_at = $2 WHERE id = $1`, [otherHire, OLD_STAMP]);
    expect(await workerSeesContact(w2, job2)).toBe('Fer Gómez');

    const removed = await teamPost(o2, 'remove', { userId: f2.id, reassignTo: o2.id });
    expect(removed).toEqual({ statusCode: 200, body: { removed: true, movedJobs: 1, accessUpdated: true } });

    const repointed = await hireContact(hired);
    expect(repointed).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null, stamp: expect.any(Date) });
    expect(repointed.stamp!.getTime()).toBeGreaterThan(OLD_STAMP.getTime());
    expect(await hireContact(otherHire)).toEqual({
      hire_contact_name: 'Site boss', hire_contact_phone: '+1 555 010 9999', stamp: OLD_STAMP,
    });
    expect(await workerSeesContact(w2, job2)).toBe('Olga');
    expect(mockSent).toEqual([]);
  });

  it('label variant: an owner whose company is the "Empleador" placeholder is named by contact alone ("Juan")', async () => {
    const juan = await owner({ companyName: 'Empleador', contactName: 'Juan' });
    const job = (await world.job(juan.id, { title: J_TITLE })).id;
    const applicant = await readyWorker();
    await world.application(job, applicant.id);
    const conversation = await startConversation(juan, job, applicant.id, 'Fixture from Juan');
    const [invite] = await outboxOf(conversation);
    expect(invite.content_template).toBe('employer_message_invite_en');
    expect(invite.content_variables!['1']).toBe('Juan');
    expect(invite.content_variables!.__fallback_body).toBe(`Juan sent you a message about ${J_TITLE}. Reply here to open the conversation.`);
  });

  it('label variant: a foreman with no contact is named by the company alone; an applicant sees no contact line', async () => {
    const o = await owner();
    const nameless = await world.foreman(o.id, { fullName: 'Fixture Nameless Foreman' });
    const job = (await world.job(nameless.id, { title: J_TITLE })).id;
    const applicant = await readyWorker();
    await world.application(job, applicant.id);
    const conversation = await startConversation(nameless, job, applicant.id, 'Fixture from a nameless foreman');
    const [invite] = await outboxOf(conversation);
    expect(invite.content_template).toBe('employer_message_invite_en');
    expect(invite.content_variables!['1']).toBe(COMPANY);
    expect(await workerSeesContact(applicant, job)).toBeNull();
  });

  it('label variant: the owner writing on a foreman\'s job outside the window is named as the sender ("Olga (Acme)")', async () => {
    const { owner: o, foreman: f } = await company();
    const job = (await world.job(f.id, { title: J_TITLE })).id;
    const applicant = await readyWorker();
    await world.application(job, applicant.id);
    const conversation = await startConversation(o, job, applicant.id, 'Fixture from the owner');
    expect((await world.su.query(`SELECT employer_id FROM job_conversations WHERE id = $1`, [conversation])).rows[0].employer_id).toBe(f.id);
    const [invite] = await outboxOf(conversation);
    expect(invite.content_template).toBe('employer_message_invite_en');
    expect(invite.content_variables!['1']).toBe(`Olga (${COMPANY})`);
    // The job's responsible person is still the foreman: the applicant's contact line names him.
    expect(await workerSeesContact(applicant, job)).toBe('Fer Gómez');
  });

  it('8. the story queued and sent exactly the expected templates, each an existing TwilioSecret template key', async () => {
    const users = [...world.users];
    const queued = (await world.su.query<{ content_template: string }>(
      `SELECT o.content_template FROM job_message_outbox o JOIN job_conversations jc ON jc.id = o.conversation_id
        WHERE jc.worker_id = ANY($1::uuid[]) AND o.content_template IS NOT NULL
       UNION
       SELECT o.content_template FROM whatsapp_outbox o JOIN worker_message_intents i ON i.outbox_id = o.id
        WHERE i.user_id = ANY($1::uuid[]) AND o.content_template IS NOT NULL
       ORDER BY 1`, [users])).rows.map((r) => r.content_template);
    expect(queued).toEqual(EXPECTED_QUEUED_TEMPLATES);
    expect([...mockSentTemplates].sort()).toEqual(EXPECTED_SENT_TEMPLATES);
    const keys = existingTemplateKeys();
    for (const template of [...queued, ...mockSentTemplates]) expect(keys.has(template)).toBe(true);
  });
});
