/**
 * PostgreSQL-backed verification for migration 121 (WhatsApp support mode).
 *
 * Set JALE_TEST_DATABASE_URL to a disposable Postgres 16 bed with the whole
 * migration chain applied (infra/db/local/bootstrap-testbed.sh). Fixtures go
 * in through the bed's superuser URL; every function under test is called
 * over a real authenticated connection as the login that calls it when
 * deployed (`jale_whatsapp`), so grants and row policies are the deployed
 * ones.
 *
 * The admin email fan-out runs inside a definer owned by the migration login.
 * The suite asserts the queued rows themselves, one per active admin, so a
 * definer that reads no admin rows fails here instead of queueing nothing.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { auditCallerFor } from '../../../lambda/lib/audit/caller';
import { _clearOutboxTwilioSecretCacheForTests, sendPendingAdminOutbox } from '../../../lambda/whatsapp/lib/outbox';
import { withLoginClient } from './helpers/login-pool';

// The admin dispatcher reads its provider credential from Secrets Manager;
// this stand-in hands out one generated per run, with no template mapped
// unless a test maps one.
const mockTwilioSecret: {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  templates: Record<string, string>;
} = {
  accountSid: `AC${randomBytes(16).toString('hex')}`,
  authToken: randomBytes(16).toString('hex'),
  messagingServiceSid: `MG${randomBytes(16).toString('hex')}`,
  templates: {},
};
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn(async () => ({ SecretString: JSON.stringify(mockTwilioSecret) })),
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: migration 121 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[support-mode-121] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL '
        + 'to run the support-mode function and privilege checks against Postgres 16.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

const BASE_URL = 'https://admin.example.test';
// Fictional 555-01xx numbers; nothing here reaches a real phone.
const PHONE_UNBOUND = '+15550101191';
const PHONE_BOUND = '+15550101192';
const PHONE_OTHER = '+15550101193';
const PHONE_SPARE = '+15550101194';
const PHONE_NO_URL = '+15550101195';
const PHONE_DISPATCH = '+15550101196';
const ADMIN_EMAIL_OPS = 'support-121-ops@example.test';
const ADMIN_EMAIL_READONLY = 'support-121-readonly@example.test';
const ADMIN_EMAIL_INACTIVE = 'support-121-inactive@example.test';
const FIXTURE_SID = `SM${'1'.repeat(32)}`;

async function superuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function asWhatsapp<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withLoginClient('jale_whatsapp', async (client) => (await client.query<T>(sql, params)).rows);
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

interface CaseRow {
  id: string;
  case_type: string;
  status: string;
  priority: number;
  user_id: string | null;
  conversation_id: string | null;
  summary: string;
  details: Record<string, unknown>;
}

async function caseRow(caseId: string): Promise<CaseRow> {
  return superuser(async (c) => (await c.query<CaseRow>(
    `SELECT id, case_type, status, priority, user_id, conversation_id, summary, details
       FROM admin_cases WHERE id = $1`, [caseId])).rows[0]);
}

async function events(caseId: string): Promise<Array<{ event_type: string; actor_type: string; payload: Record<string, unknown> }>> {
  return superuser(async (c) => (await c.query(
    `SELECT event_type, actor_type, payload FROM admin_case_events
      WHERE case_id = $1 ORDER BY created_at, id`, [caseId])).rows);
}

async function eventCount(caseId: string, eventType: string): Promise<number> {
  return superuser(async (c) => Number((await c.query<{ n: string }>(
    'SELECT count(*) AS n FROM admin_case_events WHERE case_id = $1 AND event_type = $2',
    [caseId, eventType])).rows[0].n));
}

async function openCase(
  conversationId: string,
  userId: string | null,
  language: string,
  text: string,
  baseUrl: string | null = BASE_URL,
): Promise<{ case_id: string; created: boolean }> {
  const rows = await asWhatsapp<{ case_id: string; created: boolean }>(
    'SELECT case_id, created FROM support_open_case($1, $2, $3, $4, $5)',
    [conversationId, userId, language, text, baseUrl],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

maybeDescribe('migration 121 WhatsApp support mode', () => {
  let workerId: string;
  let unboundConv: string;
  let boundConv: string;
  let otherConv: string;
  let spareConv: string;
  let noUrlConv: string;
  let dispatchConv: string;
  const adminIds: Record<'ops' | 'readonly' | 'inactive', string> = { ops: '', readonly: '', inactive: '' };
  const caseIds = new Set<string>();

  beforeAll(async () => {
    await superuser(async (c) => {
      workerId = (await c.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number)
         VALUES ('w-support-121', 'worker', $1) RETURNING id`, [PHONE_BOUND])).rows[0].id;
      const conv = async (userId: string | null, phone: string) => (await c.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, conversation_state)
         VALUES ($1, $2, 'idle') RETURNING id`, [userId, phone])).rows[0].id;
      unboundConv = await conv(null, PHONE_UNBOUND);
      boundConv = await conv(workerId, PHONE_BOUND);
      otherConv = await conv(null, PHONE_OTHER);
      spareConv = await conv(null, PHONE_SPARE);
      noUrlConv = await conv(null, PHONE_NO_URL);
      dispatchConv = await conv(null, PHONE_DISPATCH);
      const admin = async (sub: string, email: string, role: string, active: boolean) => (await c.query<{ id: string }>(
        `INSERT INTO admin_users (cognito_sub, admin_email, role, active)
         VALUES ($1, $2, $3, $4) RETURNING id`, [sub, email, role, active])).rows[0].id;
      adminIds.ops = await admin('admin-121-ops', ADMIN_EMAIL_OPS, 'admin_ops', true);
      adminIds.readonly = await admin('admin-121-readonly', ADMIN_EMAIL_READONLY, 'admin_readonly', true);
      adminIds.inactive = await admin('admin-121-inactive', ADMIN_EMAIL_INACTIVE, 'admin_superadmin', false);
    });
  });

  afterAll(async () => {
    await superuser(async (c) => {
      const convs = [unboundConv, boundConv, otherConv, spareConv, noUrlConv, dispatchConv];
      const cases = (await c.query<{ id: string }>(
        'SELECT id FROM admin_cases WHERE conversation_id = ANY($1::uuid[]) OR user_id = $2',
        [convs, workerId])).rows.map((r) => r.id);
      await c.query('DELETE FROM email_outbox WHERE source_id = ANY($1::uuid[])', [cases]);
      await c.query('DELETE FROM whatsapp_outbox WHERE source_type = $1 AND source_id = ANY($2::uuid[])', ['admin_case', cases]);
      await c.query('DELETE FROM admin_cases WHERE id = ANY($1::uuid[])', [cases]);
      await c.query('DELETE FROM whatsapp_processed_messages WHERE whatsapp_number = $1', [PHONE_DISPATCH]);
      await c.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [convs]);
      await c.query('DELETE FROM users WHERE id = $1', [workerId]);
      await c.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [Object.values(adminIds)]);
    });
  });

  it('opens a case for an unregistered number and emails every active admin once', async () => {
    const activeAdmins = await superuser(async (c) => (await c.query<{ id: string; admin_email: string }>(
      'SELECT id, admin_email FROM admin_users WHERE active ORDER BY id')).rows);
    expect(activeAdmins.length).toBeGreaterThanOrEqual(2);

    const opened = await openCase(unboundConv, null, 'en', 'Necesito ayuda con mi cuenta 121');
    expect(opened.created).toBe(true);
    caseIds.add(opened.case_id);

    const row = await caseRow(opened.case_id);
    expect(row).toMatchObject({
      case_type: 'help_request',
      status: 'open',
      priority: 70,
      user_id: null,
      conversation_id: unboundConv,
    });
    expect(row.details).toMatchObject({
      language: 'en',
      lastMessage: 'Necesito ayuda con mi cuenta 121',
      registered: false,
      source: 'whatsapp_support_mode',
    });
    expect(Number.isNaN(Date.parse(String(row.details.lastWorkerMessageAt)))).toBe(false);
    expect(row.summary).not.toContain('121');

    const timeline = await events(opened.case_id);
    expect(timeline.map((e) => e.event_type).sort()).toEqual(['admins_notified', 'case_created', 'worker_message']);
    expect(timeline.find((e) => e.event_type === 'worker_message')?.payload)
      .toMatchObject({ detail: 'Necesito ayuda con mi cuenta 121' });
    expect(timeline.find((e) => e.event_type === 'admins_notified')?.payload)
      .toMatchObject({ count: activeAdmins.length });

    // The rows themselves, one per active admin: a definer that could not
    // read the admin list would queue none and still return.
    const mail = await superuser(async (c) => (await c.query<{
      recipient_email: string; subject: string; body_text: string; body_html: string;
      source_type: string; idempotency_key: string; status: string;
    }>(
      `SELECT recipient_email, subject, body_text, body_html, source_type, idempotency_key, status
         FROM email_outbox WHERE source_id = $1 ORDER BY recipient_email`, [opened.case_id])).rows);
    expect(mail).toHaveLength(activeAdmins.length);
    const recipients = mail.map((m) => m.recipient_email);
    expect(recipients).toEqual(expect.arrayContaining([ADMIN_EMAIL_OPS, ADMIN_EMAIL_READONLY]));
    expect(recipients).not.toContain(ADMIN_EMAIL_INACTIVE);
    const link = `${BASE_URL}/inbox/support/${opened.case_id}`;
    for (const m of mail) {
      expect(m.subject).toBe('New support case in the Jale admin console');
      expect(m.body_text).toBe(`A worker asked for help on WhatsApp. Open the case: ${link}`);
      expect(m.body_html).toContain(`href="${link}"`);
      expect(m.source_type).toBe('admin_support_case');
      expect(m.status).toBe('pending');
      for (const body of [m.body_text, m.body_html]) {
        expect(body).not.toContain('Necesito');
        expect(body).not.toContain(PHONE_UNBOUND);
      }
    }
    expect(mail.map((m) => m.idempotency_key).sort()).toEqual(
      activeAdmins.map((a) => `admin-support-case:${opened.case_id}:${a.id}`).sort(),
    );
  });

  it('reuses the open case for the same conversation, records the message and sends no new email', async () => {
    const [first] = [...caseIds];
    const before = await superuser(async (c) => Number((await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM email_outbox WHERE source_id = $1', [first])).rows[0].n));

    const again = await openCase(unboundConv, null, 'es', 'Sigo sin poder entrar');
    expect(again).toEqual({ case_id: first, created: false });

    const after = await superuser(async (c) => Number((await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM email_outbox WHERE source_id = $1', [first])).rows[0].n));
    expect(after).toBe(before);
    expect(await eventCount(first, 'worker_message')).toBe(2);
    expect(await eventCount(first, 'admins_notified')).toBe(1);
    expect((await caseRow(first)).details).toMatchObject({ lastMessage: 'Sigo sin poder entrar', language: 'es' });
  });

  it('moves a case waiting on the worker back to waiting on the team when the worker writes again', async () => {
    const [first] = [...caseIds];
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'pending_worker' WHERE id = $1`, [first]));

    await openCase(unboundConv, null, 'es', 'Soporte');
    expect((await caseRow(first)).status).toBe('pending_admin');
    expect(await eventCount(first, 'status_changed')).toBeGreaterThanOrEqual(2);

    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'pending_worker' WHERE id = $1`, [first]));
    const [appended] = await asWhatsapp<{ appended: boolean; status_changed: boolean; media_id: string | null }>(
      'SELECT appended, status_changed, media_id FROM support_append_message($1, $2, $3, $4, $5, $6)',
      [first, unboundConv, 'text', 'Ya mande la foto', null, 'es'],
    );
    expect(appended).toEqual({ appended: true, status_changed: true, media_id: null });
    expect((await caseRow(first)).status).toBe('pending_admin');
  });

  it('carries a registered worker on the case and refuses a worker the conversation does not name', async () => {
    const opened = await openCase(boundConv, workerId, 'es', 'Soporte');
    caseIds.add(opened.case_id);
    const row = await caseRow(opened.case_id);
    expect(row.user_id).toBe(workerId);
    expect(row.details).toMatchObject({ registered: true, language: 'es' });

    expect(await sqlState(openCase(boundConv, null, 'es', 'Soporte'))).toBe('23503');
    expect(await sqlState(openCase(unboundConv, workerId, 'es', 'Soporte'))).toBe('23503');
    expect(await sqlState(openCase(boundConv, workerId, 'fr', 'Soporte'))).toBe('22023');
  });

  it('appends text and media, records media keys only, and leaves a closed case untouched', async () => {
    const opened = await openCase(spareConv, null, 'es', 'Soporte');
    caseIds.add(opened.case_id);
    const key = `support/${opened.case_id}/${randomUUID()}.jpg`;

    const [media] = await asWhatsapp<{ appended: boolean; status_changed: boolean; media_id: string }>(
      'SELECT appended, status_changed, media_id FROM support_append_message($1, $2, $3, $4, $5::jsonb, $6)',
      [opened.case_id, spareConv, 'media', 'mi credencial',
        JSON.stringify({ s3Key: key, mediaType: 'image', contentType: 'image/jpeg', byteSize: 2048 }), 'es'],
    );
    expect(media.appended).toBe(true);
    expect(media.media_id).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await superuser(async (c) => (await c.query<{
      case_id: string; event_id: string; s3_key: string; media_type: string; content_type: string;
      byte_size: number; retention: string;
    }>(
      `SELECT case_id, event_id, s3_key, media_type, content_type, byte_size,
              (expires_at - created_at)::text AS retention
         FROM support_case_media WHERE id = $1`, [media.media_id])).rows[0]);
    expect(stored).toMatchObject({
      case_id: opened.case_id, s3_key: key, media_type: 'image', content_type: 'image/jpeg', byte_size: 2048,
      retention: '90 days',
    });
    const mediaEvent = (await events(opened.case_id)).find((e) => e.event_type === 'worker_media');
    expect(mediaEvent?.payload).toMatchObject({ mediaId: media.media_id, mediaType: 'image', caption: 'mi credencial' });
    expect((await caseRow(opened.case_id)).details).toMatchObject({ lastMessage: 'mi credencial' });

    // A key outside this case's own prefix is refused.
    expect(await sqlState(asWhatsapp(
      'SELECT * FROM support_append_message($1, $2, $3, $4, $5::jsonb, $6)',
      [opened.case_id, spareConv, 'media', null,
        JSON.stringify({ s3Key: `support/${randomUUID()}/${randomUUID()}.jpg`, mediaType: 'image', contentType: 'image/jpeg', byteSize: 10 }), 'es'],
    ))).toBe('22023');
    // A case of another conversation is refused.
    expect(await sqlState(asWhatsapp(
      'SELECT * FROM support_append_message($1, $2, $3, $4, $5, $6)',
      [opened.case_id, otherConv, 'text', 'hola', null, 'es'],
    ))).toBe('P0002');

    await superuser((c) => c.query(
      `UPDATE admin_cases SET status = 'resolved', resolved_at = now() WHERE id = $1`, [opened.case_id]));
    const messagesBefore = await eventCount(opened.case_id, 'worker_message');
    const [closed] = await asWhatsapp<{ appended: boolean; status_changed: boolean; media_id: string | null }>(
      'SELECT appended, status_changed, media_id FROM support_append_message($1, $2, $3, $4, $5, $6)',
      [opened.case_id, spareConv, 'text', 'hola?', null, 'es'],
    );
    expect(closed).toEqual({ appended: false, status_changed: false, media_id: null });
    expect(await eventCount(opened.case_id, 'worker_message')).toBe(messagesBefore);
    expect((await caseRow(opened.case_id)).status).toBe('resolved');
  });

  it('reports mode state and offers re-entry only within 72 hours of an admin reply and not after MENU', async () => {
    const opened = await openCase(otherConv, null, 'en', 'Support');
    caseIds.add(opened.case_id);
    const state = (caseId: string | null, conv: string) => asWhatsapp<{ open: boolean; last_admin_message_at: Date | null }>(
      'SELECT open, last_admin_message_at FROM support_mode_state($1, $2)', [caseId, conv]);
    const reentry = async () => (await asWhatsapp<{ case_id: string | null }>(
      'SELECT support_reentry_case($1) AS case_id', [otherConv]))[0].case_id;

    expect(await state(opened.case_id, otherConv)).toEqual([{ open: true, last_admin_message_at: null }]);
    expect(await state(opened.case_id, unboundConv)).toEqual([{ open: false, last_admin_message_at: null }]);
    expect(await state(null, otherConv)).toEqual([{ open: false, last_admin_message_at: null }]);
    expect(await reentry()).toBeNull();

    const sentAt = await superuser(async (c) => (await c.query<{ created_at: Date }>(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
       VALUES ($1, 'admin_reply_sent', 'system', 'twilio', '{"title":"sent"}', now() - interval '10 hours')
       RETURNING created_at`, [opened.case_id])).rows[0].created_at);
    expect(await reentry()).toBe(opened.case_id);
    const [withReply] = await state(opened.case_id, otherConv);
    expect(withReply.open).toBe(true);
    expect(new Date(withReply.last_admin_message_at as Date).getTime()).toBe(new Date(sentAt).getTime());

    await asWhatsapp('SELECT support_record_mode_change($1, $2, false, $3)', [opened.case_id, otherConv, 'menu']);
    expect(await reentry()).toBeNull();

    // A newer reply re-arms it.
    await superuser((c) => c.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
       VALUES ($1, 'admin_reply_sent', 'system', 'twilio', '{"title":"sent"}')`, [opened.case_id]));
    expect(await reentry()).toBe(opened.case_id);

    // Older than 72 hours, or a closed case: none.
    await superuser((c) => c.query(
      `UPDATE admin_case_events SET created_at = now() - interval '73 hours'
        WHERE case_id = $1 AND event_type IN ('admin_reply_sent', 'support_mode_exited')`, [opened.case_id]));
    expect(await reentry()).toBeNull();
    await superuser((c) => c.query(
      `UPDATE admin_case_events SET created_at = now() - interval '1 hour'
        WHERE case_id = $1 AND event_type = 'admin_reply_sent'`, [opened.case_id]));
    expect(await reentry()).toBe(opened.case_id);
    await superuser((c) => c.query(
      `UPDATE admin_cases SET status = 'dismissed', resolved_at = now() WHERE id = $1`, [opened.case_id]));
    expect(await reentry()).toBeNull();
    expect(await state(opened.case_id, otherConv)).toEqual([{ open: false, last_admin_message_at: expect.any(Date) }]);
  });

  it('records mode changes and admin deliveries on the timeline, the waiting notice once per message', async () => {
    const [first] = [...caseIds];
    await asWhatsapp('SELECT support_record_mode_change($1, $2, true, $3)', [first, unboundConv, 'command']);
    await asWhatsapp('SELECT support_record_mode_change($1, $2, false, $3)', [first, unboundConv, 'idle']);
    const modeEvents = (await events(first)).filter((e) => e.event_type.startsWith('support_mode_'));
    expect(modeEvents.map((e) => [e.event_type, e.payload.reason])).toEqual([
      ['support_mode_entered', 'command'],
      ['support_mode_exited', 'idle'],
    ]);
    expect(await sqlState(asWhatsapp(
      'SELECT support_record_mode_change($1, $2, false, $3)', [first, unboundConv, 'bored']))).toBe('22023');

    const outboxId = await superuser(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO whatsapp_outbox
         (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
          status, source_type, source_id, idempotency_key)
       VALUES (NULL, 0, $1, NULL, 'admin_support_reply_v2_en',
               '{"1":"We reset it","__fallback_body":"We reset it"}'::jsonb,
               'pending', 'admin_case', $2, $3)
       RETURNING id`, [PHONE_UNBOUND, first, `admin-reply:${randomUUID()}`])).rows[0].id);

    for (let i = 0; i < 2; i += 1) {
      await asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
        [outboxId, 'waiting_for_window', null, null, null]);
    }
    expect(await eventCount(first, 'admin_reply_waiting_for_window')).toBe(1);

    await asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
      [outboxId, 'sent', 'template', FIXTURE_SID, null]);
    const sent = (await events(first)).find((e) => e.event_type === 'admin_reply_sent');
    expect(sent?.payload).toMatchObject({ via: 'template', outboxId, twilioMessageSid: FIXTURE_SID });
    expect((await caseRow(first)).details).toMatchObject({ lastOutboundTwilioSid: FIXTURE_SID });

    await asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
      [outboxId, 'failed', 'freeform', null, 'Twilio send failed with HTTP 400 (code 63016)']);
    const failed = (await events(first)).find((e) => e.event_type === 'admin_reply_failed');
    expect(failed?.payload).toMatchObject({ via: 'freeform', outboxId, detail: 'Twilio send failed with HTTP 400 (code 63016)' });

    expect(await sqlState(asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
      [outboxId, 'delivered', null, null, null]))).toBe('22023');
    expect(await sqlState(asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
      [outboxId, 'sent', 'carrier-pigeon', FIXTURE_SID, null]))).toBe('22023');
    expect(await sqlState(asWhatsapp('SELECT support_record_admin_delivery($1, $2, $3, $4, $5)',
      [randomUUID(), 'sent', 'freeform', FIXTURE_SID, null]))).toBe('P0002');
  });

  it('refuses a malformed admin address and queues no email without one', async () => {
    expect(await sqlState(openCase(noUrlConv, null, 'en', 'Support', 'http://admin.example.test'))).toBe('22023');
    expect(await sqlState(openCase(noUrlConv, null, 'en', 'Support', `${BASE_URL}/`))).toBe('22023');
    const none = await superuser(async (c) => Number((await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM admin_cases WHERE conversation_id = $1', [noUrlConv])).rows[0].n));
    expect(none).toBe(0);

    const opened = await openCase(noUrlConv, null, 'en', 'Support', null);
    caseIds.add(opened.case_id);
    expect(opened.created).toBe(true);
    const mail = await superuser(async (c) => Number((await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM email_outbox WHERE source_id = $1', [opened.case_id])).rows[0].n));
    expect(mail).toBe(0);
    expect((await events(opened.case_id)).find((e) => e.event_type === 'admins_notified')?.payload)
      .toMatchObject({ count: 0 });
  });

  it('gives the WhatsApp login no direct right on cases, events, media, email or the notify function', async () => {
    const [first] = [...caseIds];
    expect(await sqlState(asWhatsapp('SELECT id FROM admin_cases LIMIT 1'))).toBe('42501');
    expect(await sqlState(asWhatsapp(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload) VALUES ($1, 'x', 'worker', '{}')`,
      [first]))).toBe('42501');
    expect(await sqlState(asWhatsapp('SELECT id FROM support_case_media LIMIT 1'))).toBe('42501');
    expect(await sqlState(asWhatsapp('SELECT id FROM admin_users LIMIT 1'))).toBe('42501');
    expect(await sqlState(asWhatsapp(
      `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id)
       VALUES ('x@example.test', 's', 'b', 'admin_support_case', $1)`, [first]))).toBe('42501');
    expect(await sqlState(asWhatsapp('SELECT support_notify_admins($1, $2)', [first, BASE_URL]))).toBe('42501');

    expect(await sqlState(withLoginClient('jale_admin_console',
      (c) => c.query('SELECT id FROM support_case_media LIMIT 1')))).toBe('42501');
    expect(await sqlState(withLoginClient('jale_admin_console',
      (c) => c.query('SELECT support_notify_admins($1, $2)', [first, BASE_URL])))).toBe('42501');
  });

  it('lets the WhatsApp login set the support columns on its own conversation row', async () => {
    const [first] = [...caseIds];
    await asWhatsapp(
      `UPDATE whatsapp_conversations
          SET support_case_id = $2, support_last_activity_at = now()
        WHERE id = $1`, [unboundConv, first]);
    const [row] = await asWhatsapp<{ support_case_id: string; idle: boolean }>(
      `SELECT support_case_id, support_last_activity_at + interval '24 hours' <= now() AS idle
         FROM whatsapp_conversations WHERE id = $1`, [unboundConv]);
    expect(row).toEqual({ support_case_id: first, idle: false });

    // Deleting the case releases the conversation.
    const throwaway = await openCase(boundConv, workerId, 'es', 'Soporte');
    await asWhatsapp('UPDATE whatsapp_conversations SET support_case_id = $2 WHERE id = $1', [boundConv, throwaway.case_id]);
    await superuser((c) => c.query('DELETE FROM email_outbox WHERE source_id = $1', [throwaway.case_id]));
    await superuser((c) => c.query('DELETE FROM admin_cases WHERE id = $1', [throwaway.case_id]));
    const [released] = await asWhatsapp<{ support_case_id: string | null }>(
      'SELECT support_case_id FROM whatsapp_conversations WHERE id = $1', [boundConv]);
    expect(released.support_case_id).toBeNull();
  });
  it('drains a reply as the window allows: waits with no attempt spent, fails after 7 days, goes freeform once the worker writes', async () => {
    const savedEnv = { ...process.env };
    process.env.TWILIO_SECRET_ARN = 'fixture-twilio-secret';
    process.env.TWILIO_STATUS_CALLBACK_URL = 'https://fixture.invalid/whatsapp/status-callback';
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '4000';
    _clearOutboxTwilioSecretCacheForTests();
    const sentSid = `SM${randomBytes(16).toString('hex')}`;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => ({
      ok: true, status: 201, json: async () => ({ sid: sentSid }),
    })) as unknown as typeof fetch);
    const caller = auditCallerFor(randomUUID(), { kind: 'platform' }, 'whatsapp');
    const drain = () => withLoginClient('jale_whatsapp', (client) => sendPendingAdminOutbox(client as never, caller));
    const sendsToWorker = () => fetchSpy.mock.calls
      .map(([, init]) => new URLSearchParams(String(init?.body)))
      .filter((form) => form.get('To') === `whatsapp:${PHONE_DISPATCH}`);

    try {
      const opened = await openCase(dispatchConv, null, 'en', 'Support');
      caseIds.add(opened.case_id);
      await superuser((c) => c.query(
        `UPDATE whatsapp_conversations
            SET support_case_id = $2, support_last_activity_at = now() - interval '2 hours'
          WHERE id = $1`, [dispatchConv, opened.case_id]));
      const insertReply = (text: string) => superuser(async (c) => (await c.query<{ id: string }>(
        `INSERT INTO whatsapp_outbox
           (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
            status, source_type, source_id, idempotency_key)
         VALUES (NULL, 0, $1, NULL, 'admin_support_reply_v2_en',
                 jsonb_build_object('1', $2::text, '__fallback_body', $2::text),
                 'pending', 'admin_case', $3, $4)
         RETURNING id`, [PHONE_DISPATCH, text, opened.case_id, `admin-reply:${randomUUID()}`])).rows[0].id);
      const outboxRow = (id: string) => superuser(async (c) => (await c.query(
        `SELECT status, attempt_count, last_error, twilio_message_sid,
                next_attempt_at BETWEEN now() + interval '55 minutes' AND now() + interval '65 minutes' AS waits_an_hour
           FROM whatsapp_outbox WHERE id = $1`, [id])).rows[0]);

      // No message from the worker in 24 hours and no template mapped: it waits.
      const waiting = await insertReply('We reset it');
      await drain();
      expect(await outboxRow(waiting)).toMatchObject({
        status: 'pending', attempt_count: 0, last_error: 'waiting_for_session_window', waits_an_hour: true,
      });
      await drain(); // not due again for an hour
      expect(await eventCount(opened.case_id, 'admin_reply_waiting_for_window')).toBe(1);
      expect(sendsToWorker()).toHaveLength(0);

      // Seven days on, still nothing: it fails for good, its attempts set to
      // the cap so ops health does not read it as still being retried.
      await superuser((c) => c.query(
        `UPDATE whatsapp_outbox SET created_at = now() - interval '8 days', next_attempt_at = NULL WHERE id = $1`,
        [waiting]));
      await drain();
      expect(await outboxRow(waiting)).toMatchObject({ status: 'failed', attempt_count: 5 });
      expect(await eventCount(opened.case_id, 'admin_reply_failed')).toBe(1);

      // A v2 template that is mapped but refused by Twilio as unusable
      // waits the same way, with the claim's attempt given back.
      mockTwilioSecret.templates = { admin_support_reply_v2_en: `HX${randomBytes(16).toString('hex')}` };
      _clearOutboxTwilioSecretCacheForTests();
      fetchSpy.mockImplementation((async () => ({
        ok: false, status: 400, json: async () => ({ code: 21655 }),
      })) as unknown as typeof fetch);
      const refused = await insertReply('Template refused');
      await drain();
      expect(await outboxRow(refused)).toMatchObject({
        status: 'pending', attempt_count: 0, last_error: 'waiting_for_session_window', waits_an_hour: true,
      });
      expect(await eventCount(opened.case_id, 'admin_reply_waiting_for_window')).toBe(2);
      mockTwilioSecret.templates = {};
      _clearOutboxTwilioSecretCacheForTests();
      fetchSpy.mockImplementation((async () => ({
        ok: true, status: 201, json: async () => ({ sid: sentSid }),
      })) as unknown as typeof fetch);

      // The worker writes: the next reply goes freeform and keeps the mode awake.
      await superuser((c) => c.query(
        `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'completed')`,
        [`SM${randomBytes(16).toString('hex')}`, PHONE_DISPATCH]));
      const sending = await insertReply('Try again now');
      await drain();
      expect(await outboxRow(sending)).toMatchObject({ status: 'sent', attempt_count: 1, twilio_message_sid: sentSid });
      // Two requests reached Twilio for this worker: the refused template,
      // then this reply.
      const sends = sendsToWorker();
      expect(sends).toHaveLength(2);
      expect(sends[0].get('ContentSid')).toMatch(/^HX[0-9a-f]{32}$/);
      expect(sends[0].get('Body')).toBeNull();
      expect(sends[1].get('Body')).toBe('Try again now');
      expect(sends[1].get('ContentSid')).toBeNull();
      const sent = (await events(opened.case_id)).find((e) => e.event_type === 'admin_reply_sent');
      expect(sent?.payload).toMatchObject({ via: 'freeform', outboxId: sending, twilioMessageSid: sentSid });
      const [conversation] = await superuser(async (c) => (await c.query<{ fresh: boolean }>(
        `SELECT support_last_activity_at > now() - interval '1 minute' AS fresh
           FROM whatsapp_conversations WHERE id = $1`, [dispatchConv])).rows);
      expect(conversation.fresh).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      process.env = savedEnv;
      _clearOutboxTwilioSecretCacheForTests();
    }
  });
});
