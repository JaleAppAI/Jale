/**
 * org-worker-naming-138 -- migration 138 on a real bed: the contact-name
 * reader and the job-move definer, each run on its real login (jale_api,
 * jale_whatsapp) over a real authenticated connection, with the caller
 * context set as the Lambdas set it.
 *
 *  - the catalog (all profiles): both functions' owner (jale_cap_org_team),
 *    definer security, pinned search_path, result and callers; the capability
 *    owner's new column rights (employer_profiles.phone, job_conversations,
 *    job_conversation_messages, job_applications) and their four policies;
 *  - employer_contact_name: the trimmed contact name, NULL when it is empty
 *    or there is no profile; the same through jale_api (as a worker) and
 *    jale_whatsapp;
 *  - org_job_moved: one system notice per open conversation of the moved
 *    jobs, none on a closed one, the reply window and read state untouched;
 *    on a removal, hire contacts naming the old holder (by name, or by phone
 *    digits: the last 10 when both have 10) re-pointed to the new holder's
 *    whitespace-cleaned contact name with no phone and re-dated, only on the
 *    listed jobs, a suspended old holder included, and left alone when the
 *    new holder has none; the notice dated by clock_timestamp(); a
 *    120-character name clipped
 *    to 80 with no 23514; refused (P0001, DETAIL org_job_moved_refused) for
 *    a foreman, a job still on the old holder, another company's member or
 *    owner, and the same holder on both sides; malformed arguments raise
 *    22023;
 *  - the audit change log: job_applications is audited, but its hire-contact
 *    columns are not covered columns (audit-change-log.json), so the
 *    re-point leaves no change record, exactly like the employer's own
 *    hire-details save.
 * Fixtures are written through the superuser URL (World) and removed in
 * afterAll.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *   --container <name> --port <port> -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-worker-naming-138.integration.test.ts
 */
import type { Client } from 'pg';
import { World, type UserFixture } from './r-paths-world';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: org-worker-naming-138 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const ROW_PROFILES = ['standard', 'request'] as const;

const NAME_SQL = 'SELECT jale_cap.employer_contact_name($1) AS name';
const MOVED_SQL = 'SELECT jale_cap.org_job_moved($1::uuid[], $2, $3, $4) AS n';

const notice = (name: string, en = name) =>
  `Conversación transferida a ${name} / Conversation moved to ${en}`;

/** Both 138 functions: [signature, callers, pg_get_function_result, provolatile]. */
const FUNCTIONS: Array<[string, string[], string, string]> = [
  ['jale_cap.employer_contact_name(uuid)', ['jale_api', 'jale_whatsapp'], 'text', 's'],
  ['jale_cap.org_job_moved(uuid[], uuid, uuid, boolean)', ['jale_api'], 'integer', 'v'],
];
/** The hire-details date every fixture contact starts with. */
const OLD_STAMP = new Date('2026-01-01T00:00:00Z');

