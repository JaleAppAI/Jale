/**
 * r-paths-sweep-fixtures.ts -- scene, seeding and invocation helpers for
 * r-paths-handler-sweep.integration.test.ts.
 *
 * Builds on r-paths-world.ts. Every row is written through the superuser
 * client World holds, never through the login under test, and everything a
 * scene seeds -- or that a handler under test writes -- is removed by the
 * scene's cleanup, children first. Values are obviously fake: phones come
 * from fakePhone(), names say "Fixture", e-mail addresses end in
 * @fixture.invalid, provider ids carry a `fixture-` prefix.
 *
 * Errors are labelled so a run log separates the three kinds of failure:
 *   SEED FAILED:     a fixture could not be written (a defect in this file);
 *   CLEANUP FAILED:  a scene could not be removed (a defect in this file);
 *   anything else:   the handler under test, on its login.
 *
 * Not a test file (no .test.ts suffix), so jest never runs it on its own.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { apiEvent, type ApiEventInput, type JobOptions, World, type WorkerOptions } from './r-paths-world';

const WATCHED = Symbol('sweep.watched');

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Scene ──────────────────────────────────────────────────────────────

export interface SweepScene {
  world: World;
  /** Subs of accounts a handler creates itself (sign-up, post-confirmation). */
  createdSubs: string[];
  /** city_key / area_code pairs seeded for pay references. */
  wageAreas: Array<{ cityKey: string; areaCode: string }>;
}

/**
 * Opens a World and registers the cleanup World does not cover: tables with no
 * foreign key to a fixture row, tables whose key to users is RESTRICT, and
 * rows a handler under test creates. It runs before World's own deletes.
 */
export async function openScene(databaseUrl: string): Promise<SweepScene> {
  const world = new World(databaseUrl);
  await world.connect();
  const scene: SweepScene = { world, createdSubs: [], wageAreas: [] };
  world.onCleanup(() => cleanupSweepRows(scene));
  return scene;
}

