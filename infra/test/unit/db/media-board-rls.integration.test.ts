/**
 * media-board-rls.integration.test.ts
 *
 * PostgreSQL-backed RLS integration tests for the media-board tables
 * introduced in migration 082 (worker_posts, worker_post_media).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the
 * full migration chain (001→082) already applied. When absent, all tests are
 * explicitly skipped and the concern is logged (Rule 11: no silent skips).
 *
 * The harness mirrors infra/test/unit/db/referrals-rls.integration.test.ts and
 * infra/test/unit/db/billing-rls.integration.test.ts:
 * - jale_admin sessions connect via a role-specific URL (test-admin-pw) and
 *   set either app.current_user_id (Cognito-sub lane) or
 *   app.current_internal_user_id (internal-id lane) with SET LOCAL inside a
 *   per-test transaction.
 * - jale_whatsapp sessions connect via a role-specific URL (test-whatsapp-pw)
 *   and set app.current_internal_user_id with SET LOCAL — migration 082 puts
 *   jale_whatsapp on the SAME internal-id lane as jale_admin for both tables
 *   (worker_posts_self_internal / worker_post_media_self_internal are
 *   `FOR ALL TO jale_admin, jale_whatsapp`).
 * - The connection pointed to by JALE_TEST_DATABASE_URL itself must be a
 *   genuine Postgres superuser (e.g. `postgres`) — FORCE ROW LEVEL SECURITY
 *   on worker_posts/worker_post_media applies even to jale_admin as table
 *   owner, so fixture setup (which must bypass RLS entirely, e.g. to seed a
 *   'flagged' media row or a 'deleted' post directly) needs a role with
 *   BYPASSRLS, not just jale_admin.
 *
 * Case groups (task 7b brief):
 *   1. Worker sees own posts via the sub lane (app.current_user_id).
 *   2. Worker sees own posts via the internal lane (app.current_internal_user_id),
 *      both jale_admin and jale_whatsapp.
 *   3. Employer WITH an application relationship sees the worker's published
 *      posts; employer WITHOUT sees zero rows.
 *   4. Flagged media invisible to the employer via RLS alone (no
 *      moderation_status filter in the test SQL).
 *   5. Deleted post invisible to the employer via RLS alone (no status filter
 *      in the test SQL).
 *   6. jale_whatsapp can INSERT a post + media and UPDATE status='deleted' on
 *      its own worker's post, and cannot touch another worker's rows.
 *   7. worker_profile_media (pre-existing table, 011): jale_whatsapp on the
 *      internal-id lane can INSERT its own row via the
 *      worker_profile_media_self_internal policy 082 adds, and cannot INSERT
 *      for another user_id.
 *   8. Recursion smoke: plain SELECT count(*) on both tables under each lane
 *      completes without 42P17.
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Harness helpers (copied from referrals-rls.integration.test.ts /
// billing-rls.integration.test.ts)
// ---------------------------------------------------------------------------

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
  } finally {
    await client.end();
  }
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Run a block as jale_admin with app.current_user_id set (Cognito-sub lane). */
async function asAdminSub<T>(
  adminUrl: string,
  cognitoSub: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = '${cognitoSub}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

/** Run a block as jale_admin with app.current_internal_user_id set (internal-id lane). */
async function asAdminInternal<T>(
  adminUrl: string,
  internalUserId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_internal_user_id = '${internalUserId}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

/** Run a block as jale_whatsapp with app.current_internal_user_id set. */
async function asWhatsappInternal<T>(
  whatsappUrl: string,
  internalUserId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: whatsappUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_internal_user_id = '${internalUserId}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[media-board-rls.integration] SKIPPED: "${name}" — set JALE_TEST_DATABASE_URL to run PostgreSQL-backed RLS tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
    );
  } else {
    describe(name, fn);
  }
}

// ---------------------------------------------------------------------------
// Test state — populated once in beforeAll
// ---------------------------------------------------------------------------

let superuserUrl: string; // genuine Postgres superuser — bypasses RLS for fixture setup
let adminUrl: string; // jale_admin role — FORCE RLS applies; use for RLS tests
let whatsappUrl: string; // jale_whatsapp service role

let workerId: string;
let workerCognitoSub: string;

let otherWorkerId: string; // used for jale_whatsapp cross-worker isolation (case 6)
let otherWorkerCognitoSub: string;

