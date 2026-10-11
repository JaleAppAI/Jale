/**
 * problem-reports-cleanup.integration.test.ts -- report a problem: the daily
 * clean-up (migration 108) on its real login, jale_job_report_cleanup.
 *
 * jale_cap.problem_report_cleanup(p_batch) runs as jale_cap_report_cleanup,
 * which holds only the key and date columns the clean-up needs. In this
 * order, each part bounded by p_batch, it:
 *   1. expires images older than 90 days: returns their keys, clears them
 *      and dates the header;
 *   2. clears uploads issued over a day ago and never attached, returning
 *      their keys;
 *   3. erases personal content older than 12 months: the contents row goes,
 *      and the header keeps the date it was erased;
 *   4. deletes report mail over a day old that the sender will not retry;
 *   5. deletes rate-limit buckets older than 2 days.
 * The keys come back image keys first, then upload keys, each group sorted.
 * The owner holds no right on the words, the contact, the context or the
 * note, so a run that succeeds has read none of them.
 *
 * Boundary rows sit a minute either side of each limit, so the result never
 * depends on how long the run takes. Fixtures go through the superuser URL;
 * the clean-up itself runs over a real authenticated connection as its
 * login and commits, as the daily job does. Runs in every test-bed profile.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MAX_EMAIL_SEND_ATTEMPTS } from '../../../lambda/lib/email-outbox';
import { DB_PROFILES, describeInProfiles, loginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: problem-reports clean-up PostgreSQL gate was not run', () => {
    console.warn('[problem-reports-cleanup] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

const CLEANUP = 'jale_cap_report_cleanup';
// A reserved test name (RFC 6761), assembled at runtime.
const TEAM_RECIPIENT = ['report-team', ['example', 'invalid'].join('.')].join('@');

interface CleanupRow {
  contents_erased: number;
  images_expired: number;
  pending_cleared: number;
  notifications_deleted: number;
  buckets_deleted: number;
  delete_keys: string[];
}

const ZERO: CleanupRow = {
  contents_erased: 0, images_expired: 0, pending_cleared: 0, notifications_deleted: 0, buckets_deleted: 0, delete_keys: [],
};

interface Seeded {
  id: string;
  imageKey: string | null;
  pendingKey: string | null;
}

interface SeedOptions {
  /** How long ago the report was created, as an interval. */
  age: string;
  image?: 'jpg' | 'png' | 'webp';
  /** How long ago the upload was issued; none when absent. */
  pendingIssued?: string;
  typedContact?: string;
  note?: string;
}

/** Inserts a signed-out header and its contents as the superuser. */
async function seedReport(su: Client, options: SeedOptions): Promise<Seeded> {
  const id = randomUUID();
  // Each upload has its own final key: images/<report>/<upload>.<ext>.
  const imageKey = options.image ? `images/${id}/${randomUUID()}.${options.image}` : null;
  const pendingKey = options.pendingIssued ? `incoming/${randomUUID()}` : null;
  await su.query(
    `WITH header AS (
       INSERT INTO public.problem_reports
         (id, client_key, role, verified, category, locale, include_technical, has_image, created_at, updated_at)
       VALUES ($1, $2, 'unknown', false, 'other', 'en', true, $3, now() - $4::interval, now() - $4::interval)
       RETURNING id, created_at)
     INSERT INTO public.problem_report_contents
       (report_id, created_at, description, typed_contact, internal_note, context, image_key,
        pending_upload_key, pending_content_type, upload_issued_at)
     SELECT header.id, header.created_at, 'The page stopped loading.', $5, $6, '{"v":1}'::jsonb, $7,
            $8::text, CASE WHEN $8::text IS NULL THEN NULL ELSE 'image/png' END, now() - $9::interval
       FROM header`,
    [id, randomUUID(), imageKey !== null, options.age, options.typedContact ?? null, options.note ?? null,
      imageKey, pendingKey, options.pendingIssued ?? null],
  );
  return { id, imageKey, pendingKey };
}

/** Inserts one outbox row as the superuser. */
async function seedMail(
  su: Client,
  options: { status: 'pending' | 'sent' | 'failed' | 'send_unknown'; attempts: number; age: string; sourceType?: string },
): Promise<string> {
  const id = randomUUID();
  await su.query(
    `INSERT INTO public.email_outbox
       (id, recipient_email, subject, body_text, source_type, source_id, idempotency_key, status, attempt_count,
        created_at, sent_at)
     VALUES ($1, $2, 'New report', 'A new problem report is waiting in the dashboard.', $3, $4, $5, $6, $7,
             now() - $8::interval, CASE WHEN $6::text = 'sent' THEN now() - $8::interval END)`,
    [id, TEAM_RECIPIENT, options.sourceType ?? 'problem_report', randomUUID(), `cleanup-test:${id}`, options.status,
      options.attempts, options.age],
  );
  return id;
}