describe('138 org worker naming', () => {
  let world: World;

  beforeAll(async () => {
    if (!databaseUrl) return;
    world = new World(databaseUrl);
    await world.connect();
  });
  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      await world.su.query(`DELETE FROM employer_profiles WHERE user_id = ANY($1::uuid[])`, [world.users]);
      await world.cleanup();
    } finally {
      await world.end();
    }
  });

  /** Runs fn on `login` in one transaction with the caller context set; commits only when asked. */
  async function inTransaction<T>(login: string, caller: UserFixture | null, commit: boolean,
    fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient(login, async (c) => {
      await c.query('BEGIN');
      let done = false;
      try {
        if (caller) {
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
          await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
        }
        const result = await fn(c);
        if (commit) {
          await c.query('COMMIT');
          done = true;
        }
        return result;
      } finally {
        if (!done) await c.query('ROLLBACK');
      }
    });
  }
  async function rejects(c: Client, sql: string, params: unknown[], match: Record<string, unknown>): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject(match);
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }
  const REFUSED = { code: 'P0001', detail: 'org_job_moved_refused' };

  const moved = (owner: UserFixture, jobs: string[], from: string, to: string, removed: boolean) =>
    inTransaction('jale_api', owner, true, async (c) =>
      (await c.query<{ n: number }>(MOVED_SQL, [jobs, from, to, removed])).rows[0].n);

  async function setPhone(userId: string, phone: string): Promise<void> {
    await world.su.query('UPDATE employer_profiles SET phone = $2 WHERE user_id = $1', [userId, phone]);
  }
  /** Sets the hire contact as a save would, dated OLD_STAMP. */
  async function setHireContact(applicationId: string, name: string | null, phone: string | null): Promise<void> {
    await world.su.query(
      `UPDATE job_applications SET hire_contact_name = $2, hire_contact_phone = $3, hire_details_updated_at = $4 WHERE id = $1`,
      [applicationId, name, phone, OLD_STAMP]);
  }
  async function hireContact(applicationId: string) {
    return (await world.su.query<{ hire_contact_name: string | null; hire_contact_phone: string | null }>(
      'SELECT hire_contact_name, hire_contact_phone FROM job_applications WHERE id = $1', [applicationId])).rows[0];
  }
  async function hireStamp(applicationId: string): Promise<Date | null> {
    return (await world.su.query<{ at: Date | null }>(
      'SELECT hire_details_updated_at AS at FROM job_applications WHERE id = $1', [applicationId])).rows[0].at;
  }
  async function messages(conversationId: string) {
    return (await world.su.query<{ sender_type: string; direction: string; body: string; status: string; sender_user_id: string | null }>(
      `SELECT sender_type, direction, body, status, sender_user_id FROM job_conversation_messages
        WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId])).rows;
  }
  async function conversationState(conversationId: string) {
    return (await world.su.query(
      `SELECT employer_id, status, last_message_at, last_worker_message_at, employer_last_read_at, updated_at
         FROM job_conversations WHERE id = $1`, [conversationId])).rows[0];
  }

  /**
   * Owner O ("Olga" unless given) with foreman F ("Fer Gómez", phone
   * 15550100000) holding job J, which has an open conversation (worker W1,
   * a reply window and a read mark set) and a closed one (worker W2). Then
   * the owner's move: J goes from F to the given holder (O by default), and
   * the cascade (135) moves both conversations.
   */
  async function scene(opts: { ownerContact?: string | null; moveToOwner?: boolean } = {}) {
    const owner = await world.employer({
      companyName: 'Acme Fixture', ...(opts.ownerContact === null ? {} : { contactName: opts.ownerContact ?? 'Olga' }),
    });
    const foreman = await world.foreman(owner.id, { contactName: 'Fer Gómez' });
    await setPhone(foreman.id, '15550100000');
    const job = await world.job(foreman.id);
    const w1 = await world.worker();
    const w2 = await world.worker();
    const a1 = await world.application(job.id, w1.id);
    const a2 = await world.application(job.id, w2.id);
    const open = await world.conversation({
      jobId: job.id, employerId: foreman.id, workerId: w1.id, applicationId: a1,
      lastWorkerMessageAt: new Date('2026-10-27T12:00:00Z'),
    });
    await world.su.query(
      `UPDATE job_conversations SET employer_last_read_at = '2026-10-27T13:00:00Z', last_message_at = '2026-10-27T12:00:00Z'
        WHERE id = $1`, [open]);
    const closed = await world.conversation({ jobId: job.id, employerId: foreman.id, workerId: w2.id, applicationId: a2 });
    await world.su.query(`UPDATE job_conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [closed]);
    if (opts.moveToOwner !== false) {
      await world.su.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [owner.id, job.id]);
    }
    return { owner, foreman, job, w1, w2, a1, a2, open, closed };
  }

  describeInProfiles([...ALL_PROFILES], 'the catalog', () => {
    it('each 138 function has its owner, definer security, pinned search_path, result and callers', async () => {
      const actual = [];
      for (const [signature] of FUNCTIONS) {
        const { rows } = await world.su.query(
          `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                  l.lanname AS language, pg_catalog.pg_get_function_result(p.oid) AS returns,
                  p.provolatile::text AS volatility,
                  ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                         ORDER BY 1) AS callers
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
            WHERE p.oid = pg_catalog.to_regprocedure($1)`, [signature]);
        actual.push([signature, rows]);
      }
      expect(actual).toEqual(FUNCTIONS.map(([signature, callers, returns, volatility]) => [signature, [{
        owner: 'jale_cap_org_team', definer: true, config: ['search_path=pg_catalog, pg_temp'], language: 'plpgsql',
        returns, volatility, callers,
      }]]));
    });

    it('jale_cap_org_team gains employer_profiles.phone and the conversation, message and application columns, under four policies', async () => {
      const { rows } = await world.su.query<{ grants: string[] }>(
        `SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                          ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C") AS grants
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
          WHERE c.oid IN ('public.employer_profiles'::regclass, 'public.job_conversations'::regclass,
                          'public.job_conversation_messages'::regclass, 'public.job_applications'::regclass)
            AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege)`);
      expect(rows[0].grants).toEqual([
        'employer_profiles:contact_name:SELECT', 'employer_profiles:phone:SELECT', 'employer_profiles:user_id:SELECT',
        'job_applications:hire_contact_name:SELECT', 'job_applications:hire_contact_name:UPDATE',
        'job_applications:hire_contact_phone:SELECT', 'job_applications:hire_contact_phone:UPDATE',
        'job_applications:hire_details_updated_at:SELECT', 'job_applications:hire_details_updated_at:UPDATE',
        'job_applications:id:SELECT', 'job_applications:job_id:SELECT',
        'job_conversation_messages:body:INSERT', 'job_conversation_messages:conversation_id:INSERT',
        'job_conversation_messages:created_at:INSERT', 'job_conversation_messages:direction:INSERT', 'job_conversation_messages:sender_type:INSERT',
        'job_conversation_messages:status:INSERT',
        'job_conversations:id:SELECT', 'job_conversations:job_id:SELECT', 'job_conversations:status:SELECT',
      ]);
      const policies = await world.su.query(
        `SELECT p.polrelid::regclass::text AS rel, p.polname, p.polcmd, p.polpermissive,
                pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
           FROM pg_policy p
          WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)
            AND p.polrelid IN ('public.job_conversations'::regclass, 'public.job_conversation_messages'::regclass,
                               'public.job_applications'::regclass)
          ORDER BY 1, 2`);
      expect(policies.rows).toEqual([
        { rel: 'job_applications', polname: 'job_applications_cap_org_team_select', polcmd: 'r', polpermissive: true, using: 'true', with_check: null },
        { rel: 'job_applications', polname: 'job_applications_cap_org_team_update', polcmd: 'w', polpermissive: true, using: 'true', with_check: 'true' },
        { rel: 'job_conversation_messages', polname: 'job_conversation_messages_cap_org_team_insert', polcmd: 'a', polpermissive: true, using: null,
          with_check: "((sender_type = 'system'::text) AND (direction = 'outbound'::text))" },
        { rel: 'job_conversations', polname: 'job_conversations_cap_org_team_select', polcmd: 'r', polpermissive: true, using: 'true', with_check: null },
      ]);
      const count = await world.su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)`);
      expect(count.rows[0].n).toBe(18);
    });

    it('the message insert trigger is only 118\'s sender stamp, and nothing on the messages touches the conversation', async () => {
      const { rows } = await world.su.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.job_conversation_messages'::regclass AND NOT tgisinternal ORDER BY 1`);
      expect(rows).toEqual([{ tgname: 'job_messages_stamp_sender' }]);
    });
  });

  describeInProfiles([...ROW_PROFILES], 'employer_contact_name', () => {
    it('gives the trimmed contact name, and NULL when it is blank or there is no profile, on jale_api (as a worker) and jale_whatsapp', async () => {
      const ana = await world.employer({ contactName: '  Ana Ruiz ' });
      const blank = await world.employer({ companyName: 'Blank Fixture', contactName: '   ' });
      const none = await world.employer();
      const worker = await world.worker();
      const ids = [ana.id, blank.id, none.id];
      const expected = ['Ana Ruiz', null, null];

      const viaApi = await inTransaction('jale_api', worker, false, async (c) => {
        const out = [];
        for (const id of ids) out.push((await c.query<{ name: string | null }>(NAME_SQL, [id])).rows[0].name);
        return out;
      });
      const viaWhatsapp = await inTransaction('jale_whatsapp', null, false, async (c) => {
        const out = [];
        for (const id of ids) out.push((await c.query<{ name: string | null }>(NAME_SQL, [id])).rows[0].name);
        return out;
      });
      expect(viaApi).toEqual(expected);
      expect(viaWhatsapp).toEqual(expected);
      // The request login reads no employer_profiles row of an employer it has no relationship with.
      const direct = await inTransaction('jale_api', worker, false, async (c) =>
        (await c.query('SELECT 1 FROM employer_profiles WHERE user_id = $1', [ana.id])).rowCount);
      expect(direct).toBe(0);
    });
  });

  describeInProfiles([...ROW_PROFILES], 'org_job_moved', () => {
    it('reassign (p_removed false): one notice on the open conversation, none on the closed one, hire contacts and the reply window untouched', async () => {
      const s = await scene();
      await setHireContact(s.a1, 'fer gómez', '15550100000');
      const before = await conversationState(s.open);
      const closedBefore = await messages(s.closed);

      expect(await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, false)).toBe(1);

      expect(await messages(s.open)).toEqual([{
        sender_type: 'system', direction: 'outbound', body: notice('Olga'), status: 'sent', sender_user_id: null,
      }]);
      expect(await messages(s.closed)).toEqual(closedBefore);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'fer gómez', hire_contact_phone: '15550100000' });
      expect(await hireStamp(s.a1)).toEqual(OLD_STAMP);
      // The worker's 24h window, the employer's read mark, the inbox order: all as they were.
      expect(await conversationState(s.open)).toEqual({ ...before, employer_id: s.owner.id });
    });

    it('remove (p_removed true): contacts naming the old holder by name or by phone digits move to the new holder, no phone; others stay', async () => {
      const s = await scene();
      const w3 = await world.worker();
      const a3 = await world.application(s.job.id, w3.id);
      // By name, whatever the case; another phone of the worker's own is dropped. (The brief's
      // 'fer gómez ' cannot be stored: 125's CHECK keeps hire_contact_name trimmed.)
      await setHireContact(s.a1, 'fer gómez', '+1 555 999 0000');
      await setHireContact(s.a2, 'Site boss', '+1 (555) 010-0000');
      await setHireContact(a3, 'Site boss', '+1 (555) 010-9999');

      expect(await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true)).toBe(1);

      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
      expect(await hireContact(s.a2)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
      expect(await hireContact(a3)).toEqual({ hire_contact_name: 'Site boss', hire_contact_phone: '+1 (555) 010-9999' });
      expect(await messages(s.open)).toEqual([expect.objectContaining({ body: notice('Olga') })]);
      // Re-pointed details are re-dated; the untouched row keeps its date.
      expect((await hireStamp(s.a1))!.getTime()).toBeGreaterThan(OLD_STAMP.getTime());
      expect((await hireStamp(s.a2))!.getTime()).toBeGreaterThan(OLD_STAMP.getTime());
      expect(await hireStamp(a3)).toEqual(OLD_STAMP);
    });

    it('phones match on their last 10 digits when both have 10: 15550100000 against 555-010-0000; a short number must match whole', async () => {
      const s = await scene();
      const w3 = await world.worker();
      const a3 = await world.application(s.job.id, w3.id);
      await setHireContact(s.a1, 'Site boss', '555-010-0000');
      await setHireContact(s.a2, 'Site boss', '0100000');
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
      expect(await hireContact(s.a2)).toEqual({ hire_contact_name: 'Site boss', hire_contact_phone: '0100000' });
      expect(await hireContact(a3)).toEqual({ hire_contact_name: null, hire_contact_phone: null });
      // A short profile phone matches only the same digits.
      const t = await scene();
      await setPhone(t.foreman.id, '0100000');
      await setHireContact(t.a1, 'Site boss', '555-010-0000');
      await setHireContact(t.a2, 'Site boss', '010 0000');
      await moved(t.owner, [t.job.id], t.foreman.id, t.owner.id, true);
      expect(await hireContact(t.a1)).toEqual({ hire_contact_name: 'Site boss', hire_contact_phone: '555-010-0000' });
      expect(await hireContact(t.a2)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
    });

    it('a contact name with a newline and runs of spaces is cleaned to one line in the notice and the hire contact', async () => {
      const s = await scene({ ownerContact: ' Olga\n  Ruiz\t ' });
      await setHireContact(s.a1, 'Fer Gómez', null);
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await messages(s.open)).toEqual([expect.objectContaining({ body: notice('Olga Ruiz') })]);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga Ruiz', hire_contact_phone: null });
    });

    it('the notice is dated by clock_timestamp(): later than the moving transaction\'s start', async () => {
      const s = await scene();
      const { t0, at } = await inTransaction('jale_api', s.owner, false, async (c) => {
        await c.query(MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, false]);
        const r = await c.query<{ t0: Date; at: Date }>(
          `SELECT now() AS t0, (SELECT max(created_at) FROM job_conversation_messages WHERE conversation_id = $1) AS at`, [s.open]);
        return r.rows[0];
      });
      expect(at.getTime()).toBeGreaterThan(t0.getTime());
    });

    it('scope stays the listed jobs: a contact naming F on another job of the company is unchanged', async () => {
      const s = await scene();
      const other = await world.job(s.owner.id);
      const w = await world.worker();
      const a = await world.application(other.id, w.id);
      await setHireContact(a, 'Fer Gómez', '15550100000');
      await setHireContact(s.a1, 'Fer Gómez', null);
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
      expect(await hireContact(a)).toEqual({ hire_contact_name: 'Fer Gómez', hire_contact_phone: '15550100000' });
      expect(await hireStamp(a)).toEqual(OLD_STAMP);
    });

    it('a suspended old holder with p_removed true is accepted (the remove handler\'s real case)', async () => {
      const s = await scene();
      await world.su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [s.foreman.id]);
      await setHireContact(s.a1, 'Fer Gómez', null);
      expect(await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true)).toBe(1);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
    });

    it('the name match ignores case and surrounding spaces of the old holder\'s contact name', async () => {
      const s = await scene();
      await world.su.query(`UPDATE employer_profiles SET contact_name = '  FER GÓMEZ ' WHERE user_id = $1`, [s.foreman.id]);
      await setHireContact(s.a1, 'fer gómez', null);
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
    });

    it('an empty phone on either side never matches by phone', async () => {
      const s = await scene();
      await setPhone(s.foreman.id, '   ');
      await setHireContact(s.a1, 'Site boss', null);
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Site boss', hire_contact_phone: null });
    });

    it('remove to a holder with no contact name: hire contacts unchanged; the notice names another member', async () => {
      const s = await scene({ ownerContact: null });
      await setHireContact(s.a1, 'Fer Gómez', '15550100000');
      expect(await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true)).toBe(1);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Fer Gómez', hire_contact_phone: '15550100000' });
      expect(await messages(s.open)).toEqual([expect.objectContaining({
        body: 'Conversación transferida a otro miembro / Conversation moved to another member',
      })]);
    });

    it('a 120-character contact name is stored clipped to 80 (trailing space trimmed), with no 23514', async () => {
      const long = 'L'.repeat(120);
      const spaced = `${'S'.repeat(79)} ${'T'.repeat(40)}`;
      for (const [name, stored] of [[long, 'L'.repeat(80)], [spaced, 'S'.repeat(79)]] as const) {
        const s = await scene({ ownerContact: name });
        await setHireContact(s.a1, 'Fer Gómez', null);
        expect(await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true)).toBe(1);
        expect(await hireContact(s.a1)).toEqual({ hire_contact_name: stored, hire_contact_phone: null });
        expect(await messages(s.open)).toEqual([expect.objectContaining({ body: notice(stored) })]);
      }
    });

    it('moves several jobs at once (a removal) and counts every open conversation; a duplicate id counts once', async () => {
      const s = await scene({ moveToOwner: false });
      const job2 = await world.job(s.foreman.id);
      const w = await world.worker();
      const a = await world.application(job2.id, w.id);
      const open2 = await world.conversation({ jobId: job2.id, employerId: s.foreman.id, workerId: w.id, applicationId: a });
      await world.su.query('UPDATE jobs SET employer_id = $1 WHERE employer_id = $2', [s.owner.id, s.foreman.id]);
      expect(await moved(s.owner, [s.job.id, job2.id, s.job.id], s.foreman.id, s.owner.id, true)).toBe(2);
      expect(await messages(open2)).toEqual([expect.objectContaining({ body: notice('Olga') })]);
    });

    it('a move from the owner to a foreman names the foreman', async () => {
      const owner = await world.employer({ companyName: 'Acme Fixture', contactName: 'Olga' });
      const foreman = await world.foreman(owner.id, { contactName: 'Fer Gómez' });
      const job = await world.job(owner.id);
      const w = await world.worker();
      const a = await world.application(job.id, w.id);
      const conv = await world.conversation({ jobId: job.id, employerId: owner.id, workerId: w.id, applicationId: a });
      await world.su.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [foreman.id, job.id]);
      expect(await moved(owner, [job.id], owner.id, foreman.id, false)).toBe(1);
      expect(await messages(conv)).toEqual([expect.objectContaining({ body: notice('Fer Gómez') })]);
    });

    it('refuses (P0001, org_job_moved_refused) a foreman, a job still on the old holder, another company and a same-holder move; nothing is written', async () => {
      const s = await scene({ moveToOwner: false });
      const other = await world.employer({ companyName: 'Other Fixture', contactName: 'Otto' });
      const otherForeman = await world.foreman(other.id, { contactName: 'Oscar' });
      const removed = await world.foreman(s.owner.id, { status: 'removed', contactName: 'Rita' });
      await setHireContact(s.a1, 'Fer Gómez', null);

      await inTransaction('jale_api', s.owner, false, async (c) => {
        // The job is still on F.
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, true], REFUSED);
      });
      await world.su.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [s.owner.id, s.job.id]);
      await inTransaction('jale_api', s.foreman, false, async (c) => {
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, true], REFUSED);
      });
      await inTransaction('jale_api', other, false, async (c) => {
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, true], REFUSED);
      });
      await inTransaction('jale_api', s.owner, false, async (c) => {
        await rejects(c, MOVED_SQL, [[s.job.id], otherForeman.id, s.owner.id, true], REFUSED);
        await rejects(c, MOVED_SQL, [[s.job.id], removed.id, s.owner.id, true], REFUSED);
        await rejects(c, MOVED_SQL, [[s.job.id], s.owner.id, s.owner.id, false], REFUSED);
      });
      await inTransaction('jale_api', null, false, async (c) => {
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, true], REFUSED);
      });
      expect(await messages(s.open)).toEqual([]);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Fer Gómez', hire_contact_phone: null });
    });

    it('a malformed argument raises 22023', async () => {
      const s = await scene();
      await inTransaction('jale_api', s.owner, false, async (c) => {
        const bad = { code: '22023' };
        await rejects(c, MOVED_SQL, [[], s.foreman.id, s.owner.id, false], bad);
        await rejects(c, MOVED_SQL, [null, s.foreman.id, s.owner.id, false], bad);
        await rejects(c, MOVED_SQL, [[s.job.id, null], s.foreman.id, s.owner.id, false], bad);
        await rejects(c, MOVED_SQL, [[s.job.id], null, s.owner.id, false], bad);
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, null, false], bad);
        await rejects(c, MOVED_SQL, [[s.job.id], s.foreman.id, s.owner.id, null], bad);
      });
    });

    it('the audit change log: job_applications is audited, but the hire-contact re-point changes no covered column and leaves no record', async () => {
      const covered = await world.su.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.job_applications'::regclass AND tgname = 'job_applications_audit_change_update'`);
      expect(covered.rowCount).toBe(1);
      const s = await scene();
      await setHireContact(s.a1, 'Fer Gómez', '15550100000');
      const seq = (await world.su.query<{ seq: string }>('SELECT COALESCE(max(seq), 0)::text AS seq FROM jale_audit.changes')).rows[0].seq;
      await moved(s.owner, [s.job.id], s.foreman.id, s.owner.id, true);
      expect(await hireContact(s.a1)).toEqual({ hire_contact_name: 'Olga', hire_contact_phone: null });
      const records = await world.su.query(
        `SELECT table_name FROM jale_audit.changes WHERE seq > $1::bigint AND table_name = 'public.job_applications'`, [seq]);
      expect(records.rows).toEqual([]);
    });
  });
});
