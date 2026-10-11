/**
 * problem-reports-functions.integration.test.ts -- report a problem: every
 * jale_cap report function on its real caller login (migration 108).
 *
 *   jale_api                  create_verified, upload_grant, pending_upload, attach
 *   jale_api_public_reports   config, create_unverified, upload_grant,
 *                             pending_upload, attach
 *   jale_admin_console        inbox, counts, detail, reveal_contact, image,
 *                             set_status, set_note, settings_get, settings_set
 *
 * Each function scopes to its caller in SQL: the verified create reads the
 * caller from app.current_user_id (set transaction-locally, as the Lambda
 * does), the upload functions require the report's attach token hash, and the
 * console functions belong to the console login alone. Refusals are outcome
 * codes; only programming errors raise (22023, 42501).
 *
 * Every call goes over a real authenticated connection as the caller login
 * and commits, so a refusal's side effects (a rate-limit count) are what a
 * Lambda that commits after every outcome leaves behind. Fixtures, and the
 * backdating that ages a report, go through the superuser URL. Runs in every
 * test-bed profile: each function runs as its own capability owner whatever
 * the profile.
 *
 * No address, hostname or phone number is written here: the team recipient,
 * the dashboard address and the contacts are assembled at runtime from
 * reserved test names, and every token and address hash is random.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DB_PROFILES, describeInProfiles, loginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: problem-reports functions PostgreSQL gate was not run', () => {
    console.warn('[problem-reports-functions] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

// Reserved test names (RFC 2606/6761), assembled at runtime.
const TEST_DOMAIN = ['example', 'invalid'].join('.');
const TEAM_RECIPIENT = ['report-team', TEST_DOMAIN].join('@');
const ADMIN_BASE_URL = ['https:', '', `dashboard.${TEST_DOMAIN}`].join('/');
const TYPED_EMAIL = ['reporter.one', TEST_DOMAIN].join('@');
/** TYPED_EMAIL masked: its first character and its domain. */
const MASKED_EMAIL = `r***@${TEST_DOMAIN}`;
// A fictional number: the 555-01xx block is reserved for fiction.
const TYPED_PHONE = ['+1', '555', '010', '0199'].join(' ');
const MIDDLE_DOT = String.fromCharCode(0xb7);

const tokenHash = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');
const addressHash = (): string => randomBytes(32).toString('hex');

interface CreateRow {
  outcome: string;
  report_id: string | null;
  report_number: string | null;
  replayed: boolean | null;
  email_queued: boolean | null;
}

interface VerifiedArgs {
  clientKey: string | null;
  roleHint: string | null;
  category: string | null;
  description: string | null;
  stopsWork: boolean | null;
  locale: string | null;
  includeTechnical: boolean | null;
  context: unknown;
  tokenHash: string | null;
}

interface UnverifiedArgs extends Omit<VerifiedArgs, 'roleHint'> {
  roleClaimed: string | null;
  contact: string | null;
  addressHash: string | null;
}

const CONTEXT = { v: 1, screen: { pattern: '/worker/jobs/:id', refs: {} }, app: { build: 'abcdef123456', locale: 'es' } };

const verifiedArgs = (overrides: Partial<VerifiedArgs> = {}): VerifiedArgs => ({
  clientKey: randomUUID(),
  roleHint: 'worker',
  category: 'applying',
  description: 'The apply button does nothing when I tap it.',
  stopsWork: null,
  locale: 'es',
  includeTechnical: true,
  context: CONTEXT,
  tokenHash: tokenHash(),
  ...overrides,
});

const unverifiedArgs = (overrides: Partial<UnverifiedArgs> = {}): UnverifiedArgs => ({
  clientKey: randomUUID(),
  roleClaimed: 'worker',
  category: 'sign_in',
  description: 'The code never arrived on my phone.',
  stopsWork: null,
  locale: 'es',
  contact: null,
  includeTechnical: true,
  context: CONTEXT,
  tokenHash: tokenHash(),
  addressHash: addressHash(),
  ...overrides,
});

/** Runs `fn` inside one transaction on `client`; commits on success, rolls back on error. */
async function inTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  }
}