/** Inserts one rate-limit bucket that started `age` ago; returns its address hash. */
async function seedBucket(su: Client, age: string, windowKind: 'hour' | 'day' = 'hour'): Promise<string> {
  const addressHash = randomBytes(32).toString('hex');
  await su.query(
    `INSERT INTO public.problem_report_rate_buckets (address_hash, window_kind, bucket_start, request_count)
     VALUES ($1, $2, now() - $3::interval, 3)`,
    [addressHash, windowKind, age],
  );
  return addressHash;
}

async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  }
}

const sorted = (values: Array<string | null>): string[] =>
  values.filter((v): v is string => v !== null).sort();

describeInProfiles(DB_PROFILES, 'problem report clean-up', () => {
  let su: Client;
  let job: Client;

  /** One clean-up batch in its own committed transaction, as the daily job runs it. */
  async function cleanup(batch: number | null): Promise<CleanupRow> {
    await job.query('BEGIN');
    try {
      const { rows } = await job.query<CleanupRow>('SELECT * FROM jale_cap.problem_report_cleanup($1)', [batch]);
      await job.query('COMMIT');
      return rows[0];
    } catch (err) {
      await job.query('ROLLBACK');
      throw err;
    }
  }

  async function reset(): Promise<void> {
    await su.query('DELETE FROM public.problem_reports');
    await su.query('DELETE FROM public.problem_report_rate_buckets');
    await su.query("DELETE FROM public.email_outbox WHERE idempotency_key LIKE 'cleanup-test:%'");
  }

  const headerOf = async (id: string) =>
    (await su.query<{ has_image: boolean; image_deleted_at: Date | null; content_erased_at: Date | null }>(
      'SELECT has_image, image_deleted_at, content_erased_at FROM public.problem_reports WHERE id = $1', [id],
    )).rows[0];
  const contentsOf = async (id: string) =>
    (await su.query('SELECT * FROM public.problem_report_contents WHERE report_id = $1', [id])).rows[0];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    job = loginClient('jale_job_report_cleanup');
    await job.connect();
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
    await job.end();
    await su.end();
  });

  it('runs the five parts in order, each to its limit, returns the keys, and a second run finds nothing', async () => {
    const image = {
      kept89: await seedReport(su, { age: '89 days', image: 'png' }),
      keptEdge: await seedReport(su, { age: '90 days -1 minute', image: 'jpg' }),
      goneEdge: await seedReport(su, { age: '90 days 1 minute', image: 'webp' }),
      gone91: await seedReport(su, { age: '91 days', image: 'png' }),
    };
    const pending = {
      kept: await seedReport(su, { age: '2 days', pendingIssued: '1 day -1 minute' }),
      gone: await seedReport(su, { age: '2 days', pendingIssued: '1 day 1 minute' }),
    };
    const content = {
      kept11: await seedReport(su, { age: '11 months', typedContact: 'call me after five', note: 'Seen twice.' }),
      keptEdge: await seedReport(su, { age: '12 months -1 minute' }),
      goneEdge: await seedReport(su, { age: '12 months 1 minute', typedContact: 'call me after five', note: 'Seen twice.' }),
      gone13: await seedReport(su, { age: '13 months' }),
      // Its image key is returned (part 1) before its content goes (part 3).
      gone13Image: await seedReport(su, { age: '13 months', image: 'png' }),
      // Its upload key is returned (part 2) before its content goes (part 3).
      gone13Pending: await seedReport(su, { age: '13 months', pendingIssued: '13 months -10 minutes' }),
    };
    const fresh = await seedReport(su, { age: '1 minute', image: 'png' });

    const mail = {
      sent: await seedMail(su, { status: 'sent', attempts: 1, age: '25 hours' }),
      sendUnknown: await seedMail(su, { status: 'send_unknown', attempts: 1, age: '25 hours' }),
      exhausted: await seedMail(su, { status: 'failed', attempts: MAX_EMAIL_SEND_ATTEMPTS, age: '25 hours' }),
      retryable: await seedMail(su, { status: 'failed', attempts: MAX_EMAIL_SEND_ATTEMPTS - 1, age: '25 hours' }),
      pending: await seedMail(su, { status: 'pending', attempts: 0, age: '25 hours' }),
      sentRecent: await seedMail(su, { status: 'sent', attempts: 1, age: '23 hours' }),
      otherSource: await seedMail(su, { status: 'sent', attempts: 1, age: '25 hours', sourceType: 'billing_pause' }),
    };

    const bucket = {
      keptEdge: await seedBucket(su, '2 days -1 minute'),
      goneEdge: await seedBucket(su, '2 days 1 minute'),
      goneDay: await seedBucket(su, '3 days', 'day'),
    };

    const keptBefore = await Promise.all(
      [image.kept89, image.keptEdge, pending.kept, content.kept11, content.keptEdge, fresh].map((r) => contentsOf(r.id)),
    );

    const first = await cleanup(500);
    expect(first).toEqual({
      images_expired: 3,
      pending_cleared: 2,
      contents_erased: 4,
      notifications_deleted: 3,
      buckets_deleted: 2,
      delete_keys: [
        ...sorted([image.goneEdge.imageKey, image.gone91.imageKey, content.gone13Image.imageKey]),
        ...sorted([pending.gone.pendingKey, content.gone13Pending.pendingKey]),
      ],
    });

    // Part 1: the expired images are cleared and dated; the header still says there was one.
    for (const r of [image.goneEdge, image.gone91]) {
      expect(await contentsOf(r.id)).toMatchObject({ image_key: null, description: 'The page stopped loading.' });
      expect(await headerOf(r.id)).toMatchObject({ has_image: true, image_deleted_at: expect.any(Date), content_erased_at: null });
    }
    // Part 2: the stale upload is cleared.
    expect(await contentsOf(pending.gone.id)).toMatchObject({
      pending_upload_key: null, pending_content_type: null, upload_issued_at: null, description: 'The page stopped loading.',
    });
    // Part 3: the old content is gone and the header keeps the date.
    for (const r of [content.goneEdge, content.gone13, content.gone13Image, content.gone13Pending]) {
      expect(await contentsOf(r.id)).toBeUndefined();
      expect((await headerOf(r.id)).content_erased_at).toEqual(expect.any(Date));
    }
    expect((await headerOf(content.gone13Image.id)).image_deleted_at).toEqual(expect.any(Date));
    // Everything inside its limit is untouched.
    expect(await Promise.all(
      [image.kept89, image.keptEdge, pending.kept, content.kept11, content.keptEdge, fresh].map((r) => contentsOf(r.id)),
    )).toEqual(keptBefore);
    for (const r of [image.kept89, image.keptEdge, pending.kept, content.kept11, content.keptEdge, fresh]) {
      expect(await headerOf(r.id)).toMatchObject({ image_deleted_at: null, content_erased_at: null });
    }
    // Part 4: only report mail the sender will not retry, over a day old.
    const mailLeft = (await su.query<{ id: string }>(
      "SELECT id FROM public.email_outbox WHERE idempotency_key LIKE 'cleanup-test:%'",
    )).rows.map((r) => r.id).sort();
    expect(mailLeft).toEqual([mail.retryable, mail.pending, mail.sentRecent, mail.otherSource].sort());
    // Part 5: only buckets older than 2 days.
    const bucketsLeft = (await su.query<{ address_hash: string }>(
      'SELECT address_hash FROM public.problem_report_rate_buckets',
    )).rows.map((r) => r.address_hash);
    expect(bucketsLeft).toEqual([bucket.keptEdge]);
    void mail.sent; void mail.sendUnknown; void mail.exhausted; void bucket.goneEdge; void bucket.goneDay;

    expect(await cleanup(500)).toEqual(ZERO);
  });

  it('bounds each part by the batch size, so repeated runs drain the backlog and then return zeros', async () => {
    const images = [await seedReport(su, { age: '100 days', image: 'png' }), await seedReport(su, { age: '101 days', image: 'jpg' })];
    const uploads = [
      await seedReport(su, { age: '3 days', pendingIssued: '2 days' }),
      await seedReport(su, { age: '3 days', pendingIssued: '2 days 1 hour' }),
    ];
    const old = [await seedReport(su, { age: '13 months' }), await seedReport(su, { age: '14 months' })];
    await seedMail(su, { status: 'sent', attempts: 1, age: '2 days' });
    await seedMail(su, { status: 'sent', attempts: 1, age: '3 days' });
    await seedBucket(su, '3 days');
    await seedBucket(su, '4 days');

    const runs = [await cleanup(1), await cleanup(1)];
    for (const run of runs) {
      expect({ ...run, delete_keys: run.delete_keys.length }).toEqual({
        images_expired: 1, pending_cleared: 1, contents_erased: 1, notifications_deleted: 1, buckets_deleted: 1, delete_keys: 2,
      });
      expect(run.delete_keys[0]).toMatch(/^images\//);
      expect(run.delete_keys[1]).toMatch(/^incoming\//);
    }
    expect(runs.flatMap((run) => run.delete_keys).sort()).toEqual(
      sorted([...images.map((r) => r.imageKey), ...uploads.map((r) => r.pendingKey)]),
    );
    for (const r of old) expect(await contentsOf(r.id)).toBeUndefined();
    expect(await cleanup(1)).toEqual(ZERO);
  });

  it.each<[string, number | null]>([
    ['zero', 0],
    ['a negative size', -1],
    ['more than 5000', 5001],
    ['none', null],
  ])('raises 22023 for a batch size of %s', async (_label, batch) => {
    expect(await sqlState(() => cleanup(batch))).toBe('22023');
  });

  it('accepts the batch sizes 1 and 5000', async () => {
    expect(await cleanup(1)).toEqual(ZERO);
    expect(await cleanup(5000)).toEqual(ZERO);
  });

  it('keeps report mail in step with the sender: rows it would still retry are never deleted', async () => {
    const { rows } = await su.query<{ policy: string; qual: string }>(
      `SELECT policyname AS policy, qual FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = 'email_outbox'
          AND policyname LIKE 'email\\_outbox\\_problem\\_report\\_cleanup\\_%'
        ORDER BY policyname`,
    );
    expect(rows.map((r) => r.policy)).toEqual([
      'email_outbox_problem_report_cleanup_delete',
      'email_outbox_problem_report_cleanup_read',
    ]);
    for (const row of rows) {
      expect(row.qual).toContain("source_type = 'problem_report'::text");
      expect(row.qual).toContain(`attempt_count < ${MAX_EMAIL_SEND_ATTEMPTS}`);
      expect(row.qual).toContain("ARRAY['pending'::text, 'failed'::text]");
    }
  });

  describe('the clean-up owner cannot read content', () => {
    /** The columns of `table` that `role` may SELECT, sorted. */
    async function readable(role: string, table: string): Promise<string[]> {
      const { rows } = await su.query<{ column: string }>(
        `SELECT a.attname::text AS column FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_catalog.has_column_privilege($1, a.attrelid, a.attnum, 'SELECT')`,
        [role, table],
      );
      return rows.map((r) => r.column).sort();
    }

    it('holds SELECT on key and date columns only', async () => {
      expect({
        contents: await readable(CLEANUP, 'public.problem_report_contents'),
        reports: await readable(CLEANUP, 'public.problem_reports'),
        buckets: await readable(CLEANUP, 'public.problem_report_rate_buckets'),
        outbox: await readable(CLEANUP, 'public.email_outbox'),
        settings: await readable(CLEANUP, 'public.problem_report_settings'),
        users: await readable(CLEANUP, 'public.users'),
      }).toEqual({
        contents: ['created_at', 'image_key', 'pending_upload_key', 'report_id', 'upload_issued_at'],
        reports: ['content_erased_at', 'id', 'image_deleted_at'],
        buckets: ['address_hash', 'bucket_start', 'window_kind'],
        outbox: ['attempt_count', 'created_at', 'id', 'source_type', 'status'],
        settings: [],
        users: [],
      });
    });

    it('a direct read of any content column fails as the owner and as the login', async () => {
      await seedReport(su, { age: '400 days', typedContact: 'call me after five', note: 'Seen twice.' });
      await seedMail(su, { status: 'sent', attempts: 1, age: '2 days' });
      const probes = [
        'SELECT description FROM public.problem_report_contents',
        'SELECT typed_contact FROM public.problem_report_contents',
        'SELECT context FROM public.problem_report_contents',
        'SELECT internal_note FROM public.problem_report_contents',
        'SELECT reporter_user_id, reporter_sub FROM public.problem_report_contents',
        'SELECT attach_token_hash FROM public.problem_report_contents',
        'SELECT * FROM public.problem_report_contents',
        'SELECT recipient_email, subject, body_text, body_html FROM public.email_outbox',
      ];
      const outcomes: string[] = [];
      for (const sql of probes) {
        await su.query('BEGIN');
        try {
          await su.query(`SET LOCAL ROLE ${CLEANUP}`);
          outcomes.push(`owner ${sql}: ${await sqlState(() => su.query(sql))}`);
        } finally {
          await su.query('ROLLBACK');
        }
        outcomes.push(`login ${sql}: ${await sqlState(() => job.query(sql))}`);
      }
      expect(outcomes.filter((line) => !line.endsWith(': 42501'))).toEqual([]);
      expect(outcomes).toHaveLength(probes.length * 2);
    });
  });
});