async function cleanupSweepRows(scene: SweepScene): Promise<void> {
  const su = scene.world.su;
  const users = [...scene.world.users];
  // email_outbox has no foreign key: every row a scene seeds, or a handler
  // queues, carries one of the scene's users as its source.
  await su.query(`DELETE FROM email_outbox WHERE source_id = ANY($1::uuid[])`, [users]);
  // RESTRICT on users.
  await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [users]);
  await su.query(`DELETE FROM worker_post_media WHERE worker_id = ANY($1::uuid[])`, [users]);
  await su.query(`DELETE FROM worker_posts WHERE worker_id = ANY($1::uuid[])`, [users]);
  await su.query(`DELETE FROM billing_operations WHERE actor_user_id = ANY($1::uuid[])`, [users]);
  await su.query(`DELETE FROM billing_customers WHERE user_id = ANY($1::uuid[])`, [users]);
  await su.query(`DELETE FROM subscriptions WHERE user_id = ANY($1::uuid[])`, [users]);
  // Visibility events have no foreign key; World removes those of the jobs it
  // tracks, this removes those of any job a handler created for the scene.
  await su.query(
    `DELETE FROM job_visibility_events
      WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = ANY($1::uuid[]))`,
    [users],
  );
  // Reference rows seeded for pay references.
  if (scene.wageAreas.length > 0) {
    await su.query(
      `DELETE FROM wage_references WHERE area_code = ANY($1::text[])`,
      [scene.wageAreas.map((area) => area.areaCode)],
    );
    await su.query(
      `DELETE FROM city_cbsa_crosswalk WHERE city_key = ANY($1::text[])`,
      [scene.wageAreas.map((area) => area.cityKey)],
    );
  }
  // Accounts a handler created: no rows of their own beyond cascades, except
  // the company an employer sign-up creates (migration 118). Deleting the user
  // cascades the membership; the organization is removed once no member is
  // left in it. Its ids are read BEFORE the users delete, while the
  // membership rows still name them.
  if (scene.createdSubs.length > 0) {
    await su.query(
      `DELETE FROM legal_consent_log
        WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
      [scene.createdSubs],
    );
    const createdOrganizations = await su.query<{ organization_id: string }>(
      `SELECT m.organization_id
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE u.cognito_sub = ANY($1::text[])`,
      [scene.createdSubs],
    );
    await su.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [scene.createdSubs]);
    await su.query(
      `DELETE FROM organizations o
        WHERE o.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id)`,
      [createdOrganizations.rows.map((row) => row.organization_id)],
    );
  }
}

/** Removes the scene and closes its connection; errors say CLEANUP FAILED. */
export async function closeScene(scene: SweepScene | undefined): Promise<void> {
  if (!scene) return;
  try {
    await scene.world.cleanup();
  } catch (err) {
    throw new Error(`CLEANUP FAILED: ${messageOf(err)}`);
  } finally {
    await scene.world.end();
  }
}

/** Runs a seeding step; errors say SEED FAILED. */
export async function seed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`SEED FAILED: ${messageOf(err)}`);
  }
}

// ── Marked fixtures ────────────────────────────────────────────────────
//
// Every account, job and reference row this suite creates carries a marker
// (`Fixture Sweep` names and titles, `fixture-sweep-` subs and keys), so a
// leftover count on a shared bed can tell this suite's rows from another's.

export const SWEEP_NAME = 'Fixture Sweep';
export const SWEEP_SUB_PREFIX = 'fixture-sweep-';

export function sweepEmployer(scene: SweepScene, opts: { companyName?: string | null } = {}) {
  return scene.world.employer({
    fullName: `${SWEEP_NAME} Employer`,
    ...(opts.companyName === null ? {} : { companyName: opts.companyName ?? `${SWEEP_NAME} Co` }),
  });
}

export function sweepWorker(scene: SweepScene, opts: Omit<WorkerOptions, 'fullName'> = {}) {
  return scene.world.worker({ fullName: `${SWEEP_NAME} Worker`, ...opts });
}

export function sweepJob(scene: SweepScene, employerId: string, opts: JobOptions = {}) {
  return scene.world.job(employerId, { title: `${SWEEP_NAME} Job`, ...opts });
}

/** A sub for an account the handler under test creates itself. */
export function createdSub(scene: SweepScene, kind: string): string {
  const sub = `${SWEEP_SUB_PREFIX}${kind}-${randomUUID()}`;
  scene.createdSubs.push(sub);
  return sub;
}

// ── Seeds World does not provide ───────────────────────────────────────

/** A pay-reference area: a crosswalk row and one wage row, both unique to the scene. */
export async function wageReference(scene: SweepScene, trade: string): Promise<{
  cityKey: string; areaCode: string; p25: number; p50: number; p75: number;
}> {
  const suffix = randomBytes(4).toString('hex');
  const cityKey = `${SWEEP_SUB_PREFIX}${suffix}-tx`;
  const areaCode = `FIXTURE-SWEEP-${suffix}`;
  scene.wageAreas.push({ cityKey, areaCode });
  await scene.world.su.query(
    `INSERT INTO wage_references
       (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
     VALUES ($1, $2, 'metro', 'Fixture Metro', 21.50, 26.25, 31.75, 'metro', 'fixture-vintage')`,
    [trade, areaCode],
  );
  await scene.world.su.query(
    `INSERT INTO city_cbsa_crosswalk (city_key, area_code, area_kind) VALUES ($1, $2, 'metro')`,
    [cityKey, areaCode],
  );
  return { cityKey, areaCode, p25: 21.5, p50: 26.25, p75: 31.75 };
}

export async function setTosVersion(scene: SweepScene, userId: string, version: string | null): Promise<void> {
  await scene.world.su.query(`UPDATE users SET tos_version = $2 WHERE id = $1`, [userId, version]);
}

export async function applicationDefaults(scene: SweepScene, workerId: string, answers: Record<string, unknown>): Promise<void> {
  await scene.world.su.query(
    `INSERT INTO worker_application_defaults (worker_id, answers) VALUES ($1, $2::jsonb)`,
    [workerId, JSON.stringify(answers)],
  );
}

export interface DigestSettingsInput {
  enabled: boolean;
  /** A fixed hour, or 'now' for the current hour in `timezone` (computed by the database). */
  sendHourLocal: number | 'now';
  timezone: string;
  language: 'en' | 'es';
  unsubscribeTokenVersion?: number;
}

export async function digestSettings(scene: SweepScene, employerId: string, input: DigestSettingsInput): Promise<void> {
  await scene.world.su.query(
    `INSERT INTO employer_digest_settings
       (employer_id, enabled, send_hour_local, timezone, language, unsubscribe_token_version)
     VALUES ($1, $2,
             CASE WHEN $3::int IS NULL
                  THEN date_part('hour', now() AT TIME ZONE $4::text)::smallint
                  ELSE $3::int::smallint END,
             $4, $5, $6)`,
    [
      employerId, input.enabled, input.sendHourLocal === 'now' ? null : input.sendHourLocal,
      input.timezone, input.language, input.unsubscribeTokenVersion ?? 1,
    ],
  );
}

/**
 * A time zone whose current local minute is at least ten minutes away from
 * the next hour, so an hour computed at seed time still matches when the
 * handler runs a moment later.
 */
export async function zoneAwayFromHourBoundary(scene: SweepScene): Promise<string> {
  const { rows } = await scene.world.su.query<{ minute: number }>(
    `SELECT date_part('minute', now() AT TIME ZONE 'America/Chicago')::int AS minute`,
  );
  // Asia/Kolkata is offset by half an hour from every whole-hour zone.
  return rows[0].minute < 50 ? 'America/Chicago' : 'Asia/Kolkata';
}

export interface OutboxInput {
  sourceType: 'employer_digest' | 'billing_pause';
  sourceId: string;
  recipientEmail: string;
  status?: 'pending' | 'sent';
  sesMessageId?: string | null;
}

/** An email_outbox row (cleaned up by its source id, a scene user). */
export async function emailOutbox(scene: SweepScene, input: OutboxInput): Promise<string> {
  const { rows } = await scene.world.su.query<{ id: string }>(
    `INSERT INTO email_outbox
       (recipient_email, subject, body_text, source_type, source_id, idempotency_key,
        status, sent_at, ses_message_id, created_at)
     VALUES ($1, 'Fixture subject', 'Fixture body text.', $2, $3, $4,
             $5, CASE WHEN $5 = 'sent' THEN now() END, $6, now() - interval '1 hour')
     RETURNING id`,
    [
      input.recipientEmail, input.sourceType, input.sourceId, `fixture-${randomUUID()}`,
      input.status ?? 'pending', input.sesMessageId ?? null,
    ],
  );
  return rows[0].id;
}

/** A published worker post with one media row (approved unless stated). */
export async function workerPost(scene: SweepScene, workerId: string, opts: {
  caption?: string; moderation?: 'approved' | 'flagged';
} = {}): Promise<{ postId: string; mediaId: string }> {
  const postId = randomUUID();
  await scene.world.su.query(
    `INSERT INTO worker_posts (id, worker_id, caption, source, status) VALUES ($1, $2, $3, 'web', 'published')`,
    [postId, workerId, opts.caption ?? 'Fixture post'],
  );
  const { rows } = await scene.world.su.query<{ id: string }>(
    `INSERT INTO worker_post_media
       (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
     VALUES ($1, $2, $3, 'fixture-version-1', 0, 'image/jpeg', 2048, $4)
     RETURNING id`,
    [postId, workerId, `${workerId}/posts/${postId}/${randomUUID()}.jpg`, opts.moderation ?? 'approved'],
  );
  return { postId, mediaId: rows[0].id };
}

export async function subscription(scene: SweepScene, userId: string, planCode: string, status: string): Promise<void> {
  await scene.world.su.query(
    `INSERT INTO subscriptions
       (user_id, plan_code, provider_subscription_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, now() - interval '1 day', now() + interval '29 days')`,
    [userId, planCode, `fixture-subscription-${randomUUID()}`, status],
  );
}

export async function billingCustomer(scene: SweepScene, userId: string): Promise<string> {
  const customerId = `fixture-customer-${randomUUID()}`;
  await scene.world.su.query(
    `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)`,
    [userId, customerId],
  );
  return customerId;
}

export async function jobTemplate(scene: SweepScene, employerId: string, name: string): Promise<string> {
  const { rows } = await scene.world.su.query<{ id: string }>(
    `INSERT INTO employer_job_templates (employer_id, name, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [employerId, name, JSON.stringify({ title: `${SWEEP_NAME} Template Job`, location: 'Fixture City, TX', job_type: 'full-time' })],
  );
  return rows[0].id;
}

export async function visibilityEvent(scene: SweepScene, jobId: string, publicCode: string, kind: 'published' | 'removed'): Promise<string> {
  const { rows } = await scene.world.su.query<{ id: string }>(
    `INSERT INTO job_visibility_events (job_id, public_code, event_kind, created_at)
     VALUES ($1, $2, $3, now() - interval '1 hour') RETURNING id`,
    [jobId, publicCode, kind],
  );
  return rows[0].id;
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

/** A referral_apply_tokens row (cascades away with its job). */
export async function applyToken(scene: SweepScene, jobId: string, expiresAgo: string | null): Promise<string> {
  const tokenHash = hex64();
  await scene.world.su.query(
    `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at)
     VALUES ($1, $2, CASE WHEN $3::interval IS NULL THEN now() + interval '1 day' ELSE now() - $3::interval END)`,
    [tokenHash, jobId, expiresAgo],
  );
  return tokenHash;
}

/** An unclaimed referral_pending_claims row (cascades away with its job). */
export async function pendingClaim(scene: SweepScene, jobId: string, expiresAgo: string | null): Promise<string> {
  const phoneHash = hex64();
  await scene.world.su.query(
    `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
     VALUES ($1, $2, CASE WHEN $3::interval IS NULL THEN now() + interval '30 days' ELSE now() - $3::interval END)`,
    [phoneHash, jobId, expiresAgo],
  );
  return phoneHash;
}

/** A job_share_opens row (cascades away with its job). */
export async function shareOpen(scene: SweepScene, jobId: string, openedAgo: string): Promise<string> {
  const { rows } = await scene.world.su.query<{ id: string }>(
    `INSERT INTO job_share_opens (job_id, device_kind, opened_at)
     VALUES ($1, 'mobile', now() - $2::interval) RETURNING id`,
    [jobId, openedAgo],
  );
  return rows[0].id;
}

/** count(*) of `FROM ...` through the superuser. */
export async function count(scene: SweepScene, from: string, params: unknown[]): Promise<number> {
  const { rows } = await scene.world.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from}`, params);
  return rows[0].n;
}

// ── Driving handlers ───────────────────────────────────────────────────

export interface SweepEventInput extends ApiEventInput {
  headers?: Record<string, string>;
}

/** apiEvent, plus request headers. */
export function sweepEvent(input: SweepEventInput): any {
  const event = apiEvent(input);
  if (input.headers) event.headers = { ...event.headers, ...input.headers };
  return event;
}

/**
 * Console output a handler wrote during one test. Handlers turn a refused
 * statement into a bare 500, so the logged cause is what names the missing
 * right; it is appended to every failed expectation.
 */
export class LogCapture {
  readonly lines: string[] = [];
  private spies: jest.SpyInstance[] = [];

  start(): void {
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      this.spies.push(jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        if (level === 'error' || level === 'warn') {
          this.lines.push(args.map((arg) => (typeof arg === 'string' ? arg : safeJson(arg))).join(' '));
        }
      }));
    }
  }

  stop(): void {
    for (const spy of this.spies) spy.mockRestore();
    this.spies = [];
  }

  /** Adds a line of the test's own (a refused statement, say). */
  note(line: string): void {
    this.lines.push(line);
  }

  /**
   * Notes every statement the pool's clients have refused, so a handler that
   * maps a database error to a bare 500 without logging it still names the
   * missing right. Only the error message is kept, never the SQL or its
   * parameters.
   */
  watchPool(pool: Pool): void {
    pool.on('acquire', (client) => {
      const target = client as unknown as { query: (...args: unknown[]) => unknown; [WATCHED]?: true };
      if (target[WATCHED]) return;
      target[WATCHED] = true;
      const original = target.query.bind(client);
      target.query = (...args: unknown[]) => {
        const result = original(...args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).then(undefined, (err: unknown) => this.note(`database refused: ${messageOf(err)}`));
        }
        return result;
      };
    });
  }

  text(): string {
    return this.lines.length > 0 ? this.lines.join(' | ') : '(nothing logged)';
  }
}

function safeJson(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface HandlerResponse {
  statusCode: number;
  body: any;
  rawBody: string;
  headers: Record<string, string>;
}

export async function invoke(handler: (event: any) => Promise<any>, event: any): Promise<HandlerResponse> {
  const result = await handler(event);
  let body: any = result?.body ?? null;
  try {
    body = result?.body ? JSON.parse(result.body) : null;
  } catch {
    // leave non-JSON bodies as text
  }
  return { statusCode: result?.statusCode, body, rawBody: result?.body ?? '', headers: result?.headers ?? {} };
}

/** Fails with the response and the handler's own log when the status differs. */
export function expectStatus(response: HandlerResponse, expected: number, logs: LogCapture): void {
  if (response.statusCode !== expected) {
    throw new Error(
      `expected HTTP ${expected}, got ${response.statusCode} ${response.rawBody.slice(0, 300)}; handler log: ${logs.text()}`,
    );
  }
}

/** Fails with the handler's own log when a durable effect or summary is missing. */
export function expectThat(condition: boolean, what: string, logs: LogCapture): void {
  if (!condition) throw new Error(`${what}; handler log: ${logs.text()}`);
}

/** Runs a handler that has no HTTP response; a throw carries the handler's own log. */
export async function run<T>(fn: () => Promise<T>, logs: LogCapture): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`handler threw: ${messageOf(err)}; handler log: ${logs.text()}`);
  }
}