let employerWithRelId: string; // has a job_applications row against workerId
let employerWithRelCognitoSub: string;

let employerNoRelId: string; // has no relationship to workerId at all
let employerNoRelCognitoSub: string;

let jobId: string; // owned by employerWithRelId, workerId applied to it

maybeDescribe('media-board RLS integration (migration 082)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;

    superuserUrl = databaseUrl;
    await setServiceRolePasswords(superuserUrl);

    adminUrl = new URL(databaseUrl).username === 'jale_admin'
      ? databaseUrl
      : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');
    whatsappUrl = urlForRole(databaseUrl, 'jale_whatsapp', 'test-whatsapp-pw');

    const setup = new Client({ connectionString: superuserUrl });
    await setup.connect();
    try {
      const w1 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at)
         VALUES ('media-board-worker-1', 'worker', '+10000000201', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      workerId = w1.rows[0].id;
      workerCognitoSub = w1.rows[0].cognito_sub;

      const w2 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at)
         VALUES ('media-board-worker-2', 'worker', '+10000000202', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      otherWorkerId = w2.rows[0].id;
      otherWorkerCognitoSub = w2.rows[0].cognito_sub;

      const eRel = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
         VALUES ('media-board-employer-rel', 'employer', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      employerWithRelId = eRel.rows[0].id;
      employerWithRelCognitoSub = eRel.rows[0].cognito_sub;

      const eNoRel = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
         VALUES ('media-board-employer-norel', 'employer', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      employerNoRelId = eNoRel.rows[0].id;
      employerNoRelCognitoSub = eNoRel.rows[0].cognito_sub;

      // Job owned by employerWithRelId, and an application from workerId onto
      // it — this is exactly what
      // jale_internal.employer_has_applicant_relationship(employer, worker)
      // checks (EXISTS job_applications ja JOIN jobs j ON j.id = ja.job_id
      // WHERE ja.worker_id = worker AND j.employer_id::text = employer).
      // employerNoRelId deliberately gets no job/application at all, so the
      // DEFINER function's EXISTS is false for that pair.
      const job = await setup.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'Media Board Test Job', 'Austin, TX', 'full-time', 'active')
         RETURNING id`,
        [employerWithRelId],
      );
      jobId = job.rows[0].id;

      await setup.query(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (job_id, worker_id) DO NOTHING`,
        [jobId, workerId],
      );
    } finally {
      await setup.end();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fixture helpers — every test seeds its own post/media rows as the
  // superuser (bypassing RLS) so each case starts from a known, isolated
  // state regardless of test order or DB reuse across runs.
  // -------------------------------------------------------------------------

  async function makePost(
    worker: string,
    overrides: Partial<{ status: string; source: string; caption: string }> = {},
  ): Promise<string> {
    const client = new Client({ connectionString: superuserUrl });
    await client.connect();
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO worker_posts (worker_id, caption, source, status)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          worker,
          overrides.caption ?? 'Test post',
          overrides.source ?? 'web',
          overrides.status ?? 'published',
        ],
      );
      return result.rows[0].id;
    } finally {
      await client.end();
    }
  }

  async function makeMedia(
    postId: string,
    worker: string,
    overrides: Partial<{ moderationStatus: string; sortOrder: number }> = {},
  ): Promise<string> {
    const client = new Client({ connectionString: superuserUrl });
    await client.connect();
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO worker_post_media
           (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
         VALUES ($1, $2, $3, 'v1', $4, 'image/jpeg', 12345, $5)
         RETURNING id`,
        [
          postId,
          worker,
          `${worker}/posts/${postId}/${randomUUID()}.jpg`,
          overrides.sortOrder ?? 0,
          overrides.moderationStatus ?? 'approved',
        ],
      );
      return result.rows[0].id;
    } finally {
      await client.end();
    }
  }

  // -------------------------------------------------------------------------
  // Case 1: Worker sees own posts via the sub lane (app.current_user_id)
  // -------------------------------------------------------------------------
  describe('worker self, Cognito-sub lane (worker_posts_self_sub / worker_post_media_self_sub)', () => {
    it('worker sees their own published post and its media', async () => {
      const postId = await makePost(workerId);
      const mediaId = await makeMedia(postId, workerId);

      const posts = await asAdminSub(adminUrl, workerCognitoSub, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(posts.rows).toEqual([{ id: postId }]);

      const media = await asAdminSub(adminUrl, workerCognitoSub, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_post_media WHERE id = $1`, [mediaId]),
      );
      expect(media.rows).toEqual([{ id: mediaId }]);
    });

    it('a different worker (sub lane) does not see this worker\'s post', async () => {
      const postId = await makePost(workerId);

      const posts = await asAdminSub(adminUrl, otherWorkerCognitoSub, (client) =>
        client.query(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(posts.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Worker sees own posts via the internal lane
  // (app.current_internal_user_id), both jale_admin and jale_whatsapp.
  // -------------------------------------------------------------------------
  describe('worker self, internal-id lane (worker_posts_self_internal / worker_post_media_self_internal)', () => {
    it('jale_admin under the internal lane sees the worker\'s own post and media', async () => {
      const postId = await makePost(workerId);
      const mediaId = await makeMedia(postId, workerId);

      const posts = await asAdminInternal(adminUrl, workerId, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(posts.rows).toEqual([{ id: postId }]);

      const media = await asAdminInternal(adminUrl, workerId, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_post_media WHERE id = $1`, [mediaId]),
      );
      expect(media.rows).toEqual([{ id: mediaId }]);
    });

    it('jale_whatsapp under the internal lane sees the worker\'s own post and media', async () => {
      const postId = await makePost(workerId);
      const mediaId = await makeMedia(postId, workerId);

      const posts = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(posts.rows).toEqual([{ id: postId }]);

      const media = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_post_media WHERE id = $1`, [mediaId]),
      );
      expect(media.rows).toEqual([{ id: mediaId }]);
    });

    it('a different worker\'s internal id (either role) does not see this worker\'s post', async () => {
      const postId = await makePost(workerId);

      const viaAdmin = await asAdminInternal(adminUrl, otherWorkerId, (client) =>
        client.query(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(viaAdmin.rows).toHaveLength(0);

      const viaWhatsapp = await asWhatsappInternal(whatsappUrl, otherWorkerId, (client) =>
        client.query(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(viaWhatsapp.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Employer WITH a relationship sees published posts; employer
  // WITHOUT one sees zero rows.
  // -------------------------------------------------------------------------
  describe('worker_posts_employer_select: relationship-gated read', () => {
    it('an employer WITH an application relationship sees the worker\'s published post', async () => {
      const postId = await makePost(workerId, { status: 'published' });

      const seen = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query<{ id: string }>(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(seen.rows).toEqual([{ id: postId }]);
    });

    it('an employer WITHOUT any relationship sees zero rows for the same post', async () => {
      const postId = await makePost(workerId, { status: 'published' });

      const seen = await asAdminInternal(adminUrl, employerNoRelId, (client) =>
        client.query(`SELECT id FROM worker_posts WHERE id = $1`, [postId]),
      );
      expect(seen.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Flagged media invisible to the employer via RLS ALONE — the test
  // SQL below deliberately carries no moderation_status filter.
  // -------------------------------------------------------------------------
  describe('worker_post_media_employer_select: flagged media is hidden by RLS, not by query filters', () => {
    it('an approved-media row is visible; a flagged-media row on the same published post is not, with NO moderation_status filter in the query', async () => {
      const postId = await makePost(workerId, { status: 'published' });
      const approvedMediaId = await makeMedia(postId, workerId, { moderationStatus: 'approved', sortOrder: 0 });
      const flaggedMediaId = await makeMedia(postId, workerId, { moderationStatus: 'flagged', sortOrder: 1 });

      // Deliberately: SELECT id FROM worker_post_media WHERE post_id = $1 —
      // no "AND moderation_status = 'approved'" anywhere in this statement.
      const seen = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query<{ id: string }>(
          `SELECT id FROM worker_post_media WHERE post_id = $1 ORDER BY sort_order`,
          [postId],
        ),
      );
      expect(seen.rows).toEqual([{ id: approvedMediaId }]);
      expect(seen.rows.map((r) => r.id)).not.toContain(flaggedMediaId);
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: Deleted post (and its media) invisible to the employer via RLS
  // ALONE — the test SQL below deliberately carries no status filter.
  // -------------------------------------------------------------------------
  describe('worker_posts_employer_select / worker_post_media_employer_select: deleted posts are hidden by RLS, not by query filters', () => {
    it('a deleted post is invisible to a related employer, with NO status filter in the query', async () => {
      const deletedPostId = await makePost(workerId, { status: 'deleted' });

      // Deliberately: SELECT id FROM worker_posts WHERE id = $1 — no
      // "AND status = 'published'" anywhere in this statement.
      const seen = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query(`SELECT id FROM worker_posts WHERE id = $1`, [deletedPostId]),
      );
      expect(seen.rows).toHaveLength(0);
    });

    it('media on a deleted post is invisible to a related employer even though the media row itself is approved, with NO parent-status filter in the query', async () => {
      const deletedPostId = await makePost(workerId, { status: 'deleted' });
      const mediaId = await makeMedia(deletedPostId, workerId, { moderationStatus: 'approved' });

      // Deliberately: SELECT id FROM worker_post_media WHERE id = $1 — the
      // "published parent" check lives entirely inside the policy's EXISTS,
      // not in this query.
      const seen = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query(`SELECT id FROM worker_post_media WHERE id = $1`, [mediaId]),
      );
      expect(seen.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: jale_whatsapp can INSERT a post + media and UPDATE
  // status='deleted' on its own worker's post; it cannot touch another
  // worker's rows.
  // -------------------------------------------------------------------------
  describe('jale_whatsapp: INSERT post + media, soft-delete own post, cannot touch another worker', () => {
    it('inserts a post and media for its own worker, then soft-deletes that post', async () => {
      const postId = await asWhatsappInternal(whatsappUrl, workerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO worker_posts (worker_id, caption, source, status)
           VALUES ($1, 'WhatsApp post', 'whatsapp', 'published')
           RETURNING id`,
          [workerId],
        );
        return result.rows[0].id;
      });

      const mediaId = await asWhatsappInternal(whatsappUrl, workerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO worker_post_media
             (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
           VALUES ($1, $2, $3, 'v1', 0, 'image/jpeg', 5555, 'approved')
           RETURNING id`,
          [postId, workerId, `${workerId}/posts/${postId}/${randomUUID()}.jpg`],
        );
        return result.rows[0].id;
      });
      expect(mediaId).toBeTruthy();

      const updateResult = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query(
          `UPDATE worker_posts SET status = 'deleted' WHERE id = $1 AND worker_id = $2`,
          [postId, workerId],
        ),
      );
      expect(updateResult.rowCount).toBe(1);

      const check = new Client({ connectionString: superuserUrl });
      await check.connect();
      try {
        const row = await check.query<{ status: string }>(
          `SELECT status FROM worker_posts WHERE id = $1`,
          [postId],
        );
        expect(row.rows[0].status).toBe('deleted');
      } finally {
        await check.end();
      }
    });

    it('cannot INSERT a post for another worker (WITH CHECK rejection)', async () => {
      await expect(
        asWhatsappInternal(whatsappUrl, workerId, (client) =>
          client.query(
            `INSERT INTO worker_posts (worker_id, caption, source, status)
             VALUES ($1, 'hostile post', 'whatsapp', 'published')`,
            [otherWorkerId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('cannot UPDATE (soft-delete) another worker\'s post — silently filtered to zero rows, and the row survives untouched', async () => {
      const otherPostId = await makePost(otherWorkerId, { status: 'published' });

      const updateResult = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query(
          `UPDATE worker_posts SET status = 'deleted' WHERE id = $1`,
          [otherPostId],
        ),
      );
      expect(updateResult.rowCount).toBe(0);

      const check = new Client({ connectionString: superuserUrl });
      await check.connect();
      try {
        const row = await check.query<{ status: string }>(
          `SELECT status FROM worker_posts WHERE id = $1`,
          [otherPostId],
        );
        expect(row.rows[0].status).toBe('published');
      } finally {
        await check.end();
      }
    });

    it('cannot INSERT media for another worker\'s post (WITH CHECK rejection)', async () => {
      const otherPostId = await makePost(otherWorkerId, { status: 'published' });

      await expect(
        asWhatsappInternal(whatsappUrl, workerId, (client) =>
          client.query(
            `INSERT INTO worker_post_media
               (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
             VALUES ($1, $2, $3, 'v1', 0, 'image/jpeg', 1000, 'approved')`,
            [otherPostId, otherWorkerId, `${otherWorkerId}/posts/${otherPostId}/${randomUUID()}.jpg`],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  // -------------------------------------------------------------------------
  // Case 7 (pre-existing-table fix): worker_profile_media (011) gains an
  // internal-id-lane policy from migration 082 —
  // worker_profile_media_self_internal, FOR ALL TO jale_whatsapp. Without
  // it, 011's only policy (worker_profile_media_self, checks
  // app.current_user_id with no TO clause) never evaluates true for a
  // jale_whatsapp session on the internal-id lane, so the WhatsApp post
  // lane's profile-photo branch would fail RLS (42501) on real Postgres
  // despite already holding the INSERT grant from 011.
  // -------------------------------------------------------------------------
  describe('worker_profile_media_self_internal (011 table, policy added by 082)', () => {
    it('jale_whatsapp under the internal lane can INSERT its own worker_profile_media row', async () => {
      const mediaId = await asWhatsappInternal(whatsappUrl, workerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO worker_profile_media (user_id, media_type, s3_key, content_type)
           VALUES ($1, 'profile_photo', $2, 'image/jpeg')
           RETURNING id`,
          [workerId, `${workerId}/profile/${randomUUID()}.jpg`],
        );
        return result.rows[0].id;
      });
      expect(mediaId).toBeTruthy();

      const check = new Client({ connectionString: superuserUrl });
      await check.connect();
      try {
        const row = await check.query<{ user_id: string }>(
          `SELECT user_id FROM worker_profile_media WHERE id = $1`,
          [mediaId],
        );
        expect(row.rows[0].user_id).toBe(workerId);
      } finally {
        await check.end();
      }
    });

    it('jale_whatsapp under the internal lane cannot INSERT a worker_profile_media row for another user_id (WITH CHECK rejection)', async () => {
      await expect(
        asWhatsappInternal(whatsappUrl, workerId, (client) =>
          client.query(
            `INSERT INTO worker_profile_media (user_id, media_type, s3_key, content_type)
             VALUES ($1, 'profile_photo', $2, 'image/jpeg')`,
            [otherWorkerId, `${otherWorkerId}/profile/${randomUUID()}.jpg`],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  // -------------------------------------------------------------------------
  // Case 8: Recursion smoke — plain SELECT count(*) on both tables under
  // each lane completes without 42P17 (infinite recursion detected in
  // policy).
  // -------------------------------------------------------------------------
  describe('recursion smoke: SELECT count(*) never raises 42P17', () => {
    it('jale_admin, sub lane', async () => {
      const result = await asAdminSub(adminUrl, workerCognitoSub, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_posts`),
      );
      expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);

      const mediaResult = await asAdminSub(adminUrl, workerCognitoSub, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_post_media`),
      );
      expect(Number(mediaResult.rows[0].count)).toBeGreaterThanOrEqual(0);
    });

    it('jale_admin, internal lane (worker identity)', async () => {
      const result = await asAdminInternal(adminUrl, workerId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_posts`),
      );
      expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);

      const mediaResult = await asAdminInternal(adminUrl, workerId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_post_media`),
      );
      expect(Number(mediaResult.rows[0].count)).toBeGreaterThanOrEqual(0);
    });

    it('jale_admin, internal lane (employer identity — exercises the DEFINER helper)', async () => {
      const result = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_posts`),
      );
      expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);

      const mediaResult = await asAdminInternal(adminUrl, employerWithRelId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_post_media`),
      );
      expect(Number(mediaResult.rows[0].count)).toBeGreaterThanOrEqual(0);
    });

    it('jale_whatsapp, internal lane', async () => {
      const result = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_posts`),
      );
      expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(0);

      const mediaResult = await asWhatsappInternal(whatsappUrl, workerId, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM worker_post_media`),
      );
      expect(Number(mediaResult.rows[0].count)).toBeGreaterThanOrEqual(0);
    });

    it('jale_admin with no GUC set at all (default-deny, not recursion)', async () => {
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        // Deliberately NOT setting app.current_user_id or
        // app.current_internal_user_id — every USING clause resolves to
        // current_setting(..., true) = NULL, which is simply false, not an
        // error.
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM worker_posts`,
        );
        expect(result.rows[0].count).toBe('0');
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        await client.end();
      }
    });
  });
});
