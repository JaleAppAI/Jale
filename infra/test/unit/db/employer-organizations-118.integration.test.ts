/**
 * employer-organizations-118 -- migration 118 as the deployed jale_api login:
 * membership reads, the org helpers, the sign-up bootstrap and the actor
 * columns. Fixtures go through the superuser URL; assertions run as jale_api.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/employer-organizations-118.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: employer-organizations-118 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string };

maybeDescribe('migration 118: employer organizations', () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });
  afterAll(async () => {
    // Remove everything this suite committed, children first. Every person it
    // made has a cognito_sub starting org118-; their companies are found
    // through their memberships (organizations has no other link to them).
    // su.end() runs even when a cleanup statement fails.
    try {
      const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'org118-%'`))
        .rows.map((r) => r.id);
      const orgs = (await su.query<{ organization_id: string }>(
        `SELECT DISTINCT organization_id FROM organization_members WHERE user_id = ANY($1::uuid[])`, [ids],
      )).rows.map((r) => r.organization_id);
      // Conversations restrict their application; jobs cascade to applications
      // and their status events; applications restrict their worker.
      await su.query(`DELETE FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [orgs]);
      await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [orgs]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    } finally {
      await su.end();
    }
  });

  async function user(type: 'employer' | 'worker', name = 'Person'): Promise<Person> {
    const sub = `org118-${randomUUID()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [sub, type, name],
    );
    return { id: rows[0].id, sub };
  }

  async function company(owner: Person, name = 'ACME'): Promise<string> {
    const { rows } = await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name]);
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [owner.id, rows[0].id],
    );
    return rows[0].id;
  }

  async function member(org: string, person: Person, role: 'owner' | 'foreman', status = 'active'): Promise<void> {
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, $3, $4)`,
      [person.id, org, role, status],
    );
  }

  /** Runs fn as jale_api inside a transaction with both caller settings, then rolls back. */
  async function asApi<T>(caller: Person, fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient('jale_api', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  describeInProfiles(['standard', 'request'], 'membership reads as jale_api', () => {
    it('a foreman reads only their own membership row', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const other = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman');
      await member(org, other, 'foreman');

      const rows = await asApi(foreman, async (c) =>
        (await c.query<{ user_id: string }>(`SELECT user_id FROM organization_members`)).rows);
      expect(rows.map((r) => r.user_id)).toEqual([foreman.id]);
    });

    it('an active owner reads every member of their company and no one else', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman', 'suspended');
      const stranger = await user('employer');
      await company(stranger, 'Other Co');

      const ids = await asApi(owner, async (c) =>
        (await c.query<{ user_id: string }>(`SELECT user_id FROM organization_members ORDER BY user_id`)).rows.map((r) => r.user_id));
      expect(ids.sort()).toEqual([owner.id, foreman.id].sort());
    });

    // Each parameter is used with one type only: PostgreSQL refuses a
    // parameter deduced as text in one place and uuid in another.
    it('is_org_owner_of and shares_org_with: owner, foreman and another company', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman');
      const strangerOwner = await user('employer');
      await company(strangerOwner, 'Other Co');

      const result = await asApi(owner, async (c) => (await c.query(
        `SELECT jale_internal.is_org_owner_of($1::text, $2::uuid) AS owner_of_foreman,
                jale_internal.is_org_owner_of($1::text, $5::uuid) AS owner_of_self,
                jale_internal.is_org_owner_of($3::text, $5::uuid) AS foreman_of_owner,
                jale_internal.is_org_owner_of($4::text, $2::uuid) AS stranger_of_foreman,
                jale_internal.shares_org_with($3::text, $5::uuid) AS foreman_shares_owner,
                jale_internal.shares_org_with($4::text, $2::uuid) AS stranger_shares_foreman`,
        [owner.id, foreman.id, foreman.id, strangerOwner.id, owner.id],
      )).rows[0]);
      expect(result).toEqual({
        owner_of_foreman: true,
        owner_of_self: true,
        foreman_of_owner: false,
        stranger_of_foreman: false,
        foreman_shares_owner: true,
        stranger_shares_foreman: false,
      });
    });

    it('a removed caller no longer shares the company, but a removed member\'s rows stay with it', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman', 'removed');

      const result = await asApi(owner, async (c) => (await c.query(
        `SELECT jale_internal.shares_org_with($1::text, $2::uuid) AS removed_caller_shares,
                jale_internal.shares_org_with($3::text, $4::uuid) AS owner_shares_removed_member,
                jale_internal.org_member_scope($1::text)::text[] AS removed_caller_scope,
                jale_internal.org_member_scope($3::text)::text[] AS owner_member_scope`,
        [foreman.id, owner.id, owner.id, foreman.id],
      )).rows[0]);
      expect(result.removed_caller_shares).toBe(false);
      expect(result.owner_shares_removed_member).toBe(true);
      expect(result.removed_caller_scope).toEqual([]);
      expect([...result.owner_member_scope].sort()).toEqual([owner.id, foreman.id].sort());
    });

    it('org_owner_scope gives the active owner every member id, and only the active ones with active_only', async () => {
      const owner = await user('employer');
      const active = await user('employer');
      const suspended = await user('employer');
      const removed = await user('employer');
      const org = await company(owner);
      await member(org, active, 'foreman');
      await member(org, suspended, 'foreman', 'suspended');
      await member(org, removed, 'foreman', 'removed');
      const stranger = await user('employer');
      await company(stranger, 'Other Co');

      const scope = await asApi(owner, async (c) => (await c.query(
        `SELECT jale_internal.org_owner_scope($1::text, false)::text[] AS everyone,
                jale_internal.org_owner_scope($1::text, true)::text[] AS active_only,
                jale_internal.org_owner_scope(upper($1::text), false)::text[] AS upper_case`,
        [owner.id],
      )).rows[0]);
      expect([...scope.everyone].sort()).toEqual([owner.id, active.id, suspended.id, removed.id].sort());
      expect([...scope.active_only].sort()).toEqual([owner.id, active.id].sort());
      // The uuid check is case-insensitive, like the uuid type itself.
      expect([...scope.upper_case].sort()).toEqual([...scope.everyone].sort());
    });

    it('org_owner_scope is empty for a foreman and for a malformed caller', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman');
      const stranger = await user('employer');
      await company(stranger, 'Other Co');

      const scopes = await asApi(foreman, async (c) => (await c.query(
        `SELECT jale_internal.org_owner_scope($1::text, false)::text[] AS foreman,
                jale_internal.org_owner_scope($2::text, false)::text[] AS other_company_owner,
                jale_internal.org_owner_scope(NULL, false)::text[] AS null_caller,
                jale_internal.org_owner_scope('', false)::text[] AS empty_caller,
                jale_internal.org_owner_scope('not-a-uuid', false)::text[] AS garbage,
                jale_internal.org_owner_scope($3::text, false)::text[] AS padded,
                jale_internal.is_org_owner_of('not-a-uuid', $4::uuid) AS garbage_owner_of`,
        [foreman.id, stranger.id, ` ${owner.id}`, foreman.id],
      )).rows[0]);
      expect(scopes).toEqual({
        foreman: [],
        other_company_owner: [stranger.id], // their own company only, never this one
        null_caller: [],
        empty_caller: [],
        garbage: [],
        padded: [],
        garbage_owner_of: false,
      });
    });

    it('org_member_scope gives an active member the whole company; a suspended, unknown or malformed caller gets none', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const suspended = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman');
      await member(org, suspended, 'foreman', 'suspended');
      const outsider = await user('employer');

      const scopes = await asApi(foreman, async (c) => (await c.query(
        `SELECT jale_internal.org_member_scope($1::text)::text[] AS foreman,
                jale_internal.org_member_scope($2::text)::text[] AS suspended,
                jale_internal.org_member_scope($3::text)::text[] AS no_membership,
                jale_internal.org_member_scope('not-a-uuid')::text[] AS garbage`,
        [foreman.id, suspended.id, outsider.id],
      )).rows[0]);
      expect([...scopes.foreman].sort()).toEqual([owner.id, foreman.id, suspended.id].sort());
      expect(scopes.suspended).toEqual([]);
      expect(scopes.no_membership).toEqual([]);
      expect(scopes.garbage).toEqual([]);
    });
  });

  describeInProfiles(['standard', 'request'], 'employer_display_name', () => {
    it('names a foreman by the owner\'s company, and a one-person company as before', async () => {
      const owner = await user('employer');
      const foreman = await user('employer');
      const org = await company(owner);
      await member(org, foreman, 'foreman');
      await su.query(`INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, 'ACME Roofing')`, [owner.id]);
      const solo = await user('employer');
      await company(solo, 'Solo');
      await su.query(`INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, 'Solo Builders')`, [solo.id]);

      const names = await asApi(owner, async (c) => (await c.query(
        `SELECT public.employer_display_name($1) AS foreman, public.employer_display_name($2) AS solo,
                public.employer_display_name(gen_random_uuid()) AS nobody`,
        [foreman.id, solo.id],
      )).rows[0]);
      expect(names).toEqual({ foreman: 'ACME Roofing', solo: 'Solo Builders', nobody: 'Empleador' });
    });
  });

  describeInProfiles(['standard', 'request'], 'employer_ensure_organization', () => {
    it('creates one company with the caller as active owner, and is idempotent', async () => {
      const employer = await user('employer', 'Fallback Name');
      const [first, second] = await asApi(employer, async (c) => {
        const a = (await c.query<{ org: string }>(`SELECT public.employer_ensure_organization($1) AS org`, ['ACME Roofing'])).rows[0].org;
        const b = (await c.query<{ org: string }>(`SELECT public.employer_ensure_organization($1) AS org`, ['Ignored'])).rows[0].org;
        const mine = (await c.query(`SELECT organization_id, role, status FROM organization_members`)).rows;
        expect(mine).toEqual([{ organization_id: a, role: 'owner', status: 'active' }]);
        return [a, b];
      });
      expect(second).toBe(first);
    });

    it('falls back to the users.full_name, then "Employer", when the company name is blank', async () => {
      const employer = await user('employer', 'Pat Builder');
      const blank = await user('employer', '   ');
      // jale_api cannot read organizations: commit as jale_api, then read as superuser.
      await withLoginClient('jale_api', async (c) => {
        for (const p of [employer, blank]) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [p.sub]);
          await c.query(`SELECT public.employer_ensure_organization('  ')`);
          await c.query('COMMIT');
        }
      });
      const names = (await su.query<{ id: string; name: string }>(
        `SELECT m.user_id AS id, o.name FROM organization_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = ANY($1::uuid[])`,
        [[employer.id, blank.id]],
      )).rows;
      expect(Object.fromEntries(names.map((r) => [r.id, r.name]))).toEqual({ [employer.id]: 'Pat Builder', [blank.id]: 'Employer' });
    });

    it('refuses a worker', async () => {
      const worker = await user('worker');
      await expect(asApi(worker, (c) => c.query(`SELECT public.employer_ensure_organization('X')`)))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a call with no caller context', async () => {
      await expect(withLoginClient('jale_api', (c) => c.query(`SELECT public.employer_ensure_organization('X')`)))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('jale_api cannot read organizations or write memberships directly', async () => {
      const employer = await user('employer');
      await asApi(employer, async (c) => {
        await expect(c.query(`SELECT name FROM organizations`)).rejects.toMatchObject({ code: '42501' });
      });
      await asApi(employer, async (c) => {
        await expect(c.query(
          `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, gen_random_uuid(), 'owner')`,
          [employer.id],
        )).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  describeInProfiles(['standard', 'request'], 'actor columns', () => {
    it('stamps created_by_user_id from employer_id on insert, ignoring a supplied value', async () => {
      const employer = await user('employer');
      const other = await user('employer');
      const { rows } = await su.query(
        `INSERT INTO jobs (employer_id, title, location, job_type, status, created_by_user_id)
         VALUES ($1, 'T', 'Austin', 'full-time', 'active', $2) RETURNING created_by_user_id`,
        [employer.id, other.id],
      );
      expect(rows[0].created_by_user_id).toBe(employer.id);
    });

    it('created_by survives an employer_id change on a pre-118 job', async () => {
      const poster = await user('employer');
      const next = await user('employer');
      // 129: a job moves only between active members of one company.
      await member(await company(poster), next, 'foreman');
      const job = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
        [poster.id],
      )).rows[0].id;
      // Simulate a job created before 118: the column is NULL. One
      // transaction, so the trigger can never stay disabled on a shared bed.
      await su.query('BEGIN');
      try {
        await su.query(`ALTER TABLE jobs DISABLE TRIGGER jobs_stamp_created_by`);
        await su.query(`UPDATE jobs SET created_by_user_id = NULL WHERE id = $1`, [job]);
        await su.query(`ALTER TABLE jobs ENABLE TRIGGER jobs_stamp_created_by`);
        await su.query('COMMIT');
      } catch (err) {
        await su.query('ROLLBACK');
        throw err;
      }

      await su.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [next.id, job]);
      const after = (await su.query(`SELECT employer_id, created_by_user_id FROM jobs WHERE id = $1`, [job])).rows[0];
      expect(after).toEqual({ employer_id: next.id, created_by_user_id: poster.id });

      // A later change keeps the original poster.
      await su.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [poster.id, job]);
      await su.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [next.id, job]);
      expect((await su.query(`SELECT created_by_user_id FROM jobs WHERE id = $1`, [job])).rows[0].created_by_user_id)
        .toBe(poster.id);
    });

    it('records the session caller as actor_user_id on application status events', async () => {
      const employer = await user('employer');
      const worker = await user('worker');
      const job = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer.id],
      )).rows[0].id;
      const app = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [job, worker.id],
      )).rows[0].id;
      await su.query('BEGIN');
      await su.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employer.id]);
      await su.query(`UPDATE job_applications SET status = 'hired' WHERE id = $1`, [app]);
      await su.query('COMMIT');
      const events = (await su.query(
        `SELECT to_status, actor_user_id FROM job_application_status_events WHERE application_id = $1 ORDER BY changed_at, id`,
        [app],
      )).rows;
      expect(events[events.length - 1]).toEqual({ to_status: 'hired', actor_user_id: employer.id });
    });

    it('records NULL when the caller setting is unset or not a uuid', async () => {
      const employer = await user('employer');
      const worker = await user('worker');
      const job = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer.id],
      )).rows[0].id;
      await su.query('BEGIN');
      await su.query(`SELECT set_config('app.current_internal_user_id', 'not-a-uuid', true)`);
      const app = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [job, worker.id],
      )).rows[0].id;
      await su.query('COMMIT');
      const events = (await su.query(`SELECT actor_user_id FROM job_application_status_events WHERE application_id = $1`, [app])).rows;
      expect(events).toEqual([{ actor_user_id: null }]);
    });

    it('stamps sender_user_id from the session caller on an employer message, whatever was supplied, and NULL on a worker message', async () => {
      const employer = await user('employer');
      const other = await user('employer');
      const worker = await user('worker');
      const job = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer.id],
      )).rows[0].id;
      const app = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [job, worker.id],
      )).rows[0].id;
      const conv = (await su.query<{ id: string }>(
        `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [job, employer.id, worker.id, app],
      )).rows[0].id;

      await su.query('BEGIN');
      try {
        await su.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employer.id]);
        const rows = (await su.query<{ sender_type: string; sender_user_id: string | null }>(
          `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, sender_user_id)
           VALUES ($1, 'employer', 'outbound', 'hi', 'queued', $2),
                  ($1, 'worker', 'inbound', 'hello', 'received', $2)
           RETURNING sender_type, sender_user_id`,
          [conv, other.id],
        )).rows;
        expect(rows.sort((a, b) => a.sender_type.localeCompare(b.sender_type))).toEqual([
          { sender_type: 'employer', sender_user_id: employer.id },
          { sender_type: 'worker', sender_user_id: null },
        ]);

        // No caller (or a malformed one): an employer message records NULL.
        await su.query(`SELECT set_config('app.current_internal_user_id', 'not-a-uuid', true)`);
        const unset = (await su.query<{ sender_user_id: string | null }>(
          `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, sender_user_id)
           VALUES ($1, 'employer', 'outbound', 'again', 'queued', $2) RETURNING sender_user_id`,
          [conv, other.id],
        )).rows;
        expect(unset).toEqual([{ sender_user_id: null }]);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('an UPDATE never changes sender_user_id', async () => {
      const employer = await user('employer');
      const other = await user('employer');
      const worker = await user('worker');
      const job = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer.id],
      )).rows[0].id;
      const app = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [job, worker.id],
      )).rows[0].id;
      const conv = (await su.query<{ id: string }>(
        `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [job, employer.id, worker.id, app],
      )).rows[0].id;

      await su.query('BEGIN');
      try {
        await su.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employer.id]);
        const [employerMessage, workerMessage] = (await su.query<{ id: string }>(
          `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
           VALUES ($1, 'employer', 'outbound', 'hi', 'queued'),
                  ($1, 'worker', 'inbound', 'hello', 'received')
           RETURNING id`,
          [conv],
        )).rows.map((r) => r.id);

        // Even with another caller in the session, an UPDATE keeps the stamped value.
        await su.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [other.id]);
        const read = async (id: string) =>
          (await su.query(`SELECT sender_user_id FROM job_conversation_messages WHERE id = $1`, [id])).rows[0].sender_user_id;
        await su.query(`UPDATE job_conversation_messages SET sender_user_id = $1 WHERE id = $2`, [other.id, employerMessage]);
        expect(await read(employerMessage)).toBe(employer.id);
        await su.query(`UPDATE job_conversation_messages SET sender_user_id = NULL WHERE id = $1`, [employerMessage]);
        expect(await read(employerMessage)).toBe(employer.id);
        await su.query(`UPDATE job_conversation_messages SET sender_user_id = $1 WHERE id = $2`, [other.id, workerMessage]);
        expect(await read(workerMessage)).toBeNull();
        // An UPDATE of other columns leaves it alone too.
        await su.query(`UPDATE job_conversation_messages SET body = 'edited' WHERE id = $1`, [employerMessage]);
        expect(await read(employerMessage)).toBe(employer.id);
      } finally {
        await su.query('ROLLBACK');
      }
    });
  });
});
