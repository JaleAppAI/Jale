/**
 * employer-org-owner-access-119 -- as the deployed jale_api login, a
 * company's active owner reaches every member's jobs, applicants and
 * conversations; a foreman reaches only their own; nobody reaches another
 * company. Fixtures through the superuser URL; afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/employer-org-owner-access-119.integration.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: employer-org-owner-access-119 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string };
type World = {
  owner: Person; foremanA: Person; foremanB: Person; stranger: Person; worker: Person;
  jobA: string; jobB: string; strangerJob: string; appA: string; convA: string; messageA: string;
  outboxA: string; documentA: string; visibilityA: string; templateA: string;
};

maybeDescribe('migration 119: owner-wide access', () => {
  let su: Client;
  let w: World;

  async function user(type: 'employer' | 'worker'): Promise<Person> {
    const sub = `org119-${randomUUID()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, full_name, phone) VALUES ($1, $2, 'P', '+15550001111') RETURNING id`,
      [sub, type],
    );
    return { id: rows[0].id, sub };
  }
  async function job(employer: Person): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, 'T', 'Austin', 'full-time', 'active') RETURNING id`,
      [employer.id],
    )).rows[0].id;
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    const owner = await user('employer');
    const foremanA = await user('employer');
    const foremanB = await user('employer');
    const stranger = await user('employer');
    const worker = await user('worker');
    const org = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('ACME') RETURNING id`)).rows[0].id;
    const otherOrg = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Other') RETURNING id`)).rows[0].id;
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $3, 'owner'), ($2, $4, 'owner')`,
      [owner.id, stranger.id, org, otherOrg],
    );
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $3, 'foreman'), ($2, $3, 'foreman')`,
      [foremanA.id, foremanB.id, org],
    );
    const jobA = await job(foremanA);
    const jobB = await job(foremanB);
    const strangerJob = await job(stranger);
    const appA = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [jobA, worker.id],
    )).rows[0].id;
    const convA = (await su.query<{ id: string }>(
      `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, last_message_at, worker_thread_number)
       VALUES ($1, $2, $3, $4, now(), 1) RETURNING id`,
      [jobA, foremanA.id, worker.id, appA],
    )).rows[0].id;
    // sender_user_id is stamped by 118's trigger (NULL here: no session caller).
    const messageA = (await su.query<{ id: string }>(
      `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
       VALUES ($1, 'employer', 'outbound', 'hi', 'queued') RETURNING id`,
      [convA],
    )).rows[0].id;
    // An outbox row already sent, so no sender or sweeper on the bed picks it up.
    const outboxA = (await su.query<{ id: string }>(
      `INSERT INTO job_message_outbox (conversation_id, message_id, whatsapp_number, send_kind, body, status, sent_at)
       VALUES ($1, $2, '+15550001111', 'freeform', 'hi', 'sent', now()) RETURNING id`,
      [convA, messageA],
    )).rows[0].id;
    await su.query(`INSERT INTO worker_profiles (user_id) VALUES ($1)`, [worker.id]);
    // worker_skills' NOT NULL columns (worker_id, skill); cascades from users.
    await su.query(`INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'roofing')`, [worker.id]);
    // A job-scoped document on jobA, with r-paths-world.ts's column set (:217-224).
    const documentA = (await su.query<{ id: string }>(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       VALUES ($1, $2, 'driver_license', $3, 'driver_license.pdf', 1024, 'application/pdf', NULL) RETURNING id`,
      [worker.id, jobA, `documents/fixture/${randomUUID()}.pdf`],
    )).rows[0].id;
    // employer_candidate_rankings' NOT NULL columns (014).
    await su.query(
      `INSERT INTO employer_candidate_rankings (job_id, worker_id, application_id, rank, score, score_band, ranking_version, source_hash)
       VALUES ($1, $2, $3, 1, 80, 'strong', 'org119', 'org119-hash')`,
      [jobA, worker.id, appA],
    );
    // A visibility event already sent, so the drain ignores it (062).
    const visibilityA = (await su.query<{ id: string }>(
      `INSERT INTO job_visibility_events (job_id, public_code, event_kind, status, sent_at)
       VALUES ($1, 'org119', 'published', 'sent', now()) RETURNING id`,
      [jobA],
    )).rows[0].id;
    // employer_job_templates' NOT NULL columns (069:18-26): employer_id, name, payload.
    const templateA = (await su.query<{ id: string }>(
      `INSERT INTO employer_job_templates (employer_id, name, payload) VALUES ($1, 'Roofers', '{}'::jsonb) RETURNING id`,
      [foremanA.id],
    )).rows[0].id;
    w = {
      owner, foremanA, foremanB, stranger, worker, jobA, jobB, strangerJob, appA, convA, messageA,
      outboxA, documentA, visibilityA, templateA,
    };
  });
  afterAll(async () => {
    // Remove everything this suite committed, children first. Every person it
    // made has a cognito_sub starting org119-, so a half-built world is
    // cleaned up too; their companies are found through their memberships.
    const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'org119-%'`))
      .rows.map((r) => r.id);
    const orgs = (await su.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM organization_members WHERE user_id = ANY($1::uuid[])`, [ids],
    )).rows.map((r) => r.organization_id);
    // job_visibility_events has no FK to jobs.
    await su.query(
      `DELETE FROM job_visibility_events WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = ANY($1::uuid[]))`, [ids]);
    // Conversations restrict their application; their messages and outbox rows cascade.
    await su.query(`DELETE FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[])`, [ids]);
    await su.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [ids]);
    // Jobs cascade to applications and rankings; applications restrict their worker.
    await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [ids]);
    await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [orgs]);
    await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [orgs]);
    // worker_profiles and employer_job_templates cascade from users.
    await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    await su.end();
  });

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
  const count = async (c: Client, sql: string, params: unknown[] = []) =>
    Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) q`, params)).rows[0].n);
  /** Runs an expected-error query under a savepoint, so the transaction stays usable. */
  async function rejects(c: Client, sql: string, params: unknown[], code: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject({ code });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }
  const tokenHash = () => createHash('sha256').update(randomUUID()).digest('hex');

  describeInProfiles(['standard', 'request'], 'reads', () => {
    it('the owner sees both foremen\'s jobs; each foreman only their own; nobody sees the stranger\'s', async () => {
      const visible = async (p: Person) => asApi(p, async (c) =>
        (await c.query<{ id: string }>(`SELECT id FROM jobs WHERE id = ANY($1::uuid[])`, [[w.jobA, w.jobB, w.strangerJob]])).rows.map((r) => r.id).sort());
      expect(await visible(w.owner)).toEqual([w.jobA, w.jobB].sort());
      expect(await visible(w.foremanA)).toEqual([w.jobA]);
      expect(await visible(w.foremanB)).toEqual([w.jobB]);
    });

    it('the owner reads foreman A\'s applicants, conversations and messages; foreman B reads none', async () => {
      for (const [p, expected] of [[w.owner, 1], [w.foremanA, 1], [w.foremanB, 0], [w.stranger, 0]] as const) {
        await asApi(p, async (c) => {
          expect(await count(c, `SELECT 1 FROM job_applications WHERE id = $1`, [w.appA])).toBe(expected);
          expect(await count(c, `SELECT 1 FROM job_conversations WHERE id = $1`, [w.convA])).toBe(expected);
          expect(await count(c, `SELECT 1 FROM job_conversation_messages WHERE conversation_id = $1`, [w.convA])).toBe(expected);
        });
      }
    });

    it('the owner and foreman A read the worker\'s profile, job document, outbox row, ranking and visibility event; foreman B and the stranger read none', async () => {
      for (const [p, expected] of [[w.owner, 1], [w.foremanA, 1], [w.foremanB, 0], [w.stranger, 0]] as const) {
        await asApi(p, async (c) => {
          expect(await count(c, `SELECT 1 FROM worker_profiles WHERE user_id = $1`, [w.worker.id])).toBe(expected);
          expect(await count(c, `SELECT 1 FROM worker_documents WHERE id = $1`, [w.documentA])).toBe(expected);
          expect(await count(c, `SELECT 1 FROM job_message_outbox WHERE id = $1`, [w.outboxA])).toBe(expected);
          expect(await count(c, `SELECT 1 FROM employer_candidate_rankings WHERE job_id = $1 AND worker_id = $2`, [w.jobA, w.worker.id]))
            .toBe(expected);
          expect(await count(c, `SELECT 1 FROM job_visibility_events WHERE id = $1`, [w.visibilityA])).toBe(expected);
        });
      }
    });

    it('foreman B cannot reach foreman A\'s applicant through any path', async () => {
      await asApi(w.foremanB, async (c) => {
        expect(await count(c, `SELECT 1 FROM users WHERE id = $1`, [w.worker.id])).toBe(0);
        expect(await count(c, `SELECT 1 FROM worker_profiles WHERE user_id = $1`, [w.worker.id])).toBe(0);
        expect((await c.query(`SELECT jale_internal.employer_has_applicant_relationship($1, $2) AS r`, [w.foremanB.id, w.worker.id])).rows[0].r).toBe(false);
        await rejects(c, `SELECT * FROM jale_cap.employer_stage_recipient($1)`, [w.appA], '42501');
        // 105:576-792: (worker, kind, source application, payload, message); a NULL message is allowed.
        await rejects(c, `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'application_stage', $2, '{}'::jsonb, NULL)`,
          [w.worker.id, w.appA], '42501');
        const issued = await c.query(`SELECT outcome FROM jale_cap.upload_token_issue($1, $2, $3)`, [tokenHash(), w.jobA, w.worker.id]);
        expect(issued.rows[0].outcome).toBe('forbidden');
      });
    });

    it('the owner reaches foreman A\'s applicant through the predicate and the capability functions', async () => {
      await asApi(w.owner, async (c) => {
        expect(await count(c, `SELECT 1 FROM users WHERE id = $1`, [w.worker.id])).toBe(1);
        expect((await c.query(`SELECT jale_internal.employer_has_applicant_relationship($1, $2) AS r`, [w.owner.id, w.worker.id])).rows[0].r).toBe(true);
        const recipient = await c.query(`SELECT worker_id FROM jale_cap.employer_stage_recipient($1)`, [w.appA]);
        expect(recipient.rows[0].worker_id).toBe(w.worker.id);
        // The owner passes both caller checks (the applicant relationship and the
        // application's job) and stops at the status check: appA is 'pending',
        // which notifies nobody, so the function raises invalid_parameter_value.
        await rejects(c, `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'application_stage', $2, '{}'::jsonb, NULL)`,
          [w.worker.id, w.appA], '22023');
        const issued = await c.query(`SELECT outcome FROM jale_cap.upload_token_issue($1, $2, $3)`, [tokenHash(), w.jobA, w.worker.id]);
        expect(issued.rows[0].outcome).toBe('ok');
      });
    });

    it('every active member reads the company templates; the stranger does not', async () => {
      for (const [p, expected] of [[w.owner, 1], [w.foremanA, 1], [w.foremanB, 1], [w.stranger, 0]] as const) {
        await asApi(p, async (c) => expect(await count(c, `SELECT 1 FROM employer_job_templates WHERE id = $1`, [w.templateA])).toBe(expected));
      }
    });
  });

  describeInProfiles(['standard', 'request'], 'writes', () => {
    it('the owner can reassign a job only to an active member of the company', async () => {
      await asApi(w.owner, async (c) => {
        const ok = await c.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.foremanB.id, w.jobA]);
        expect(ok.rowCount).toBe(1);
        await rejects(c, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.stranger.id, w.jobB], '42501');
      });
      // jobs_org_owner_update's WITH CHECK uses org_owner_scope(..., true).
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.foremanB.id]);
      try {
        await asApi(w.owner, async (c) => {
          await rejects(c, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.foremanB.id, w.jobA], '42501');
        });
      } finally {
        await su.query(`UPDATE organization_members SET status = 'active' WHERE user_id = $1`, [w.foremanB.id]);
      }
    });

    it('a foreman cannot update or delete another foreman\'s job', async () => {
      await asApi(w.foremanB, async (c) => {
        expect((await c.query(`UPDATE jobs SET title = 'x' WHERE id = $1`, [w.jobA])).rowCount).toBe(0);
        expect((await c.query(`DELETE FROM jobs WHERE id = $1`, [w.jobA])).rowCount).toBe(0);
      });
    });

    it('the owner can delete foreman A\'s template; foreman B cannot', async () => {
      await asApi(w.foremanB, async (c) => {
        expect((await c.query(`DELETE FROM employer_job_templates WHERE id = $1`, [w.templateA])).rowCount).toBe(0);
      });
      await asApi(w.owner, async (c) => {
        expect((await c.query(`DELETE FROM employer_job_templates WHERE id = $1`, [w.templateA])).rowCount).toBe(1);
      });
    });

    it('a suspended owner row is impossible', async () => {
      await expect(su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.owner.id]))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('a removed foreman loses the company template read but keeps nothing else new', async () => {
      await su.query(`UPDATE organization_members SET status = 'removed' WHERE user_id = $1`, [w.foremanB.id]);
      try {
        await asApi(w.foremanB, async (c) => {
          expect(await count(c, `SELECT 1 FROM employer_job_templates WHERE id = $1`, [w.templateA])).toBe(0);
        });
      } finally {
        await su.query(`UPDATE organization_members SET status = 'active' WHERE user_id = $1`, [w.foremanB.id]);
      }
    });

    it('a removed member\'s templates stay with the company', async () => {
      await su.query(`UPDATE organization_members SET status = 'removed' WHERE user_id = $1`, [w.foremanA.id]);
      try {
        for (const p of [w.owner, w.foremanB]) {
          await asApi(p, async (c) => expect(await count(c, `SELECT 1 FROM employer_job_templates WHERE id = $1`, [w.templateA])).toBe(1));
        }
      } finally {
        await su.query(`UPDATE organization_members SET status = 'active' WHERE user_id = $1`, [w.foremanA.id]);
      }
    });
  });

  // Every write path an owner's handler takes on a member's rows (Tasks 6-9),
  // as the deployed jale_api login. Each case is one rolled-back transaction
  // (asApi); expected errors run under a savepoint (rejects).
  describeInProfiles(['standard', 'request'], 'owner writes', () => {
    /** A second thread on convA's application: worker_thread_number 2 (convA holds 1). */
    const reopen = `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, last_message_at, worker_thread_number)
                    VALUES ($1, $2, $3, $4, now(), 2)`;
    const reopenParams = () => [w.jobA, w.foremanA.id, w.worker.id, w.appA];
    const sendMessage = `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
                         VALUES ($1, 'employer', 'outbound', 'x', 'queued') RETURNING sender_user_id`;
    // job_message_outbox (025): whatsapp_number is NOT NULL, and for jale_api
    // its recipient trigger replaces it with the conversation's worker number.
    // Already 'sent', so nothing would pick it up even if it were committed.
    const queueOutbox = `INSERT INTO job_message_outbox (conversation_id, whatsapp_number, send_kind, body, status, sent_at)
                         VALUES ($1, '+15550000000', 'freeform', 'x', 'sent', now()) RETURNING id`;
    const claimChat = `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'employer_chat', $2, '{}'::jsonb, NULL)`;

    it('a. the owner moves foreman A\'s applicant to contacted; foreman B and the stranger change nothing', async () => {
      const contact = `UPDATE job_applications SET status = 'contacted' WHERE id = $1`;
      await asApi(w.owner, async (c) => expect((await c.query(contact, [w.appA])).rowCount).toBe(1));
      await asApi(w.foremanB, async (c) => expect((await c.query(contact, [w.appA])).rowCount).toBe(0));
      await asApi(w.stranger, async (c) => expect((await c.query(contact, [w.appA])).rowCount).toBe(0));
    });

    it('b. the owner closes foreman A\'s conversation and opens a new thread for it; foreman B can do neither', async () => {
      const close = `UPDATE job_conversations SET status = 'closed' WHERE id = $1`;
      await asApi(w.owner, async (c) => {
        expect((await c.query(close, [w.convA])).rowCount).toBe(1);
        expect((await c.query(reopen, reopenParams())).rowCount).toBe(1);
      });
      await asApi(w.foremanB, async (c) => {
        expect((await c.query(close, [w.convA])).rowCount).toBe(0);
        await rejects(c, reopen, reopenParams(), '42501');
      });
    });

    it('c. the owner sends in foreman A\'s conversation, stamped as the owner (118 trigger); foreman B and the stranger cannot', async () => {
      await asApi(w.owner, async (c) => {
        const sent = await c.query<{ sender_user_id: string }>(sendMessage, [w.convA]);
        expect(sent.rows[0].sender_user_id).toBe(w.owner.id);
      });
      await asApi(w.foremanB, async (c) => rejects(c, sendMessage, [w.convA], '42501'));
      await asApi(w.stranger, async (c) => rejects(c, sendMessage, [w.convA], '42501'));
    });

    it('d. the owner queues and updates an outbox row on foreman A\'s conversation; foreman B can do neither', async () => {
      await asApi(w.owner, async (c) => {
        const queued = await c.query<{ id: string }>(queueOutbox, [w.convA]);
        expect(queued.rowCount).toBe(1);
        const touched = await c.query(`UPDATE job_message_outbox SET attempt_count = attempt_count WHERE id = $1`, [queued.rows[0].id]);
        expect(touched.rowCount).toBe(1);
      });
      await asApi(w.foremanB, async (c) => {
        await rejects(c, queueOutbox, [w.convA], '42501');
        expect((await c.query(`UPDATE job_message_outbox SET attempt_count = attempt_count WHERE id = $1`, [w.outboxA])).rowCount).toBe(0);
      });
    });

    it('e. the owner renames foreman A\'s template; foreman B cannot', async () => {
      const rename = `UPDATE employer_job_templates SET name = 'Renamed' WHERE id = $1`;
      await asApi(w.owner, async (c) => expect((await c.query(rename, [w.templateA])).rowCount).toBe(1));
      await asApi(w.foremanB, async (c) => expect((await c.query(rename, [w.templateA])).rowCount).toBe(0));
    });

    // jobB is foreman B's own job, so foreman B's negative is the other
    // foreman's job (jobA), and foreman A's is jobB.
    it('f. the owner deletes foreman B\'s job; neither foreman deletes the other\'s', async () => {
      await asApi(w.owner, async (c) => expect((await c.query(`DELETE FROM jobs WHERE id = $1`, [w.jobB])).rowCount).toBe(1));
      await asApi(w.foremanA, async (c) => expect((await c.query(`DELETE FROM jobs WHERE id = $1`, [w.jobB])).rowCount).toBe(0));
      await asApi(w.foremanB, async (c) => expect((await c.query(`DELETE FROM jobs WHERE id = $1`, [w.jobA])).rowCount).toBe(0));
    });

    it('g. the owner reads foreman A\'s applicant\'s skills; foreman B does not', async () => {
      await asApi(w.owner, async (c) => expect(await count(c, `SELECT 1 FROM worker_skills WHERE worker_id = $1`, [w.worker.id])).toBe(1));
      await asApi(w.foremanB, async (c) => expect(await count(c, `SELECT 1 FROM worker_skills WHERE worker_id = $1`, [w.worker.id])).toBe(0));
    });

    it('h. the owner passes employer_claim_worker_intent\'s caller checks for foreman A\'s chat message; foreman B gets 42501', async () => {
      await asApi(w.owner, async (c) => {
        await c.query('SAVEPOINT claim');
        let code: string | undefined;
        try {
          await c.query(claimChat, [w.worker.id, w.messageA]);
        } catch (err) {
          code = (err as { code?: string }).code;
        }
        await c.query('ROLLBACK TO SAVEPOINT claim');
        // Any decision row, or a later check's error, is fine: only the
        // caller checks (42501) must let the owner through.
        expect(code).not.toBe('42501');
      });
      await asApi(w.foremanB, async (c) => rejects(c, claimChat, [w.worker.id, w.messageA], '42501'));
    });
  });
});
