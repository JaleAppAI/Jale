/**
 * PostgreSQL-backed verification for migration 122 (the admin Inbox: support
 * replies, the case view, attachments, lockout detail and reset).
 *
 * Set JALE_TEST_DATABASE_URL to a disposable Postgres 16 bed with the whole
 * migration chain applied (infra/db/local/bootstrap-testbed.sh). Fixtures go
 * in through the bed's superuser URL; every function under test is called
 * over a real authenticated connection as the login that calls it when
 * deployed (`jale_admin_console`, and `jale_whatsapp` for the bot's own
 * support definer), so grants and row policies are the deployed ones.
 *
 * The console never reads a worker's number: replies resolve it in SQL from
 * the case's conversation, and only the reveal definer returns it.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: migration 122 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[admin-inbox-122] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL '
        + 'to run the admin Inbox function and privilege checks against Postgres 16.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

const MIGRATION = path.join(__dirname, '..', '..', '..', 'db', 'migrations', '122_admin_inbox.sql');

// Fictional 555-01xx numbers; nothing here reaches a real phone.
const PHONE_REGISTERED = '+15550101201';
const PHONE_UNREGISTERED = '+15550101202';
const PHONE_LOCKED = '+15550101203';
const PHONE_VERIFIED = '+15550101204';
const PHONE_SILENT = '+15550101205';
const PHONE_EDGE = '+15550101206';

const CLOSING_EN = 'Your support case is closed. Send SOPORTE / SUPPORT any time to chat with us again.';
const NOTICE_EN = 'You can verify again now. Reply RESEND to get a new code.';
const NOTICE_ES = 'Ya puedes verificar de nuevo. Responde REENVIAR para recibir un código nuevo.';

const phoneHash = (phone: string): string => createHash('sha256').update(phone.trim()).digest('hex');

async function superuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function asConsole<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withLoginClient('jale_admin_console', async (client) => (await client.query<T>(sql, params)).rows);
}

async function asWhatsapp<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withLoginClient('jale_whatsapp', async (client) => (await client.query<T>(sql, params)).rows);
}

/** The SQLSTATE and message of a refused call; undefined when it succeeded. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: String(e.code), message: String(e.message) };
  }
}

async function queueRow(actor: string, caseId: string, requestId: string, kind: string, text: string | null): Promise<{ result_id: string | null; replayed: boolean }> {
  const rows = await asConsole<{ result_id: string | null; replayed: boolean }>(
    'SELECT result_id, replayed FROM public.admin_queue_support_message($1, $2, $3, $4, $5)',
    [actor, caseId, requestId, kind, text],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function queue(actor: string, caseId: string, requestId: string, kind: string, text: string | null): Promise<string | null> {
  return (await queueRow(actor, caseId, requestId, kind, text)).result_id;
}

async function reset(actor: string, challengeId: string, reason: string, note: string | null, requestId: string): Promise<{ result_id: string; replayed: boolean }> {
  const rows = await asConsole<{ result_id: string; replayed: boolean }>(
    'SELECT result_id, replayed FROM public.admin_reset_identity_lockout($1, $2, $3, $4, $5)',
    [actor, challengeId, reason, note, requestId]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function openSupport(actor: string, challengeId: string, requestId: string): Promise<{ result_id: string; replayed: boolean }> {
  const rows = await asConsole<{ result_id: string; replayed: boolean }>(
    'SELECT result_id, replayed FROM public.admin_open_support_from_lockout($1, $2, $3)', [actor, challengeId, requestId]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function outboxCount(caseId: string): Promise<number> {
  return superuser(async (c) => Number((await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM whatsapp_outbox WHERE source_type = 'admin_case' AND source_id = $1`, [caseId])).rows[0].n));
}

interface OutboxRow {
  whatsapp_number: string;
  body: string | null;
  content_template: string;
  content_variables: Record<string, string>;
  status: string;
  source_type: string;
  source_id: string;
  idempotency_key: string;
}

async function outbox(id: string): Promise<OutboxRow> {
  return superuser(async (c) => (await c.query<OutboxRow>(
    `SELECT whatsapp_number, body, content_template, content_variables, status, source_type, source_id::text, idempotency_key
       FROM whatsapp_outbox WHERE id = $1`, [id])).rows[0]);
}

interface CaseRow {
  id: string;
  case_type: string;
  status: string;
  user_id: string | null;
  conversation_id: string | null;
  resolved_at: Date | null;
  case_number: string;
  details: Record<string, unknown>;
}

async function caseRow(caseId: string): Promise<CaseRow> {
  return superuser(async (c) => (await c.query<CaseRow>(
    `SELECT id, case_type, status, user_id, conversation_id, resolved_at, case_number::text, details
       FROM admin_cases WHERE id = $1`, [caseId])).rows[0]);
}

async function events(caseId: string): Promise<Array<{ event_type: string; actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>> {
  return superuser(async (c) => (await c.query(
    `SELECT event_type, actor_type, actor_id, payload FROM admin_case_events
      WHERE case_id = $1 ORDER BY created_at, id`, [caseId])).rows);
}

maybeDescribe('migration 122 admin Inbox', () => {
  const admin = { ops: '', readonly: '', inactive: '' };
  let workerId: string;
  let convRegistered: string;
  let convUnregistered: string;
  let convLocked: string;
  let convVerified: string;
  let convSilent: string;
  let convEdge: string;
  let caseRegistered: string;
  let caseUnregistered: string;
  let caseSilent: string;
  let caseEdge: string;
  let caseNoConversation: string;
  let challengeLocked: string;
  let challengeVerified: string;
  let challengePending: string;
  const cases = new Set<string>();
  const sids: string[] = [];

  async function newCase(c: Client, conversationId: string | null, userId: string | null, details: Record<string, unknown>, type = 'help_request'): Promise<string> {
    const id = (await c.query<{ id: string }>(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, conversation_id, summary, details)
       VALUES ($1, 'open', 70, $2, $3, 'Worker asked for help on WhatsApp', $4::jsonb) RETURNING id`,
      [type, userId, conversationId, JSON.stringify(details)])).rows[0].id;
    cases.add(id);
    return id;
  }

  async function inbound(c: Client, phone: string, conversationId: string | null, ageInterval: string): Promise<void> {
    const sid = `SM${randomUUID().replace(/-/g, '')}`;
    sids.push(sid);
    await c.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, conversation_id, status, first_seen_at)
       VALUES ($1, $2, $3, 'completed', now() - $4::interval)`, [sid, phone, conversationId, ageInterval]);
  }

  beforeAll(async () => {
    await superuser(async (c) => {
      const adminUser = async (sub: string, email: string, role: string, active: boolean) => (await c.query<{ id: string }>(
        `INSERT INTO admin_users (cognito_sub, admin_email, role, active)
         VALUES ($1, $2, $3, $4) RETURNING id`, [sub, email, role, active])).rows[0].id;
      admin.ops = await adminUser('admin-122-ops', 'inbox-122-ops@example.test', 'admin_ops', true);
      admin.readonly = await adminUser('admin-122-readonly', 'inbox-122-readonly@example.test', 'admin_readonly', true);
      admin.inactive = await adminUser('admin-122-inactive', 'inbox-122-inactive@example.test', 'admin_superadmin', false);

      workerId = (await c.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, full_name, whatsapp_number, created_at)
         VALUES ('w-inbox-122', 'worker', 'Fixture Worker Name', $1, now() - interval '40 days') RETURNING id`,
        [PHONE_REGISTERED])).rows[0].id;
      await c.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding')`, [workerId]);
      await c.query(
        `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
         VALUES ($1, 2, 'profile.trade', 'active')`, [workerId]);

      const conv = async (userId: string | null, phone: string, language: string) => (await c.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, language, conversation_state)
         VALUES ($1, $2, $3, 'idle') RETURNING id`, [userId, phone, language])).rows[0].id;
      convRegistered = await conv(workerId, PHONE_REGISTERED, 'es');
      convUnregistered = await conv(null, PHONE_UNREGISTERED, 'en');
      convLocked = await conv(null, PHONE_LOCKED, 'es');
      convVerified = await conv(null, PHONE_VERIFIED, 'es');
      convSilent = await conv(null, PHONE_SILENT, 'en');
      convEdge = await conv(null, PHONE_EDGE, 'en');

      // The registered worker wrote an hour ago (window open); the
      // unregistered number 30 hours ago (window closed); the silent number
      // never wrote. A '#' row is the bot's own and never opens the window.
      await inbound(c, PHONE_REGISTERED, convRegistered, '1 hour');
      await inbound(c, PHONE_UNREGISTERED, convUnregistered, '30 hours');
      const botSid = `SM${randomUUID().replace(/-/g, '')}#err`;
      sids.push(botSid);
      await c.query(
        `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
         VALUES ($1, $2, 'completed', now() - interval '5 minutes')`, [botSid, PHONE_UNREGISTERED]);

      caseRegistered = await newCase(c, convRegistered, workerId, { language: 'es', source: 'whatsapp_support_mode', registered: true });
      caseUnregistered = await newCase(c, convUnregistered, null, { language: 'en', source: 'whatsapp_support_mode', registered: false });
      caseSilent = await newCase(c, convSilent, null, {});
      caseEdge = await newCase(c, convEdge, null, { language: 'en', source: 'whatsapp_support_mode', registered: false });
      caseNoConversation = await newCase(c, null, null, { subjectType: 'worker' }, 'outbound_failure');

      // A locked challenge (three wrong codes) for the locked number, a
      // verified one, and a pending one with two wrong codes today for the
      // unregistered number. The 101 trigger records every change.
      const challenge = async (phone: string) => (await c.query<{ id: string }>(
        `INSERT INTO worker_identity_challenges (phone_hash, current_step_key, preferred_language, status, attempts, expires_at, context)
         VALUES ($1, 'identity.verify_otp', 'es', 'pending', 0, now() + interval '5 minutes',
                 '{"otpSendHistory":["2026-10-14T10:00:00.000Z"],"keep":"yes"}'::jsonb) RETURNING id`,
        [phoneHash(phone)])).rows[0].id;
      challengeLocked = await challenge(PHONE_LOCKED);
      await c.query('UPDATE worker_identity_challenges SET attempts = 1 WHERE id = $1', [challengeLocked]);
      await c.query('UPDATE worker_identity_challenges SET attempts = 2 WHERE id = $1', [challengeLocked]);
      await c.query(
        `UPDATE worker_identity_challenges SET status = 'locked', locked_until = now() + interval '15 minutes' WHERE id = $1`,
        [challengeLocked]);

      challengeVerified = await challenge(PHONE_VERIFIED);
      await c.query(`UPDATE worker_identity_challenges SET status = 'verified' WHERE id = $1`, [challengeVerified]);

      challengePending = await challenge(PHONE_UNREGISTERED);
      await c.query('UPDATE worker_identity_challenges SET attempts = 1 WHERE id = $1', [challengePending]);
      await c.query('UPDATE worker_identity_challenges SET attempts = 2 WHERE id = $1', [challengePending]);
    });
  });

  afterAll(async () => {
    await superuser(async (c) => {
      const convs = [convRegistered, convUnregistered, convLocked, convVerified, convSilent, convEdge];
      const all = (await c.query<{ id: string }>(
        'SELECT id FROM admin_cases WHERE id = ANY($1::uuid[]) OR conversation_id = ANY($2::uuid[]) OR user_id = $3',
        [[...cases], convs, workerId])).rows.map((r) => r.id);
      if (await c.query(`SELECT to_regclass('public.identity_lockout_resets') AS t`).then((r) => r.rows[0].t)) {
        await c.query('DELETE FROM identity_lockout_resets WHERE challenge_id = ANY($1::uuid[]) OR case_id = ANY($2::uuid[])',
          [[challengeLocked, challengeVerified, challengePending], all]);
      }
      await c.query('DELETE FROM email_outbox WHERE source_id = ANY($1::uuid[])', [all]);
      await c.query(`DELETE FROM whatsapp_outbox WHERE source_type = 'admin_case' AND source_id = ANY($1::uuid[])`, [all]);
      await c.query('DELETE FROM admin_cases WHERE id = ANY($1::uuid[])', [all]);
      await c.query('DELETE FROM worker_identity_challenges WHERE id = ANY($1::uuid[])',
        [[challengeLocked, challengeVerified, challengePending]]);
      await c.query('DELETE FROM whatsapp_processed_messages WHERE message_sid = ANY($1::text[])', [sids]);
      await c.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [convs]);
      await c.query('DELETE FROM users WHERE id = $1', [workerId]);
      await c.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [Object.values(admin)]);
    });
  });

  it('T1: queues a reply to a case with no worker; the number comes from the conversation and the console never reads it', async () => {
    const requestId = randomUUID();
    const outboxId = await queue(admin.ops, caseUnregistered, requestId, 'reply', 'We reset your account. Try again.');
    expect(outboxId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await outbox(outboxId as string);
    expect(row).toMatchObject({
      whatsapp_number: PHONE_UNREGISTERED,
      body: null,
      content_template: 'admin_support_reply_v2_en',
      status: 'pending',
      source_type: 'admin_case',
      source_id: caseUnregistered,
      idempotency_key: `admin-reply:${requestId}`,
    });
    expect(row.content_variables).toEqual({
      1: 'We reset your account. Try again.',
      __fallback_body: 'We reset your account. Try again.',
    });

    const after = await caseRow(caseUnregistered);
    expect(after.status).toBe('pending_worker');
    const queued = (await events(caseUnregistered)).filter((e) => e.event_type === 'admin_reply_queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ actor_type: 'admin', actor_id: admin.ops });
    expect(queued[0].payload).toMatchObject({
      detail: 'We reset your account. Try again.', outboxId, via: null, kind: 'reply', byRole: 'Ops',
    });

    // The same request again changes nothing and answers the first result;
    // the same id with another payload, or as another action, is refused.
    expect(await queueRow(admin.ops, caseUnregistered, requestId, 'reply', 'We reset your account. Try again.'))
      .toEqual({ result_id: outboxId, replayed: true });
    expect((await events(caseUnregistered)).filter((e) => e.event_type === 'admin_reply_queued')).toHaveLength(1);
    expect(await outboxCount(caseUnregistered)).toBe(1);
    expect(await refusal(queue(admin.ops, caseUnregistered, requestId, 'reply', 'Something else')))
      .toEqual({ code: '22023', message: 'invalid_input' });
    expect(await refusal(queue(admin.ops, caseUnregistered, requestId, 'request_info', 'We reset your account. Try again.')))
      .toEqual({ code: '22023', message: 'invalid_input' });
    expect(await outboxCount(caseUnregistered)).toBe(1);
    // The console never reads the request ledger.
    expect((await refusal(asConsole('SELECT request_id FROM admin_inbox_requests LIMIT 1')))?.code).toBe('42501');

    // The console reads no conversation and no number, and may no longer write
    // the outbox itself.
    expect((await refusal(asConsole('SELECT whatsapp_number FROM whatsapp_conversations LIMIT 1')))?.code).toBe('42501');
    expect((await refusal(asConsole(
      `INSERT INTO whatsapp_outbox (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
                                    status, source_type, source_id, idempotency_key)
       VALUES (NULL, 0, $1, NULL, 'admin_support_reply_v2_en', '{"1":"x","__fallback_body":"x"}'::jsonb,
               'pending', 'admin_case', $2, $3)`,
      ['+15550109999', caseUnregistered, `admin-reply:${randomUUID()}`])))?.code).toBe('42501');
    const [view] = await asConsole<Record<string, unknown>>('SELECT * FROM public.admin_support_case_view($1)', [caseUnregistered]);
    expect(JSON.stringify(view)).not.toContain(PHONE_UNREGISTERED);
    expect(JSON.stringify(view)).not.toContain(PHONE_UNREGISTERED.slice(-7));
  });

  it('T2: a closed window caps the reply at 250 characters; an open window takes up to 1000', async () => {
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'open' WHERE id = $1`, [caseUnregistered]));
    const tooLong = await refusal(queue(admin.ops, caseUnregistered, randomUUID(), 'reply', 'x'.repeat(251)));
    expect(tooLong).toEqual({ code: 'P0001', message: 'reply_too_long_for_template' });
    expect(await queue(admin.ops, caseUnregistered, randomUUID(), 'reply', 'y'.repeat(250))).toMatch(/^[0-9a-f-]{36}$/);
    // Counted the way the console counts: whitespace runs (line breaks
    // included) are one space, the ends trimmed, UTF-16 code units.
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'open' WHERE id = $1`, [caseUnregistered]));
    const folded = `  ${'word \n\n\t '.repeat(50).trim()}  `;
    expect(folded.length).toBeGreaterThan(250);
    expect(folded.replace(/\s+/g, ' ').trim().length).toBe(249);
    const foldedId = await queue(admin.ops, caseUnregistered, randomUUID(), 'reply', folded);
    expect((await outbox(foldedId as string)).content_variables['1']).toBe(folded.replace(/\s+/g, ' ').trim());
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'open' WHERE id = $1`, [caseUnregistered]));
    const astral = '\u{1F600}';
    expect(await queue(admin.ops, caseUnregistered, randomUUID(), 'reply', astral.repeat(125))).toMatch(/^[0-9a-f-]{36}$/);
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'open' WHERE id = $1`, [caseUnregistered]));
    expect(await refusal(queue(admin.ops, caseUnregistered, randomUUID(), 'reply', `${astral.repeat(125)}x`)))
      .toEqual({ code: 'P0001', message: 'reply_too_long_for_template' });

    const longOpen = await queue(admin.ops, caseRegistered, randomUUID(), 'reply', `${'z'.repeat(999)}\n`);
    const row = await outbox(longOpen as string);
    expect(row.content_variables.__fallback_body).toBe('z'.repeat(999));
    expect(row.content_variables['1']).toHaveLength(250);
    expect(row.content_variables['1'].endsWith('…')).toBe(true);
    // The shortened copy is measured the same way: 200 emoji are 400 code
    // units, so the copy keeps 124 of them and the ellipsis.
    const astralOpen = await queue(admin.ops, caseRegistered, randomUUID(), 'reply', astral.repeat(200));
    const astralRow = await outbox(astralOpen as string);
    expect(astralRow.content_variables.__fallback_body).toBe(astral.repeat(200));
    expect(astralRow.content_variables['1']).toBe(`${astral.repeat(124)}…`);
    expect(astralRow.content_variables['1'].length).toBeLessThanOrEqual(250);

    expect(await refusal(queue(admin.ops, caseRegistered, randomUUID(), 'reply', 'w'.repeat(1001))))
      .toEqual({ code: '22023', message: 'invalid_input' });
    expect(await refusal(queue(admin.ops, caseRegistered, randomUUID(), 'reply', '   ')))
      .toEqual({ code: '22023', message: 'invalid_input' });
  });

  it('T2b: a window closing within 30 minutes takes the 250 cap; 60 minutes before the edge takes up to 1000', async () => {
    // The window's edge is 23h45m after the worker's last message. Twenty
    // minutes before it the window is still open, but a long reply is refused
    // with the template cap, so a send retried past the edge still fits.
    await superuser((c) => inbound(c, PHONE_EDGE, convEdge, '23 hours 25 minutes'));
    const [view] = await asConsole<{ window_open: boolean }>('SELECT window_open FROM public.admin_support_case_view($1)', [caseEdge]);
    expect(view.window_open).toBe(true);
    expect(await refusal(queue(admin.ops, caseEdge, randomUUID(), 'reply', 'e'.repeat(251))))
      .toEqual({ code: 'P0001', message: 'reply_too_long_for_template' });
    const fits = await queue(admin.ops, caseEdge, randomUUID(), 'reply', 'f'.repeat(250));
    const fitsRow = await outbox(fits as string);
    expect(fitsRow.content_variables['1']).toBe('f'.repeat(250));
    expect(fitsRow.content_variables.__fallback_body).toBe('f'.repeat(250));

    // Sixty minutes before the edge a long reply is queued in full.
    await superuser((c) => c.query(
      `UPDATE whatsapp_processed_messages SET first_seen_at = now() - interval '22 hours 45 minutes' WHERE whatsapp_number = $1`,
      [PHONE_EDGE]));
    const long = await queue(admin.ops, caseEdge, randomUUID(), 'reply', 'g'.repeat(600));
    expect((await outbox(long as string)).content_variables.__fallback_body).toBe('g'.repeat(600));
  });

  it('T3: request_info and resolve queue a message to the worker; a closed case refuses', async () => {
    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'pending_admin' WHERE id = $1`, [caseRegistered]));
    const infoRequest = randomUUID();
    const info = await queue(admin.ops, caseRegistered, infoRequest, 'request_info', 'Send a photo of your ID, please.');
    expect((await outbox(info as string)).idempotency_key).toBe(`admin-request_info:${infoRequest}`);
    expect((await caseRow(caseRegistered)).status).toBe('pending_worker');

    const closeRequest = randomUUID();
    const closing = await queue(admin.ops, caseUnregistered, closeRequest, 'closing', null);
    const closingRow = await outbox(closing as string);
    expect(closingRow.idempotency_key).toBe(`admin-closing:${closeRequest}`);
    expect(closingRow.content_variables.__fallback_body).toBe(CLOSING_EN);
    const resolved = await caseRow(caseUnregistered);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
    const kinds = (await events(caseUnregistered)).filter((e) => e.event_type === 'admin_reply_queued').map((e) => e.payload.kind);
    expect(kinds).toContain('closing');

    expect(await refusal(queue(admin.ops, caseUnregistered, randomUUID(), 'reply', 'Hello again')))
      .toEqual({ code: 'P0001', message: 'case_closed' });
    expect(await refusal(queue(admin.ops, caseUnregistered, randomUUID(), 'closing', null)))
      .toEqual({ code: 'P0001', message: 'case_closed' });

    // A case with no conversation: a reply has no target, resolve closes it quietly.
    expect(await refusal(queue(admin.ops, caseNoConversation, randomUUID(), 'reply', 'Hello')))
      .toEqual({ code: 'P0001', message: 'no_reply_target' });
    expect(await queue(admin.ops, caseNoConversation, randomUUID(), 'closing', null)).toBeNull();
    expect((await caseRow(caseNoConversation)).status).toBe('resolved');
    const note = (await events(caseNoConversation)).find((e) => e.event_type === 'admin_note');
    expect(note?.payload).toMatchObject({ byRole: 'Ops', action: 'resolve' });

    // Only an active Ops or Superadmin acts; an unknown case is not found.
    expect(await refusal(queue(admin.readonly, caseRegistered, randomUUID(), 'reply', 'Hello')))
      .toEqual({ code: '42501', message: 'forbidden' });
    expect(await refusal(queue(admin.inactive, caseRegistered, randomUUID(), 'reply', 'Hello')))
      .toEqual({ code: '42501', message: 'forbidden' });
    expect(await refusal(queue(admin.ops, randomUUID(), randomUUID(), 'reply', 'Hello')))
      .toEqual({ code: 'P0002', message: 'not_found' });
    expect(await refusal(queue(admin.ops, caseRegistered, randomUUID(), 'lockout_notice', 'Hello')))
      .toEqual({ code: '22023', message: 'invalid_input' });
  });

  it('T4: the case language picks the template; unknown falls back to the conversation, then Spanish', async () => {
    const es = await queue(admin.ops, caseRegistered, randomUUID(), 'reply', 'Ya revisamos tu cuenta.');
    expect((await outbox(es as string)).content_template).toBe('admin_support_reply_v2_es');

    // No language on the case: the conversation's (en).
    const silent = await queue(admin.ops, caseSilent, randomUUID(), 'reply', 'Hi there');
    expect((await outbox(silent as string)).content_template).toBe('admin_support_reply_v2_en');
  });

  it('T5: resets a lockout, records it, opens a resolved verification case and queues the notice', async () => {
    const requestId = randomUUID();
    const first = await reset(admin.ops, challengeLocked, 'codes_not_arriving', null, requestId);
    expect(first.replayed).toBe(false);
    const caseId = first.result_id;
    cases.add(caseId);

    const challenge = await superuser(async (c) => (await c.query<{
      status: string; attempts: number; locked_until: Date | null; expires_at: Date | null; context: Record<string, unknown>;
      current_step_key: string;
    }>('SELECT status, attempts, locked_until, expires_at, context, current_step_key FROM worker_identity_challenges WHERE id = $1',
      [challengeLocked])).rows[0]);
    expect(challenge).toEqual({
      status: 'pending', attempts: 0, locked_until: null, expires_at: null, context: { keep: 'yes' },
      current_step_key: 'identity.verify_otp',
    });

    const resetRows = await superuser(async (c) => (await c.query(
      `SELECT challenge_id::text, phone_hash, reason_code, note, admin_user_id::text, case_id::text
         FROM identity_lockout_resets WHERE challenge_id = $1`, [challengeLocked])).rows);
    expect(resetRows).toEqual([{
      challenge_id: challengeLocked, phone_hash: phoneHash(PHONE_LOCKED), reason_code: 'codes_not_arriving', note: null,
      admin_user_id: admin.ops, case_id: caseId,
    }]);

    const kase = await caseRow(caseId);
    expect(kase).toMatchObject({ case_type: 'verification_blocker', status: 'resolved', conversation_id: convLocked, user_id: null });
    expect(kase.resolved_at).not.toBeNull();
    const timeline = await events(caseId);
    expect(timeline.find((e) => e.event_type === 'lockout_reset')?.payload)
      .toMatchObject({ reasonCode: 'codes_not_arriving', byRole: 'Ops' });
    const notice = timeline.find((e) => e.event_type === 'admin_reply_queued');
    expect(notice?.payload).toMatchObject({ kind: 'lockout_notice', byRole: 'Ops' });
    const noticeRow = await outbox(notice?.payload.outboxId as string);
    expect(noticeRow).toMatchObject({
      whatsapp_number: PHONE_LOCKED, content_template: 'admin_support_reply_v2_es', source_id: caseId,
      idempotency_key: `admin-lockout_notice:${requestId}`,
    });
    expect(noticeRow.content_variables.__fallback_body).toBe(NOTICE_ES);
    expect(noticeRow.content_variables['1']).toBe(NOTICE_ES);

    // Replaying the request answers the same case and sends nothing more;
    // the same id with another reason is refused; a second reset is refused.
    expect(await reset(admin.ops, challengeLocked, 'codes_not_arriving', null, requestId))
      .toEqual({ result_id: caseId, replayed: true });
    expect(await outboxCount(caseId)).toBe(1);
    expect(await refusal(reset(admin.ops, challengeLocked, 'worker_confused', null, requestId)))
      .toEqual({ code: '22023', message: 'invalid_input' });
    expect(await refusal(reset(admin.ops, challengeLocked, 'worker_confused', null, randomUUID())))
      .toEqual({ code: 'P0001', message: 'not_locked' });
    expect(await refusal(reset(admin.ops, challengeVerified, 'worker_confused', null, randomUUID())))
      .toEqual({ code: 'P0001', message: 'not_locked' });
    expect(await refusal(reset(admin.ops, challengeVerified, 'other', '  ', randomUUID())))
      .toEqual({ code: '22023', message: 'invalid_input' });
    expect(await refusal(reset(admin.readonly, challengeVerified, 'worker_confused', null, randomUUID())))
      .toEqual({ code: '42501', message: 'forbidden' });

    // The detail: no hash, no user id, no number; the reset and the history are there.
    const [detail] = await asConsole<Record<string, unknown>>(
      'SELECT * FROM public.admin_identity_challenge_detail($1)', [challengeLocked]);
    expect(Object.keys(detail).sort()).toEqual([
      'attempts', 'challenge_id', 'earlier_resets', 'language', 'locked_until', 'masked_phone', 'started_at',
      'state', 'support_case_id', 'timeline', 'typical_minutes_to_verify',
    ]);
    const text = JSON.stringify(detail);
    expect(text).not.toContain(phoneHash(PHONE_LOCKED));
    expect(text).not.toContain(PHONE_LOCKED);
    expect(text).not.toContain(workerId);
    expect(detail).toMatchObject({ state: 'in_progress', language: 'es', masked_phone: '+1 555 *** 1203', earlier_resets: 0, attempts: 0 });
    const steps = detail.timeline as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.kind)).toContain('reset');
    expect(steps.find((s) => s.kind === 'reset')).toMatchObject({ reason_code: 'codes_not_arriving', by_role: 'Ops' });
    expect(steps.filter((s) => s.kind === 'status').map((s) => s.to_status)).toEqual(
      expect.arrayContaining(['pending', 'locked']));
    expect(await asConsole('SELECT * FROM public.admin_identity_challenge_detail($1)', [randomUUID()])).toEqual([]);

    // The console never reads the resets table itself.
    expect((await refusal(asConsole('SELECT id FROM identity_lockout_resets LIMIT 1')))?.code).toBe('42501');
  });

  it('opens a support case from a lockout once, and the bot then reuses it', async () => {
    const openRequest = randomUUID();
    const { result_id: opened } = await openSupport(admin.ops, challengeLocked, openRequest);
    cases.add(opened);
    const kase = await caseRow(opened);
    expect(kase).toMatchObject({ case_type: 'help_request', status: 'open', conversation_id: convLocked });
    expect(kase.details).toMatchObject({ language: 'es', registered: false });
    const note = (await events(opened)).find((e) => e.event_type === 'admin_note');
    expect(note?.payload.detail).toBe(`Opened from lockout V-${challengeLocked.slice(0, 8).toUpperCase()}`);
    expect(await superuser(async (c) => Number((await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM whatsapp_outbox WHERE source_id = $1', [opened])).rows[0].n))).toBe(0);

    // A repeat of the request adds nothing; a new request reuses the case.
    expect(await openSupport(admin.ops, challengeLocked, openRequest)).toEqual({ result_id: opened, replayed: true });
    expect((await events(opened)).filter((e) => e.event_type === 'admin_note')).toHaveLength(1);
    const reused = await openSupport(admin.ops, challengeLocked, randomUUID());
    expect(reused).toEqual({ result_id: opened, replayed: false });
    const [bot] = await asWhatsapp<{ case_id: string; created: boolean }>(
      'SELECT case_id, created FROM support_open_case($1, $2, $3, $4, $5)', [convLocked, null, 'es', 'Hola', null]);
    expect(bot).toEqual({ case_id: opened, created: false });

    const [detail] = await asConsole<{ support_case_id: string }>(
      'SELECT support_case_id FROM public.admin_identity_challenge_detail($1)', [challengeLocked]);
    expect(detail.support_case_id).toBe(opened);
  });

  it('the case view: window, language, worker context and a masked number only', async () => {
    const [registered] = await asConsole<Record<string, unknown>>('SELECT * FROM public.admin_support_case_view($1)', [caseRegistered]);
    expect(registered).toMatchObject({
      case_id: caseRegistered, has_conversation: true, language: 'es', window_open: true, window_closed_at: null,
      registered: true, onboarding_step_key: 'profile.trade', masked_phone: '+1 555 *** 1201',
    });
    expect(registered.window_closes_at).toBeInstanceOf(Date);
    expect(registered.joined_at).toBeInstanceOf(Date);

    const [unregistered] = await asConsole<Record<string, unknown>>('SELECT * FROM public.admin_support_case_view($1)', [caseUnregistered]);
    expect(unregistered).toMatchObject({
      language: 'en', window_open: false, window_closes_at: null, registered: false, joined_at: null,
      onboarding_step_key: 'identity.verify_otp', failed_codes_today: 2,
    });
    expect(unregistered.window_closed_at).toBeInstanceOf(Date);

    const [silent] = await asConsole<Record<string, unknown>>('SELECT * FROM public.admin_support_case_view($1)', [caseSilent]);
    expect(silent).toMatchObject({ window_open: false, window_closes_at: null, window_closed_at: null, language: 'en' });

    const [none] = await asConsole<Record<string, unknown>>('SELECT * FROM public.admin_support_case_view($1)', [caseNoConversation]);
    expect(none).toMatchObject({ has_conversation: false, masked_phone: null, window_open: false });
    expect(await asConsole('SELECT * FROM public.admin_support_case_view($1)', [randomUUID()])).toEqual([]);
  });

  it('reveals the number of a case only through its definer, and links an attachment of that case only', async () => {
    const [{ phone }] = await asConsole<{ phone: string | null }>('SELECT public.admin_support_reveal_phone($1) AS phone', [caseRegistered]);
    expect(phone).toBe(PHONE_REGISTERED);
    const [{ phone: nothing }] = await asConsole<{ phone: string | null }>('SELECT public.admin_support_reveal_phone($1) AS phone', [caseNoConversation]);
    expect(nothing).toBeNull();

    await superuser((c) => c.query(`UPDATE admin_cases SET status = 'open' WHERE id = $1`, [caseRegistered]));
    const key = `support/${caseRegistered}/${randomUUID()}.jpg`;
    const [media] = await asWhatsapp<{ media_id: string }>(
      'SELECT media_id FROM support_append_message($1, $2, $3, $4, $5::jsonb, $6)',
      [caseRegistered, convRegistered, 'media', 'mi credencial',
        JSON.stringify({ s3Key: key, mediaType: 'image', contentType: 'image/jpeg', byteSize: 2048 }), 'es']);

    const link = async (caseId: string, mediaId: string) => (await asConsole<{ outcome: string; s3_key: string | null; content_type: string | null }>(
      'SELECT outcome, s3_key, content_type FROM public.admin_support_media_link($1, $2)', [caseId, mediaId]))[0];
    expect(await link(caseRegistered, media.media_id)).toEqual({ outcome: 'ok', s3_key: key, content_type: 'image/jpeg' });
    expect(await link(caseUnregistered, media.media_id)).toEqual({ outcome: 'not_found', s3_key: null, content_type: null });
    expect(await link(caseRegistered, randomUUID())).toEqual({ outcome: 'not_found', s3_key: null, content_type: null });

    await superuser((c) => c.query(
      `UPDATE support_case_media SET created_at = now() - interval '91 days', expires_at = now() - interval '1 day' WHERE id = $1`,
      [media.media_id]));
    expect(await link(caseRegistered, media.media_id)).toEqual({ outcome: 'media_expired', s3_key: null, content_type: null });

    // The flag the definer opens is closed again before it returns.
    const flag = await withLoginClient('jale_admin_console', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT * FROM public.admin_support_media_link($1, $2)', [caseRegistered, media.media_id]);
      const r = await c.query<{ v: string | null }>(`SELECT current_setting('app.support_case_media', true) AS v`);
      await c.query('ROLLBACK');
      return r.rows[0].v;
    });
    expect(flag === null || flag === '').toBe(true);
  });

  it('gives each console definer to the console only, and the helpers to no login', async () => {
    const consoleFns = [
      'admin_support_case_view(uuid)',
      'admin_support_media_link(uuid, uuid)',
      'admin_support_reveal_phone(uuid)',
      'admin_queue_support_message(uuid, uuid, uuid, text, text)',
      'admin_identity_challenge_detail(uuid)',
      'admin_reset_identity_lockout(uuid, uuid, text, text, uuid)',
      'admin_open_support_from_lockout(uuid, uuid, uuid)',
    ];
    const rows = await superuser(async (c) => (await c.query<{ fn: string; console: boolean; whatsapp: boolean; pub: boolean; definer: boolean; owner: string; config: string[] }>(
      `SELECT p.oid::regprocedure::text AS fn,
              has_function_privilege('jale_admin_console', p.oid, 'EXECUTE') AS console,
              has_function_privilege('jale_whatsapp', p.oid, 'EXECUTE') AS whatsapp,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.proname LIKE 'admin\\_support\\_%' OR p.proname LIKE 'admin\\_identity\\_challenge\\_%'
               OR p.proname LIKE 'admin\\_inbox\\_%'
               OR p.proname IN ('admin_queue_support_message', 'admin_reset_identity_lockout',
                                'admin_open_support_from_lockout', 'identity_lockout_resets_forget_phone'))`)).rows);
    // regprocedure prints the argument list without spaces, and the schema
    // only when it is not on the search path.
    const sameFn = (printed: string, fn: string) => printed.replace(/^public\./, '').replace(/\s/g, '') === fn.replace(/\s/g, '');
    for (const fn of consoleFns) {
      expect(rows.find((r) => sameFn(r.fn, fn))).toMatchObject({
        console: true, whatsapp: false, pub: false, definer: true, owner: 'jale_admin',
      });
    }
    for (const row of rows) {
      expect(row.owner).toBe('jale_admin');
      expect(row.pub).toBe(false);
      expect(row.config).toContain('search_path=pg_catalog, pg_temp');
      const isConsoleFn = consoleFns.some((fn) => sameFn(row.fn, fn));
      if (!isConsoleFn) expect(row.console).toBe(false);
    }
    expect(rows.length).toBe(consoleFns.length + 9);
  });

  it('keeps a reset row when its challenge goes, without the phone hash', async () => {
    const challengeId = await superuser(async (c) => (await c.query<{ id: string }>(
      `INSERT INTO worker_identity_challenges (phone_hash, current_step_key, preferred_language, status, attempts, locked_until)
       VALUES ($1, 'identity.verify_otp', 'en', 'locked', 2, now() + interval '10 minutes') RETURNING id`,
      [phoneHash(PHONE_SILENT)])).rows[0].id);
    const { result_id: caseId } = await reset(admin.ops, challengeId, 'other', 'Confirmed by a phone call', randomUUID());
    cases.add(caseId);
    expect((await outbox((await events(caseId)).find((e) => e.event_type === 'admin_reply_queued')?.payload.outboxId as string))
      .content_variables.__fallback_body).toBe(NOTICE_EN);

    await superuser((c) => c.query('DELETE FROM worker_identity_challenges WHERE id = $1', [challengeId]));
    const rows = await superuser(async (c) => (await c.query(
      'SELECT challenge_id, phone_hash, reason_code, note FROM identity_lockout_resets WHERE case_id = $1', [caseId])).rows);
    expect(rows).toEqual([{ challenge_id: null, phone_hash: null, reason_code: 'other', note: 'Confirmed by a phone call' }]);
  });

  it('T6: case numbers follow creation order, stay unique, and new cases take the next one', async () => {
    const [a, b] = await superuser(async (c) => {
      const x = await newCase(c, null, null, {});
      const y = await newCase(c, null, null, {});
      return [x, y];
    });
    const na = Number((await caseRow(a)).case_number);
    const nb = Number((await caseRow(b)).case_number);
    expect(nb).toBeGreaterThan(na);
    expect(await superuser(async (c) => (await c.query<{ ok: boolean }>(
      `SELECT bool_and(i.indisunique) AS ok FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = 'public.admin_cases'::regclass AND a.attname = 'case_number' AND i.indnatts = 1`)).rows[0].ok)).toBe(true);

    // The migration's own backfill block, re-run on rows created out of
    // order, in a transaction that is rolled back.
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const begin = sql.indexOf('-- BEGIN case_number backfill');
    const end = sql.indexOf('-- END case_number backfill');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const block = sql.slice(begin, end);

    await superuser(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE public.admin_cases DROP COLUMN case_number');
        const ids: string[] = [];
        for (const age of ['1 day', '3 days', '2 days']) {
          ids.push((await c.query<{ id: string }>(
            `INSERT INTO admin_cases (case_type, status, priority, summary, details, created_at)
             VALUES ('help_request', 'open', 50, 'backfill check', '{}'::jsonb, now() - $1::interval) RETURNING id`,
            [age])).rows[0].id);
        }
        await c.query(block);
        const ordered = (await c.query<{ in_order: boolean; numbered: number; total: number; first: string }>(
          `SELECT bool_and(rn = case_number) AS in_order, count(case_number)::int AS numbered, count(*)::int AS total,
                  min(case_number)::text AS first
             FROM (SELECT case_number, row_number() OVER (ORDER BY created_at, id) AS rn FROM admin_cases) t`)).rows[0];
        expect(ordered).toEqual({ in_order: true, numbered: ordered.total, total: ordered.total, first: '1' });
        const mine = (await c.query<{ id: string; case_number: string }>(
          'SELECT id, case_number::text FROM admin_cases WHERE id = ANY($1::uuid[]) ORDER BY created_at', [ids])).rows;
        expect(mine.map((r) => r.id)).toEqual([ids[1], ids[2], ids[0]]);
        const next = (await c.query<{ case_number: string }>(
          `INSERT INTO admin_cases (case_type, status, priority, summary, details)
           VALUES ('help_request', 'open', 50, 'backfill check', '{}'::jsonb) RETURNING case_number::text`)).rows[0];
        expect(Number(next.case_number)).toBe(ordered.total + 1);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});