describeInProfiles(DB_PROFILES, 'problem report functions', () => {
  let su: Client;
  let api: Client;
  let pub: Client;
  let console_: Client;
  const userIds: string[] = [];

  const callVerified = (client: Client, sub: string | null, args: VerifiedArgs): Promise<CreateRow> =>
    inTransaction(client, async () => {
      if (sub !== null) await client.query("SELECT pg_catalog.set_config('app.current_user_id', $1, true)", [sub]);
      const { rows } = await client.query<CreateRow>(
        `SELECT * FROM jale_cap.problem_report_create_verified($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [args.clientKey, args.roleHint, args.category, args.description, args.stopsWork, args.locale,
          args.includeTechnical, args.context === null ? null : JSON.stringify(args.context), args.tokenHash],
      );
      return rows[0];
    });

  const createVerified = (sub: string | null, overrides: Partial<VerifiedArgs> = {}) =>
    callVerified(api, sub, verifiedArgs(overrides));

  const callUnverified = (client: Client, args: UnverifiedArgs): Promise<CreateRow> =>
    inTransaction(client, async () => {
      const { rows } = await client.query<CreateRow>(
        `SELECT * FROM jale_cap.problem_report_create_unverified($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [args.clientKey, args.roleClaimed, args.category, args.description, args.stopsWork, args.locale,
          args.contact, args.includeTechnical, args.context === null ? null : JSON.stringify(args.context),
          args.tokenHash, args.addressHash],
      );
      return rows[0];
    });

  const createUnverified = (overrides: Partial<UnverifiedArgs> = {}) => callUnverified(pub, unverifiedArgs(overrides));

  const call = async <T>(client: Client, sql: string, params: unknown[] = []): Promise<T[]> =>
    inTransaction(client, async () => (await client.query(sql, params)).rows as T[]);

  const one = async <T>(client: Client, sql: string, params: unknown[] = []): Promise<T> => (await call<T>(client, sql, params))[0];

  async function insertUser(userType: 'worker' | 'employer', contact: { email?: string; phone?: string } = {}) {
    const sub = randomUUID();
    const { rows } = await su.query<{ id: string }>(
      'INSERT INTO public.users (cognito_sub, user_type, email, phone, full_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [sub, userType, contact.email ?? null, contact.phone ?? null, 'Fixture Reporter'],
    );
    userIds.push(rows[0].id);
    return { id: rows[0].id, sub };
  }

  async function resetReports(): Promise<void> {
    await su.query('DELETE FROM public.problem_reports');
    await su.query('DELETE FROM public.problem_report_rate_buckets');
    await su.query("DELETE FROM public.email_outbox WHERE source_type = 'problem_report'");
    await su.query(
      `UPDATE public.problem_report_settings
          SET reporting_enabled = true, signed_out_enabled = true, screenshots_enabled = true,
              team_email_enabled = true, signed_out_daily_cap = 200, team_recipient = NULL,
              admin_base_url = NULL, updated_by_admin = NULL, updated_at = now()`,
    );
  }

  const setSettings = (sql: string, params: unknown[] = []) =>
    su.query(`UPDATE public.problem_report_settings SET ${sql}`, params);

  /** Waits out the last seconds of the current UTC hour or day, so a limit test never straddles two windows. */
  async function awayFromBoundary(unit: 'hour' | 'day'): Promise<void> {
    const { rows } = await su.query<{ left: number }>(
      `SELECT extract(epoch FROM pg_catalog.date_trunc($1, now(), 'UTC') + ('1 ' || $1)::interval - now())::float8 AS left`,
      [unit],
    );
    if (rows[0].left < 10) await new Promise((resolve) => setTimeout(resolve, (rows[0].left + 1) * 1000));
  }

  /** Moves a report's creation time back by `age` (header and contents). */
  async function age(reportId: string, ageText: string): Promise<void> {
    await su.query('UPDATE public.problem_reports SET created_at = now() - $2::interval WHERE id = $1', [reportId, ageText]);
    await su.query('UPDATE public.problem_report_contents SET created_at = now() - $2::interval WHERE report_id = $1', [reportId, ageText]);
  }

  const header = async (reportId: string) => (await su.query('SELECT * FROM public.problem_reports WHERE id = $1', [reportId])).rows[0];
  const contents = async (reportId: string) =>
    (await su.query('SELECT * FROM public.problem_report_contents WHERE report_id = $1', [reportId])).rows[0];
  const outboxRows = async () =>
    (await su.query("SELECT * FROM public.email_outbox WHERE source_type = 'problem_report' ORDER BY created_at, id")).rows;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    api = loginClient('jale_api');
    pub = loginClient('jale_api_public_reports');
    console_ = loginClient('jale_admin_console');
    await Promise.all([api.connect(), pub.connect(), console_.connect()]);
  });

  beforeEach(async () => {
    await resetReports();
  });

  afterAll(async () => {
    await resetReports();
    await su.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [userIds]);
    await Promise.all([api.end(), pub.end(), console_.end()]);
    await su.end();
  });

  describe('problem_report_config', () => {
    it('returns the three pause switches the web form reads', async () => {
      expect(await one(pub, 'SELECT * FROM jale_cap.problem_report_config()'))
        .toEqual({ reporting: true, signed_out: true, screenshots: true });
      await setSettings('signed_out_enabled = false, screenshots_enabled = false');
      expect(await one(pub, 'SELECT * FROM jale_cap.problem_report_config()'))
        .toEqual({ reporting: true, signed_out: false, screenshots: false });
    });
  });

  describe('problem_report_create_verified', () => {
    it('creates a report for the caller with an account: role from the account, content linked to it', async () => {
      const employer = await insertUser('employer');
      const args = verifiedArgs({ roleHint: 'worker', category: 'billing', stopsWork: true, locale: 'en', includeTechnical: false });
      const row = await callVerified(api, employer.sub, args);
      expect(row).toEqual({ outcome: 'ok', report_id: expect.any(String), report_number: expect.any(String), replayed: false, email_queued: false });
      expect(Number(row.report_number)).toBeGreaterThanOrEqual(1000);
      expect(await header(row.report_id!)).toMatchObject({
        report_number: row.report_number, client_key: args.clientKey, role: 'employer', verified: true, category: 'billing',
        stops_work: true, locale: 'en', include_technical: false, status: 'new', has_image: false,
        status_changed_at: null, content_erased_at: null, image_deleted_at: null,
      });
      const c = await contents(row.report_id!);
      expect(c).toMatchObject({
        reporter_user_id: employer.id, reporter_sub: null, description: args.description, typed_contact: null,
        context: CONTEXT, internal_note: null, attach_token_hash: args.tokenHash,
        pending_upload_key: null, image_key: null,
      });
      expect(c.created_at).toEqual((await header(row.report_id!)).created_at);
    });

    it('creates a report for a sign-in with no account yet: linked by sub, role from the hint', async () => {
      const sub = randomUUID();
      const row = await createVerified(sub, { roleHint: 'employer', category: 'account' });
      expect(row.outcome).toBe('ok');
      expect(await header(row.report_id!)).toMatchObject({ role: 'employer', verified: true, category: 'account' });
      expect(await contents(row.report_id!)).toMatchObject({ reporter_user_id: null, reporter_sub: sub });
    });

    it('keeps the stops-work answer for employers only', async () => {
      const worker = await insertUser('worker');
      const row = await createVerified(worker.sub, { stopsWork: true });
      expect((await header(row.report_id!)).stops_work).toBeNull();
    });

    it('numbers reports from the shared sequence, one apart', async () => {
      const first = await createVerified(randomUUID());
      const second = await createVerified(randomUUID());
      expect(Number(second.report_number)).toBe(Number(first.report_number) + 1);
    });

    it('raises 42501 when the caller context is unset or empty', async () => {
      expect(await sqlState(() => createVerified(null))).toBe('42501');
      expect(await sqlState(() => createVerified(''))).toBe('42501');
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_reports')).rows[0].n).toBe(0);
    });

    it.each<[string, Partial<VerifiedArgs>]>([
      ['a missing client key', { clientKey: null }],
      ['a role hint outside worker, employer and unknown', { roleHint: 'admin' }],
      ['an empty description', { description: '' }],
      ['a description over 2000 characters', { description: 'x'.repeat(2001) }],
      ['a locale other than es and en', { locale: 'fr' }],
      ['a missing technical-details flag', { includeTechnical: null }],
      ['a context that is not an object', { context: [1, 2] }],
      ['a context over 32 KB', { context: { blob: 'x'.repeat(40000) } }],
      ['a malformed attach token hash', { tokenHash: 'not-a-hash' }],
    ])('raises 22023 for %s', async (_label, overrides) => {
      expect(await sqlState(() => createVerified(randomUUID(), overrides))).toBe('22023');
    });

    it('accepts the unknown hint and lets an existing worker account decide the role', async () => {
      const worker = await insertUser('worker');
      const row = await createVerified(worker.sub, { roleHint: 'unknown', category: 'finding_jobs' });
      expect(row.outcome).toBe('ok');
      expect(await header(row.report_id!)).toMatchObject({ role: 'worker', verified: true, category: 'finding_jobs' });
    });

    it('accepts the unknown hint and lets an existing employer account decide the role', async () => {
      const employer = await insertUser('employer');
      const row = await createVerified(employer.sub, { roleHint: 'unknown', category: 'billing' });
      expect(row.outcome).toBe('ok');
      expect(await header(row.report_id!)).toMatchObject({ role: 'employer', verified: true, category: 'billing' });
    });

    it('answers role_unknown for the unknown hint with no account, writing nothing and spending no limit', async () => {
      const sub = randomUUID();
      const row = await createVerified(sub, { roleHint: 'unknown' });
      expect(row).toEqual({ outcome: 'role_unknown', report_id: null, report_number: null, replayed: false, email_queued: null });
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_reports')).rows[0].n).toBe(0);
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_report_contents')).rows[0].n).toBe(0);
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_report_rate_buckets')).rows[0].n).toBe(0);
      // Twenty more attempts do not use up the account limit.
      for (let i = 0; i < 20; i += 1) expect((await createVerified(sub, { roleHint: 'unknown' })).outcome).toBe('role_unknown');
      expect((await createVerified(sub, { roleHint: 'worker' })).outcome).toBe('ok');
    });

    it('accepts exactly 2000 characters', async () => {
      expect((await createVerified(randomUUID(), { description: 'y'.repeat(2000) })).outcome).toBe('ok');
    });

    it('refuses a category from the other role, or none, as invalid_category', async () => {
      const worker = await insertUser('worker');
      expect((await createVerified(worker.sub, { category: 'billing' })).outcome).toBe('invalid_category');
      expect((await createVerified(worker.sub, { category: null })).outcome).toBe('invalid_category');
      expect((await createVerified(randomUUID(), { roleHint: 'employer', category: 'whatsapp' })).outcome).toBe('invalid_category');
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_reports')).rows[0].n).toBe(0);
    });

    it('refuses while reporting is paused', async () => {
      await setSettings('reporting_enabled = false');
      expect(await createVerified(randomUUID()))
        .toEqual({ outcome: 'reporting_paused', report_id: null, report_number: null, replayed: false, email_queued: null });
    });

    it('allows 20 reports per account in 24 hours and refuses the 21st, counting by account and by sign-in', async () => {
      const late = await insertUser('worker');
      // Ten sent before the account existed (linked by sub), ten after.
      await su.query('DELETE FROM public.users WHERE id = $1', [late.id]);
      for (let i = 0; i < 10; i += 1) expect((await createVerified(late.sub)).outcome).toBe('ok');
      await su.query("INSERT INTO public.users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')", [late.id, late.sub]);
      for (let i = 0; i < 10; i += 1) expect((await createVerified(late.sub)).outcome).toBe('ok');
      expect((await createVerified(late.sub)).outcome).toBe('rate_limited');
      // Another account is not affected.
      expect((await createVerified(randomUUID())).outcome).toBe('ok');
    });

    it('does not count reports older than 24 hours toward the account limit', async () => {
      const worker = await insertUser('worker');
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) ids.push((await createVerified(worker.sub)).report_id!);
      expect((await createVerified(worker.sub)).outcome).toBe('rate_limited');
      await age(ids[0], '25 hours');
      expect((await createVerified(worker.sub)).outcome).toBe('ok');
    });

    it('replays a repeated client key from the same caller: same report, rotated token, nothing new queued', async () => {
      await setSettings('team_recipient = $1, admin_base_url = $2', [TEAM_RECIPIENT, ADMIN_BASE_URL]);
      const worker = await insertUser('worker');
      const first = await createVerified(worker.sub, { clientKey: randomUUID() });
      const key = (await header(first.report_id!)).client_key;
      const rotated = tokenHash();
      const again = await createVerified(worker.sub, { clientKey: key, tokenHash: rotated, description: 'Different words.' });
      expect(again).toEqual({ outcome: 'ok', report_id: first.report_id, report_number: first.report_number, replayed: true, email_queued: null });
      expect(await contents(first.report_id!)).toMatchObject({ attach_token_hash: rotated, description: 'The apply button does nothing when I tap it.' });
      expect((await su.query('SELECT count(*)::int AS n FROM public.problem_reports')).rows[0].n).toBe(1);
      expect(await outboxRows()).toHaveLength(1);
    });

    it('replays across the moment the account is created (first linked by sub, then by account)', async () => {
      const sub = randomUUID();
      const first = await createVerified(sub, { roleHint: 'worker' });
      const key = (await header(first.report_id!)).client_key;
      userIds.push((await su.query<{ id: string }>("INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id", [sub])).rows[0].id);
      expect(await createVerified(sub, { clientKey: key })).toMatchObject({ outcome: 'ok', report_id: first.report_id, replayed: true });
    });

    it("refuses another caller's key as invalid_request and changes nothing", async () => {
      const owner = await insertUser('worker');
      const first = await createVerified(owner.sub);
      const before = await contents(first.report_id!);
      const key = (await header(first.report_id!)).client_key;
      expect(await createVerified(randomUUID(), { clientKey: key }))
        .toEqual({ outcome: 'invalid_request', report_id: null, report_number: null, replayed: false, email_queued: null });
      expect(await contents(first.report_id!)).toEqual(before);
    });

    it("refuses a signed-out report's key as invalid_request", async () => {
      const unverified = await createUnverified();
      const key = (await header(unverified.report_id!)).client_key;
      expect((await createVerified(randomUUID(), { clientKey: key })).outcome).toBe('invalid_request');
    });

    it('refuses a key whose report is past the 24-hour window as invalid_request, never a unique violation', async () => {
      const worker = await insertUser('worker');
      const first = await createVerified(worker.sub);
      const key = (await header(first.report_id!)).client_key;
      await age(first.report_id!, '25 hours');
      expect((await createVerified(worker.sub, { clientKey: key })).outcome).toBe('invalid_request');
    });

    it('two concurrent sends with one key create one report; the second replays', async () => {
      const worker = await insertUser('worker');
      const args = verifiedArgs();
      const a = loginClient('jale_api');
      const b = loginClient('jale_api');
      await Promise.all([a.connect(), b.connect()]);
      try {
        await a.query('BEGIN');
        await a.query("SELECT pg_catalog.set_config('app.current_user_id', $1, true)", [worker.sub]);
        const first = (await a.query<CreateRow>(
          'SELECT * FROM jale_cap.problem_report_create_verified($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [args.clientKey, args.roleHint, args.category, args.description, args.stopsWork, args.locale,
            args.includeTechnical, JSON.stringify(args.context), args.tokenHash],
        )).rows[0];
        // The second send starts while the first is still open, and waits for it.
        const second = callVerified(b, worker.sub, { ...args, tokenHash: tokenHash() });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await a.query('COMMIT');
        const replay = await second;
        expect(first).toMatchObject({ outcome: 'ok', replayed: false });
        expect(replay).toMatchObject({ outcome: 'ok', report_id: first.report_id, report_number: first.report_number, replayed: true });
        expect((await su.query('SELECT count(*)::int AS n FROM public.problem_reports WHERE client_key = $1', [args.clientKey])).rows[0].n).toBe(1);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    });
  });

  describe('problem_report_create_unverified', () => {
    it('creates an unverified report with the contact kept exactly as typed and no account link', async () => {
      const args = unverifiedArgs({ roleClaimed: 'employer', category: 'job_posting', stopsWork: false, contact: ` ${TYPED_EMAIL} ` });
      const row = await callUnverified(pub, args);
      expect(row).toEqual({ outcome: 'ok', report_id: expect.any(String), report_number: expect.any(String), replayed: false, email_queued: false });
      expect(await header(row.report_id!)).toMatchObject({ role: 'employer', verified: false, category: 'job_posting', stops_work: false });
      expect(await contents(row.report_id!)).toMatchObject({
        reporter_user_id: null, reporter_sub: null, typed_contact: ` ${TYPED_EMAIL} `, attach_token_hash: args.tokenHash,
      });
      const buckets = (await su.query('SELECT window_kind, request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 ORDER BY window_kind', [args.addressHash])).rows;
      expect(buckets).toEqual([{ window_kind: 'day', request_count: 1 }, { window_kind: 'hour', request_count: 1 }]);
    });

    it('stores a blank contact as none, and a page with no role uses the worker list', async () => {
      const row = await createUnverified({ roleClaimed: 'unknown', category: 'uploads', contact: '   ' });
      expect(await header(row.report_id!)).toMatchObject({ role: 'unknown', verified: false });
      expect((await contents(row.report_id!)).typed_contact).toBeNull();
      expect((await createUnverified({ roleClaimed: 'unknown', category: 'billing' })).outcome).toBe('invalid_category');
    });

    it.each<[string, Partial<UnverifiedArgs>]>([
      ['a claimed role outside worker, employer and unknown', { roleClaimed: 'admin' }],
      ['a contact over 200 characters', { contact: 'c'.repeat(201) }],
      ['a malformed address hash', { addressHash: 'abc' }],
      ['a missing address hash', { addressHash: null }],
      ['a missing description', { description: null }],
    ])('raises 22023 for %s', async (_label, overrides) => {
      expect(await sqlState(() => createUnverified(overrides))).toBe('22023');
    });

    it('refuses while reporting, or signed-out reporting, is paused', async () => {
      await setSettings('signed_out_enabled = false');
      expect((await createUnverified()).outcome).toBe('signed_out_paused');
      await setSettings('reporting_enabled = false');
      expect((await createUnverified()).outcome).toBe('reporting_paused');
    });

    it('allows 5 reports an hour per address and refuses the 6th, which still counts', async () => {
      await awayFromBoundary('hour');
      const address = addressHash();
      for (let i = 0; i < 5; i += 1) expect((await createUnverified({ addressHash: address })).outcome).toBe('ok');
      expect((await createUnverified({ addressHash: address })).outcome).toBe('rate_limited');
      const hour = await su.query("SELECT request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 AND window_kind = 'hour'", [address]);
      expect(hour.rows[0].request_count).toBe(6);
      expect((await createUnverified()).outcome).toBe('ok');
    }, 30_000);

    it('allows 20 reports a day per address and refuses the 21st', async () => {
      await awayFromBoundary('day');
      const address = addressHash();
      await su.query(
        `INSERT INTO public.problem_report_rate_buckets (address_hash, window_kind, bucket_start, request_count)
         VALUES ($1, 'day', date_trunc('day', now(), 'UTC'), 19)`,
        [address],
      );
      expect((await createUnverified({ addressHash: address })).outcome).toBe('ok');
      expect((await createUnverified({ addressHash: address })).outcome).toBe('rate_limited');
    }, 30_000);

    it('applies the daily signed-out cap to every address together, counting signed-out reports since 00:00 UTC', async () => {
      await awayFromBoundary('day');
      await setSettings('signed_out_daily_cap = 3');
      // Neither a signed-in report nor one from before midnight UTC counts.
      await createVerified(randomUUID());
      const yesterday = await createUnverified();
      await su.query("UPDATE public.problem_reports SET created_at = date_trunc('day', now(), 'UTC') - interval '1 minute' WHERE id = $1", [yesterday.report_id]);
      for (let i = 0; i < 3; i += 1) expect((await createUnverified()).outcome).toBe('ok');
      expect(await createUnverified())
        .toEqual({ outcome: 'rate_limited_global', report_id: null, report_number: null, replayed: false, email_queued: null });
      await setSettings('signed_out_daily_cap = 0');
      expect((await createUnverified()).outcome).toBe('rate_limited_global');
    }, 30_000);

    it('replays a signed-out key without spending a rate-limit slot, and refuses a signed-in report key', async () => {
      const address = addressHash();
      const first = await createUnverified({ addressHash: address });
      const key = (await header(first.report_id!)).client_key;
      const again = await createUnverified({ clientKey: key, addressHash: address });
      expect(again).toEqual({ outcome: 'ok', report_id: first.report_id, report_number: first.report_number, replayed: true, email_queued: null });
      const hour = await su.query("SELECT request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 AND window_kind = 'hour'", [address]);
      expect(hour.rows[0].request_count).toBe(1);
      const verified = await createVerified(randomUUID());
      const verifiedKey = (await header(verified.report_id!)).client_key;
      expect((await createUnverified({ clientKey: verifiedKey })).outcome).toBe('invalid_request');
    });
  });

  describe('team email', () => {
    it('queues one fixed-template email per report: number, category and link, no personal details', async () => {
      await setSettings('team_recipient = $1, admin_base_url = $2', [TEAM_RECIPIENT, ADMIN_BASE_URL]);
      const worker = await insertUser('worker');
      const description = 'My secret words that must never reach an email.';
      const row = await createVerified(worker.sub, { category: 'sign_in', description });
      expect(row).toMatchObject({ outcome: 'ok', email_queued: true });
      const [email] = await outboxRows();
      const number = `JR-${row.report_number}`;
      const link = `${ADMIN_BASE_URL}/reports/${row.report_id}`;
      expect(email).toMatchObject({
        recipient_email: TEAM_RECIPIENT,
        subject: `New report ${number} ${MIDDLE_DOT} I can't sign in / the code didn't arrive`,
        source_type: 'problem_report',
        source_id: row.report_id,
        idempotency_key: `problem-report:${row.report_id}`,
        status: 'pending',
        attempt_count: 0,
      });
      expect(email.body_text).toContain('A new problem report is waiting in the dashboard.');
      expect(email.body_text).toContain(number);
      expect(email.body_text).toContain(link);
      expect(email.body_text).toContain('This email has no personal details. Sign in to the dashboard to read the report.');
      expect(email.body_html).toContain(`href="${link}"`);
      expect(email.body_html).toContain('I can&#39;t sign in / the code didn&#39;t arrive');
      expect(email.body_html).not.toContain("I can't");
      for (const body of [email.subject, email.body_text, email.body_html]) {
        expect(body).not.toContain(description);
        expect(body).not.toContain('secret');
      }
    });

    it('queues for a signed-out report too, without the typed contact', async () => {
      await setSettings('team_recipient = $1, admin_base_url = $2', [TEAM_RECIPIENT, ADMIN_BASE_URL]);
      const row = await createUnverified({ contact: TYPED_EMAIL, category: 'other' });
      expect(row).toMatchObject({ outcome: 'ok', email_queued: true });
      const [email] = await outboxRows();
      expect(email.subject).toBe(`New report JR-${row.report_number} ${MIDDLE_DOT} Something else`);
      for (const body of [email.body_text, email.body_html]) expect(body).not.toContain(TYPED_EMAIL);
    });

    // email_queued: true when a row was queued; false when the team email is
    // on but nothing could be queued (no recipient or no dashboard address
    // yet); NULL when the team email is switched off on purpose.
    it.each<[string, string, unknown[], boolean | null]>([
      ['no recipient is set', 'admin_base_url = $1', [ADMIN_BASE_URL], false],
      ['no dashboard address is set', 'team_recipient = $1', [TEAM_RECIPIENT], false],
      ['the team email is switched off', 'team_recipient = $1, admin_base_url = $2, team_email_enabled = false',
        [TEAM_RECIPIENT, ADMIN_BASE_URL], null],
    ])('queues nothing, and still creates the report, when %s', async (_label, sql, params, queued) => {
      await setSettings(sql, params);
      expect(await createVerified(randomUUID())).toMatchObject({ outcome: 'ok', email_queued: queued });
      expect(await createUnverified()).toMatchObject({ outcome: 'ok', email_queued: queued });
      expect(await outboxRows()).toEqual([]);
    });

    it('reports email_queued as true, false or NULL for the three team-email states', async () => {
      const states: Array<boolean | null> = [];
      await setSettings('team_email_enabled = false');
      states.push((await createVerified(randomUUID())).email_queued);
      await setSettings('team_email_enabled = true');
      states.push((await createVerified(randomUUID())).email_queued);
      await setSettings('team_recipient = $1, admin_base_url = $2', [TEAM_RECIPIENT, ADMIN_BASE_URL]);
      states.push((await createVerified(randomUUID())).email_queued);
      expect(states).toEqual([null, false, true]);
      expect(await outboxRows()).toHaveLength(1);
    });
  });

  describe('image upload and attach', () => {
    async function freshReport(client: Client = pub) {
      const token = tokenHash();
      const row = client === pub ? await createUnverified({ tokenHash: token }) : await createVerified(randomUUID(), { tokenHash: token });
      return { id: row.report_id!, token };
    }
    const grant = (client: Client, id: string, token: string, type = 'image/png') =>
      one<{ outcome: string; upload_key: string | null }>(client, 'SELECT * FROM jale_cap.problem_report_upload_grant($1, $2, $3)', [id, token, type]);
    const pending = (client: Client, id: string, token: string) =>
      one<{ outcome: string; pending_key: string | null; content_type: string | null }>(client, 'SELECT * FROM jale_cap.problem_report_pending_upload($1, $2)', [id, token]);
    /** The upload's own id: the uuid in incoming/<uuid>. */
    const uploadOf = (pendingKey: string) => pendingKey.slice('incoming/'.length);
    /** The final key an upload is copied to: images/<report>/<upload>.<ext>. */
    const finalKeyOf = (id: string, pendingKey: string, ext = 'png') => `images/${id}/${uploadOf(pendingKey)}.${ext}`;
    const attach = (client: Client, id: string, token: string, o: { pendingKey: string; finalKey?: string; type?: string; size?: number }) =>
      one<{ outcome: string }>(client, 'SELECT * FROM jale_cap.problem_report_attach($1, $2, $3, $4, $5, $6)',
        [id, token, o.pendingKey, o.finalKey ?? finalKeyOf(id, o.pendingKey), o.type ?? 'image/png', o.size ?? 1024]);

    it('issues an upload key generated in the database, records it, and replaces it on re-issue', async () => {
      const { id, token } = await freshReport();
      const first = await grant(pub, id, token, 'image/webp');
      expect(first.outcome).toBe('ok');
      expect(first.upload_key).toMatch(/^incoming\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(await contents(id)).toMatchObject({ pending_upload_key: first.upload_key, pending_content_type: 'image/webp' });
      const second = await grant(pub, id, token, 'image/jpeg');
      expect(second.upload_key).not.toBe(first.upload_key);
      expect(await contents(id)).toMatchObject({ pending_upload_key: second.upload_key, pending_content_type: 'image/jpeg' });
    });

    it('answers an unknown report and a wrong token the same way, and changes nothing', async () => {
      const { id } = await freshReport();
      const before = await contents(id);
      expect(await grant(pub, id, tokenHash())).toEqual({ outcome: 'not_found', upload_key: null });
      expect(await grant(pub, randomUUID(), tokenHash())).toEqual({ outcome: 'not_found', upload_key: null });
      expect(await pending(pub, id, tokenHash())).toEqual({ outcome: 'not_found', pending_key: null, content_type: null });
      expect(await contents(id)).toEqual(before);
    });

    it('refuses a type other than JPEG, PNG or WebP', async () => {
      const { id, token } = await freshReport();
      expect(await grant(pub, id, token, 'image/gif')).toEqual({ outcome: 'invalid_type', upload_key: null });
      expect(await grant(pub, id, token, 'image/svg+xml')).toEqual({ outcome: 'invalid_type', upload_key: null });
    });

    it('refuses while screenshots, or reporting, are paused', async () => {
      const { id, token } = await freshReport();
      await setSettings('screenshots_enabled = false');
      expect((await grant(pub, id, token)).outcome).toBe('screenshots_paused');
      await setSettings('screenshots_enabled = true, reporting_enabled = false');
      expect((await grant(pub, id, token)).outcome).toBe('screenshots_paused');
    });

    it('issues uploads only within 30 minutes of the report', async () => {
      const young = await freshReport();
      await age(young.id, '29 minutes');
      expect((await grant(pub, young.id, young.token)).outcome).toBe('ok');
      const old = await freshReport();
      await age(old.id, '31 minutes');
      expect((await grant(pub, old.id, old.token)).outcome).toBe('upload_expired');
    });

    it('pre-checks an issued upload for 15 minutes', async () => {
      const { id, token } = await freshReport();
      expect((await pending(pub, id, token)).outcome).toBe('upload_expired');
      const issued = await grant(pub, id, token, 'image/jpeg');
      expect(await pending(pub, id, token)).toEqual({ outcome: 'ok', pending_key: issued.upload_key, content_type: 'image/jpeg' });
      await su.query("UPDATE public.problem_report_contents SET upload_issued_at = now() - interval '14 minutes' WHERE report_id = $1", [id]);
      expect((await pending(pub, id, token)).outcome).toBe('ok');
      await su.query("UPDATE public.problem_report_contents SET upload_issued_at = now() - interval '16 minutes' WHERE report_id = $1", [id]);
      expect((await pending(pub, id, token)).outcome).toBe('upload_expired');
      await su.query("UPDATE public.problem_report_contents SET upload_issued_at = now() WHERE report_id = $1", [id]);
      await setSettings('screenshots_enabled = false');
      expect((await pending(pub, id, token)).outcome).toBe('screenshots_paused');
    });

    it('attaches once: sets the image and clears the upload; the same token is then already attached, any other unknown', async () => {
      const { id, token } = await freshReport();
      const issued = await grant(pub, id, token);
      expect(await attach(pub, id, token, { pendingKey: issued.upload_key! })).toEqual({ outcome: 'ok' });
      expect(await contents(id)).toMatchObject({
        image_key: finalKeyOf(id, issued.upload_key!), pending_upload_key: null, pending_content_type: null,
        upload_issued_at: null, attach_token_hash: token,
      });
      expect(await header(id)).toMatchObject({ has_image: true });
      // A retry with the same token (an attach that succeeded but timed out in
      // the browser) is told the image is there, by all three functions. The
      // attach retry names the attached image itself.
      expect(await attach(pub, id, token, { pendingKey: issued.upload_key! })).toEqual({ outcome: 'already_attached' });
      expect(await grant(pub, id, token)).toEqual({ outcome: 'already_attached', upload_key: null });
      expect(await pending(pub, id, token)).toEqual({ outcome: 'already_attached', pending_key: null, content_type: null });
      // The same token with any other final key is a stale upload: expired, so its copy is removed.
      expect(await attach(pub, id, token, { pendingKey: issued.upload_key!, finalKey: finalKeyOf(id, `incoming/${randomUUID()}`) }))
        .toEqual({ outcome: 'upload_expired' });
      // Any other token is unknown.
      const other = tokenHash();
      expect(await attach(pub, id, other, { pendingKey: issued.upload_key! })).toEqual({ outcome: 'not_found' });
      expect(await grant(pub, id, other)).toEqual({ outcome: 'not_found', upload_key: null });
      expect(await pending(pub, id, other)).toEqual({ outcome: 'not_found', pending_key: null, content_type: null });
      expect(await contents(id)).toMatchObject({ image_key: finalKeyOf(id, issued.upload_key!), attach_token_hash: token });
    });

    it('refuses a second image after a replay rotates the token: already_attached', async () => {
      const token = tokenHash();
      const args = unverifiedArgs({ tokenHash: token });
      const row = await callUnverified(pub, args);
      const id = row.report_id!;
      const issued = await grant(pub, id, token);
      expect((await attach(pub, id, token, { pendingKey: issued.upload_key! })).outcome).toBe('ok');
      const rotated = tokenHash();
      expect((await callUnverified(pub, { ...args, tokenHash: rotated })).replayed).toBe(true);
      expect((await grant(pub, id, rotated)).outcome).toBe('already_attached');
      expect((await pending(pub, id, rotated)).outcome).toBe('already_attached');
      expect((await attach(pub, id, rotated, { pendingKey: issued.upload_key! })).outcome).toBe('already_attached');
      // The token the replay replaced is unknown now.
      expect((await grant(pub, id, token)).outcome).toBe('not_found');
    });

    it.each<[string, string, (id: string, upload: string) => { finalKey?: string; type?: string; size?: number }]>([
      ['the final key of this upload', 'ok', (id, upload) => ({ finalKey: `images/${id}/${upload}.png` })],
      ['a final key for another report', 'invalid_image', (_id, upload) => ({ finalKey: `images/${randomUUID()}/${upload}.png` })],
      ['a final key carrying another upload', 'invalid_image', (id) => ({ finalKey: `images/${id}/${randomUUID()}.png` })],
      ['a final key in the old one-per-report shape', 'invalid_image', (id) => ({ finalKey: `images/${id}.png` })],
      ['a final key with another extension', 'invalid_image', (id, upload) => ({ finalKey: `images/${id}/${upload}.jpg` })],
      ['a type other than the issued one', 'invalid_image', (id, upload) => ({ finalKey: `images/${id}/${upload}.jpg`, type: 'image/jpeg' })],
      ['an empty object', 'invalid_image', () => ({ size: 0 })],
      ['an object over 5 MiB', 'invalid_image', () => ({ size: 5242881 })],
      ['an object of exactly 5 MiB', 'ok', () => ({ size: 5242880 })],
      ['an object of 1 byte', 'ok', () => ({ size: 1 })],
    ])('attach with %s gives %s', async (_label, expected, build) => {
      const { id, token } = await freshReport();
      const issued = await grant(pub, id, token);
      const upload = uploadOf(issued.upload_key!);
      expect((await attach(pub, id, token, { pendingKey: issued.upload_key!, ...build(id, upload) })).outcome).toBe(expected);
      if (expected !== 'ok') expect(await contents(id)).toMatchObject({ image_key: null, pending_upload_key: issued.upload_key, attach_token_hash: token });
    });

    it('an earlier upload racing a re-issue never replaces the attached image, and its own key is never the image', async () => {
      const { id, token } = await freshReport();
      const old = await grant(pub, id, token);
      const current = await grant(pub, id, token);
      expect((await attach(pub, id, token, { pendingKey: current.upload_key! })).outcome).toBe('ok');
      // The earlier upload's attempt is refused as expired, so its own copy is
      // removed; the image stays the current one.
      expect((await attach(pub, id, token, { pendingKey: old.upload_key! })).outcome).toBe('upload_expired');
      expect(finalKeyOf(id, old.upload_key!)).not.toBe(finalKeyOf(id, current.upload_key!));
      expect((await contents(id)).image_key).toBe(finalKeyOf(id, current.upload_key!));
    });

    it('refuses an attach for an upload that was re-issued, has expired, or was paused since', async () => {
      const { id, token } = await freshReport();
      const first = await grant(pub, id, token);
      const second = await grant(pub, id, token);
      expect((await attach(pub, id, token, { pendingKey: first.upload_key! })).outcome).toBe('upload_expired');
      await su.query("UPDATE public.problem_report_contents SET upload_issued_at = now() - interval '16 minutes' WHERE report_id = $1", [id]);
      expect((await attach(pub, id, token, { pendingKey: second.upload_key! })).outcome).toBe('upload_expired');
      await su.query("UPDATE public.problem_report_contents SET upload_issued_at = now() WHERE report_id = $1", [id]);
      await setSettings('screenshots_enabled = false');
      expect((await attach(pub, id, token, { pendingKey: second.upload_key! })).outcome).toBe('screenshots_paused');
      expect((await contents(id)).image_key).toBeNull();
    });

    it('serves the signed-in path on jale_api with the same rules', async () => {
      const { id, token } = await freshReport(api);
      const issued = await grant(api, id, token, 'image/jpeg');
      expect(await pending(api, id, token)).toMatchObject({ outcome: 'ok', content_type: 'image/jpeg' });
      expect(await attach(api, id, token, { pendingKey: issued.upload_key!, finalKey: finalKeyOf(id, issued.upload_key!, 'jpg'), type: 'image/jpeg' }))
        .toEqual({ outcome: 'ok' });
    });
  });

  describe('admin console', () => {
    const inbox = (filters: { status?: string; role?: string; category?: string; verified?: boolean; number?: string; limit?: number | null; before?: Date } = {}) =>
      call<Record<string, unknown>>(console_, 'SELECT * FROM jale_cap.problem_report_inbox($1, $2, $3, $4, $5, $6, $7)', [
        filters.status ?? null, filters.role ?? null, filters.category ?? null, filters.verified ?? null,
        filters.number ?? null, filters.limit === undefined ? 50 : filters.limit, filters.before ?? null,
      ]);
    const detail = (id: string) => one<Record<string, unknown>>(console_, 'SELECT * FROM jale_cap.problem_report_detail($1)', [id]);

    it('lists headers newest first, with no words and no contact, and filters', async () => {
      const worker = await createVerified(randomUUID(), { roleHint: 'worker', category: 'applying' });
      const employer = await createVerified(randomUUID(), { roleHint: 'employer', category: 'billing' });
      const signedOut = await createUnverified({ category: 'sign_in' });
      await age(worker.report_id!, '2 hours');
      await age(employer.report_id!, '1 hour');
      const rows = await inbox();
      expect(rows.map((r) => r.report_id)).toEqual([signedOut.report_id, employer.report_id, worker.report_id]);
      expect(Object.keys(rows[0]).sort()).toEqual([
        'category', 'content_erased', 'created_at', 'has_image', 'report_id', 'report_number', 'role', 'status', 'stops_work', 'verified',
      ]);
      expect((await inbox({ role: 'employer' })).map((r) => r.report_id)).toEqual([employer.report_id]);
      expect((await inbox({ verified: false })).map((r) => r.report_id)).toEqual([signedOut.report_id]);
      expect((await inbox({ category: 'applying' })).map((r) => r.report_id)).toEqual([worker.report_id]);
      expect((await inbox({ number: employer.report_number! })).map((r) => r.report_id)).toEqual([employer.report_id]);
      expect((await inbox({ status: 'fixed' }))).toEqual([]);
      const employerAt = (await header(employer.report_id!)).created_at as Date;
      expect((await inbox({ before: employerAt })).map((r) => r.report_id)).toEqual([worker.report_id]);
      expect((await inbox({ limit: 1 })).map((r) => r.report_id)).toEqual([signedOut.report_id]);
    });

    it('caps the page at 200, defaults it to 50, and raises 22023 below 1', async () => {
      for (let i = 0; i < 55; i += 1) await createVerified(randomUUID());
      expect(await inbox({ limit: null })).toHaveLength(50);
      expect(await inbox({ limit: 500 })).toHaveLength(55);
      expect(await sqlState(() => inbox({ limit: 0 }))).toBe('22023');
    });

    it('counts new and open reports for the navigation badge', async () => {
      const a = await createVerified(randomUUID());
      const b = await createVerified(randomUUID());
      await createVerified(randomUUID());
      await call(console_, "SELECT * FROM jale_cap.problem_report_set_status($1, 'looking')", [a.report_id]);
      await call(console_, "SELECT * FROM jale_cap.problem_report_set_status($1, 'fixed')", [b.report_id]);
      expect(await one(console_, 'SELECT * FROM jale_cap.problem_report_counts()')).toEqual({ new_count: 1, open_count: 2 });
    });

    it('shows a signed-in report with the account contact masked in SQL: a phone for workers, an email for employers', async () => {
      const worker = await insertUser('worker', { phone: TYPED_PHONE, email: TYPED_EMAIL });
      const employer = await insertUser('employer', { phone: TYPED_PHONE, email: TYPED_EMAIL });
      const w = await createVerified(worker.sub, { stopsWork: null });
      const e = await createVerified(employer.sub, { category: 'billing', stopsWork: true });
      expect(await detail(w.report_id!)).toMatchObject({
        report_id: w.report_id, report_number: w.report_number, role: 'worker', verified: true, category: 'applying',
        locale: 'es', include_technical: true, status: 'new', has_image: false, content_erased: false,
        description: 'The apply button does nothing when I tap it.', context: CONTEXT, internal_note: null,
        contact_kind: 'account', contact_masked: '+1 555 *** 0199', account_user_id: worker.id, account_exists: true,
        image_available: false,
      });
      expect(await detail(e.report_id!)).toMatchObject({
        role: 'employer', stops_work: true, contact_kind: 'account', contact_masked: MASKED_EMAIL,
        account_user_id: employer.id, account_exists: true,
      });
    });

    it('shows a sign-in without an account as unlinked, and links it once the account exists', async () => {
      const sub = randomUUID();
      const row = await createVerified(sub);
      expect(await detail(row.report_id!)).toMatchObject({ contact_kind: 'account', contact_masked: null, account_user_id: null, account_exists: false });
      const id = (await su.query<{ id: string }>("INSERT INTO public.users (cognito_sub, user_type, phone) VALUES ($1, 'worker', $2) RETURNING id", [sub, TYPED_PHONE])).rows[0].id;
      userIds.push(id);
      expect(await detail(row.report_id!)).toMatchObject({ contact_masked: '+1 555 *** 0199', account_user_id: id, account_exists: true });
    });

    it.each<[string, string | null, string, string | null]>([
      ['a phone-shaped contact', TYPED_PHONE, 'typed', '+1 555 *** 0199'],
      ['an email-shaped contact', TYPED_EMAIL, 'typed', MASKED_EMAIL],
      ['any other contact, to its last two characters', 'ask at the front desk', 'typed', '***sk'],
      ['no contact', null, 'none', null],
    ])('masks %s typed while signed out', async (_label, contact, kind, masked) => {
      const row = await createUnverified({ contact });
      expect(await detail(row.report_id!)).toMatchObject({ verified: false, contact_kind: kind, contact_masked: masked, account_user_id: null, account_exists: false });
    });

    it('returns no row for an unknown report, and raises 22023 without one', async () => {
      expect(await call(console_, 'SELECT * FROM jale_cap.problem_report_detail($1)', [randomUUID()])).toEqual([]);
      expect(await sqlState(() => call(console_, 'SELECT * FROM jale_cap.problem_report_detail(NULL)'))).toBe('22023');
    });

    it('reveals the raw contact of a report and whose account it is, or says why there is none', async () => {
      const worker = await insertUser('worker', { phone: TYPED_PHONE });
      const verified = await createVerified(worker.sub);
      // Sent before the account existed, linked by the sign-in; the account exists now.
      const lateSub = randomUUID();
      const late = await createVerified(lateSub, { roleHint: 'employer', category: 'billing' });
      const lateUser = (await su.query<{ id: string }>(
        "INSERT INTO public.users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id", [lateSub, TYPED_EMAIL],
      )).rows[0].id;
      userIds.push(lateUser);
      const noContact = await insertUser('worker');
      const bare = await createVerified(noContact.sub);
      const typed = await createUnverified({ contact: TYPED_EMAIL });
      const none = await createUnverified({ contact: null });
      const unlinked = await createVerified(randomUUID());
      const reveal = (id: string) => one(console_, 'SELECT * FROM jale_cap.problem_report_reveal_contact($1)', [id]);
      expect(await reveal(verified.report_id!))
        .toEqual({ outcome: 'ok', contact_kind: 'account', contact: TYPED_PHONE, account_user_id: worker.id });
      expect(await reveal(late.report_id!))
        .toEqual({ outcome: 'ok', contact_kind: 'account', contact: TYPED_EMAIL, account_user_id: lateUser });
      expect(await reveal(typed.report_id!))
        .toEqual({ outcome: 'ok', contact_kind: 'typed', contact: TYPED_EMAIL, account_user_id: null });
      // Every outcome but ok names no account.
      expect(await reveal(bare.report_id!))
        .toEqual({ outcome: 'no_contact', contact_kind: 'account', contact: null, account_user_id: null });
      expect(await reveal(none.report_id!))
        .toEqual({ outcome: 'no_contact', contact_kind: 'none', contact: null, account_user_id: null });
      expect(await reveal(unlinked.report_id!))
        .toEqual({ outcome: 'no_contact', contact_kind: 'account', contact: null, account_user_id: null });
      expect(await reveal(randomUUID()))
        .toEqual({ outcome: 'not_found', contact_kind: null, contact: null, account_user_id: null });
      await su.query('DELETE FROM public.problem_report_contents WHERE report_id = $1', [typed.report_id]);
      expect(await reveal(typed.report_id!))
        .toEqual({ outcome: 'content_erased', contact_kind: null, contact: null, account_user_id: null });
    });

    it('returns the image key, its type and whose account sent it, or why there is none', async () => {
      const token = tokenHash();
      const row = await createUnverified({ tokenHash: token });
      const id = row.report_id!;
      const image = () => one(console_, 'SELECT * FROM jale_cap.problem_report_image($1)', [id]);
      expect(await image()).toEqual({ outcome: 'no_image', image_key: null, content_type: null, account_user_id: null });
      const issued = await one<{ upload_key: string }>(pub, "SELECT * FROM jale_cap.problem_report_upload_grant($1, $2, 'image/webp')", [id, token]);
      const imageKey = `images/${id}/${issued.upload_key.slice('incoming/'.length)}.webp`;
      await call(pub, "SELECT * FROM jale_cap.problem_report_attach($1, $2, $3, $4, 'image/webp', 2048)", [id, token, issued.upload_key, imageKey]);
      // A signed-out report has no account.
      expect(await image()).toEqual({ outcome: 'ok', image_key: imageKey, content_type: 'image/webp', account_user_id: null });
      expect(await detail(id)).toMatchObject({ has_image: true, image_available: true });
      await su.query("UPDATE public.problem_report_contents SET image_key = NULL WHERE report_id = $1", [id]);
      await su.query("UPDATE public.problem_reports SET image_deleted_at = now() WHERE id = $1", [id]);
      expect(await image()).toEqual({ outcome: 'image_expired', image_key: null, content_type: null, account_user_id: null });
      expect(await detail(id)).toMatchObject({ has_image: true, image_available: false });
      expect(await one(console_, 'SELECT * FROM jale_cap.problem_report_image($1)', [randomUUID()]))
        .toEqual({ outcome: 'not_found', image_key: null, content_type: null, account_user_id: null });

      // A signed-in report names the account that sent it.
      const worker = await insertUser('worker', { phone: TYPED_PHONE });
      const verifiedToken = tokenHash();
      const verified = await createVerified(worker.sub, { tokenHash: verifiedToken });
      const vid = verified.report_id!;
      const vimage = () => one(console_, 'SELECT * FROM jale_cap.problem_report_image($1)', [vid]);
      expect(await vimage()).toEqual({ outcome: 'no_image', image_key: null, content_type: null, account_user_id: null });
      const vissued = await one<{ upload_key: string }>(api, "SELECT * FROM jale_cap.problem_report_upload_grant($1, $2, 'image/png')", [vid, verifiedToken]);
      const vkey = `images/${vid}/${vissued.upload_key.slice('incoming/'.length)}.png`;
      await call(api, "SELECT * FROM jale_cap.problem_report_attach($1, $2, $3, $4, 'image/png', 4096)", [vid, verifiedToken, vissued.upload_key, vkey]);
      expect(await vimage()).toEqual({ outcome: 'ok', image_key: vkey, content_type: 'image/png', account_user_id: worker.id });
    });

    it('moves a report between statuses, stamping the change only when the status changes', async () => {
      const row = await createVerified(randomUUID());
      const id = row.report_id!;
      const setStatus = (status: string | null, reportId = id) =>
        one(console_, 'SELECT * FROM jale_cap.problem_report_set_status($1, $2)', [reportId, status]);
      expect(await setStatus('looking')).toEqual({ outcome: 'ok', status: 'looking' });
      const stamped = (await header(id)).status_changed_at;
      expect(stamped).not.toBeNull();
      expect(await setStatus('looking')).toEqual({ outcome: 'ok', status: 'looking' });
      expect((await header(id)).status_changed_at).toEqual(stamped);
      expect(await setStatus('closed')).toEqual({ outcome: 'invalid_status', status: null });
      expect(await setStatus(null)).toEqual({ outcome: 'invalid_status', status: null });
      expect(await setStatus('fixed', randomUUID())).toEqual({ outcome: 'not_found', status: null });
      expect((await header(id)).status).toBe('looking');
    });

    it('sets, clears and refuses the internal note', async () => {
      const row = await createVerified(randomUUID());
      const id = row.report_id!;
      const setNote = (note: string | null, reportId = id) =>
        one(console_, 'SELECT * FROM jale_cap.problem_report_set_note($1, $2)', [reportId, note]);
      expect(await setNote('Seen on Android only.')).toEqual({ outcome: 'ok' });
      expect((await contents(id)).internal_note).toBe('Seen on Android only.');
      expect(await setNote('   ')).toEqual({ outcome: 'ok' });
      expect((await contents(id)).internal_note).toBeNull();
      expect(await setNote('n'.repeat(4001))).toEqual({ outcome: 'invalid_note' });
      expect(await setNote('n'.repeat(4000))).toEqual({ outcome: 'ok' });
      expect(await setNote('x', randomUUID())).toEqual({ outcome: 'not_found' });
      await su.query('DELETE FROM public.problem_report_contents WHERE report_id = $1', [id]);
      expect(await setNote('Too late.')).toEqual({ outcome: 'content_erased' });
      expect(await detail(id)).toMatchObject({ content_erased: true, description: null, context: null, internal_note: null, contact_kind: 'none' });
    });

    it('reads and validates the settings; NULL leaves a setting unchanged', async () => {
      const adminId = randomUUID();
      const setAll = (args: unknown[]) => one(console_, 'SELECT * FROM jale_cap.problem_report_settings_set($1, $2, $3, $4, $5, $6, $7, $8)', args);
      expect(await one(console_, 'SELECT * FROM jale_cap.problem_report_settings_get()')).toMatchObject({
        reporting_enabled: true, signed_out_enabled: true, screenshots_enabled: true, team_email_enabled: true,
        signed_out_daily_cap: 200, team_recipient: null, admin_base_url: null, updated_by_admin: null,
      });
      expect(await setAll([adminId, null, false, null, null, TEAM_RECIPIENT, ADMIN_BASE_URL, 150])).toEqual({ outcome: 'ok' });
      expect(await one(console_, 'SELECT * FROM jale_cap.problem_report_settings_get()')).toMatchObject({
        reporting_enabled: true, signed_out_enabled: false, screenshots_enabled: true, team_email_enabled: true,
        signed_out_daily_cap: 150, team_recipient: TEAM_RECIPIENT, admin_base_url: ADMIN_BASE_URL, updated_by_admin: adminId,
      });
      expect(await setAll([adminId, null, null, null, null, 'not-an-address', null, null])).toEqual({ outcome: 'invalid_recipient' });
      expect(await setAll([adminId, null, null, null, null, ['two', 'at', 'signs'].join('@'), null, null])).toEqual({ outcome: 'invalid_recipient' });
      expect(await setAll([adminId, null, null, null, null, null, ['http:', '', `dashboard.${TEST_DOMAIN}`].join('/'), null])).toEqual({ outcome: 'invalid_base_url' });
      expect(await setAll([adminId, null, null, null, null, null, `${ADMIN_BASE_URL}/reports`, null])).toEqual({ outcome: 'invalid_base_url' });
      expect(await setAll([adminId, null, null, null, null, null, null, 5001])).toEqual({ outcome: 'invalid_cap' });
      expect(await setAll([adminId, null, null, null, null, null, null, -1])).toEqual({ outcome: 'invalid_cap' });
      expect(await setAll([adminId, null, null, null, null, null, null, 0])).toEqual({ outcome: 'ok' });
      expect(await sqlState(() => setAll([null, true, null, null, null, null, null, null]))).toBe('22023');
      expect(await one(console_, 'SELECT * FROM jale_cap.problem_report_settings_get()')).toMatchObject({
        signed_out_enabled: false, signed_out_daily_cap: 0, team_recipient: TEAM_RECIPIENT, admin_base_url: ADMIN_BASE_URL,
      });
    });
  });
});
