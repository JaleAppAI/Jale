/**
 * r-paths-org-members.integration.test.ts -- the Phase 3 entry gate.
 *
 * One company with an owner and two foremen, plus a stranger company,
 * driven through the real employer handlers on their request login,
 * jale_api (getDbPool is mocked to a jale_api pool). It pins, on the
 * Phase 1/2 code, before any Phase 3 change:
 *
 *   - the owner lists every member's jobs; a foreman lists only their own;
 *   - the owner reads and writes a foreman's job, applicants, conversation
 *     and templates: edit, pause and reactivate (under the company lock and
 *     the plan's limit), move an application, send a message (stamped with
 *     the owner as sender), read the applicants, delete a template -- and
 *     the job's responsible person (jobs.employer_id) does not change;
 *   - foreman B is refused every one of foreman A's jobs, applicants,
 *     applicant statuses, conversations, upload links and templates, with
 *     each handler's exact status and error code, and nothing of A's changes;
 *   - B's inbox and applicants overview leave out A's conversation,
 *     application and worker; the owner's include them;
 *   - templates are a company asset: B sees A's template but cannot edit or
 *     delete it; the owner can;
 *   - a stranger company is refused every one of foreman A's resources;
 *   - a suspended or removed foreman is answered 403 membership_inactive
 *     (with their membershipStatus since Phase 3) on every route, their own
 *     resources included, while the owner still lists and reads their jobs.
 *
 * Every case builds the rows it touches, and every assertion on stored state
 * reads through the superuser, before and after, inside the case. Twilio is
 * replaced by a recorder.
 *
 * Run:
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *     --container <name> --port <port> -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/r-paths-org-members.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import {
  apiEvent, FIXTURE_TOS_VERSION, parseResponse, TEMPLATE_PAYLOAD, World,
  type ApiEventInput, type ParsedResponse, type UserFixture,
} from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;

const sent: Array<{ to: string; template: string | null; body: string | null }> = [];
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: { content_template: string | null; body: string | null }) => {
      sent.push({ to, template: row.content_template, body: row.body });
      return `fake-sid-${randomUUID()}`;
    }),
  };
});

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { handler: listJobs } = require('../../../lambda/api/employer-jobs-list');
const { handler: jobDetail } = require('../../../lambda/api/employer-jobs-detail');
const { handler: jobUpdate } = require('../../../lambda/api/employer-jobs-update');
const { handler: jobDelete } = require('../../../lambda/api/employer-jobs-delete');
const { handler: jobApplicants } = require('../../../lambda/api/employer-job-applicants');
const { handler: jobCandidates } = require('../../../lambda/api/employer-job-candidates');
const { handler: statusUpdate } = require('../../../lambda/api/employer-application-status-update');
const { handler: uploadToken } = require('../../../lambda/api/employer-upload-token');
const { handler: convList } = require('../../../lambda/api/employer-conversations-list');
const { handler: convDetail } = require('../../../lambda/api/employer-conversations-detail');
const { handler: convSend } = require('../../../lambda/api/employer-conversations-send');
const { handler: convRead } = require('../../../lambda/api/employer-conversations-read');
const { handler: convUpdate } = require('../../../lambda/api/employer-conversations-update');
const { handler: inbox } = require('../../../lambda/api/employer-inbox');
const { handler: applicantsOverview } = require('../../../lambda/api/employer-applicants-overview');
const { handler: listTemplates } = require('../../../lambda/api/employer-templates-list');
const { handler: saveTemplate } = require('../../../lambda/api/employer-templates-save');
const { handler: deleteTemplate } = require('../../../lambda/api/employer-templates-delete');
/* eslint-enable @typescript-eslint/no-var-requires */

if (!databaseUrl) {
  test('CONCERN: the org-members entry-gate DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

type Handler = (event: unknown) => Promise<{ statusCode: number; body?: string }>;

async function call(handler: Handler, user: UserFixture, input: Omit<ApiEventInput, 'sub'>): Promise<ParsedResponse> {
  return parseResponse(await handler(apiEvent({ sub: user.sub, ...input })));
}

/** Each handler's answer for a resource outside the caller's scope. */
const REFUSAL_STATUS = {
  forbidden: 403,
  job_not_found: 404,
  conversation_not_found: 404,
} as const;
type Refusal = keyof typeof REFUSAL_STATUS;

/** Refused with the handler's exact status and error code (never a caller-level gate). */
function refused(res: ParsedResponse, error: Refusal): void {
  expect({ statusCode: res.statusCode, error: res.body?.error }).toEqual({ statusCode: REFUSAL_STATUS[error], error });
}

/** The wall resolveEmployerActor puts in front of every route for a member who is not active, with their status. */
function membershipInactive(res: ParsedResponse, membershipStatus: 'suspended' | 'removed'): void {
  expect(res).toEqual({ statusCode: 403, body: { error: 'membership_inactive', membershipStatus } });
}

function ids(res: ParsedResponse): string[] {
  expect(res.statusCode).toBe(200);
  return (res.body.jobs as Array<{ id: string }>).map((j) => j.id);
}

function convIds(res: ParsedResponse): string[] {
  expect(res.statusCode).toBe(200);
  return (res.body.conversations as Array<{ id: string }>).map((c) => c.id);
}

function templateIds(res: ParsedResponse): string[] {
  expect(res.statusCode).toBe(200);
  return (res.body.templates as Array<{ id: string }>).map((t) => t.id);
}

/**
 * A PATCH /employer/jobs/{jobId} field edit that changes only the title of a
 * World.job() row. The field-edit path is a full replacement: it needs title,
 * location, job_type and trade_category (400 missing_fields /
 * invalid_trade_category otherwise), and with applicants present job_type and
 * required_docs must equal the stored ones ('full-time', []) or it answers
 * 409 field_locked.
 */
function jobEdit(title: string): Record<string, unknown> {
  return { title, location: 'Fixture City', job_type: 'full-time', trade_category: 'electrician', required_docs: [] };
}

describeInProfiles(['standard', 'request'], 'one company, two foremen, through the handlers', () => {
  let world: World;
  let owner: UserFixture;
  let foremanA: UserFixture;
  let foremanB: UserFixture;
  let stranger: UserFixture;

  beforeAll(async () => {
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 2 }, 'jale_api', 'test');
    world = new World(databaseUrl!);
    await world.connect();
    owner = await world.employer({ companyName: 'Gate Co' });
    foremanA = await world.foreman(owner.id);
    foremanB = await world.foreman(owner.id);
    stranger = await world.employer({ companyName: 'Other Co' });
    // Gate Co on Pro, so the plan's active-job limit (Free: 15, Pro: 50 since 132) never answers
    // before the scope does; the owner's company cleanup removes the row.
    await world.su.query(
      `INSERT INTO subscriptions (user_id, organization_id, plan_code, status)
       SELECT $1, organization_id, 'employer_pro', 'active' FROM organization_members WHERE user_id = $1`,
      [owner.id],
    );
  });

  afterAll(async () => {
    try {
      await world?.cleanup();
    } finally {
      await world?.end();
      await mockPool?.end();
      mockPool = undefined;
    }
  });

  beforeEach(() => {
    sent.length = 0;
  });

  /** A job of `employerId` with one applicant and an open conversation, all the calling case's own. */
  async function thread(employerId: string, opts: { jobStatus?: 'active' | 'paused'; readyWorker?: boolean } = {}) {
    const worker = await world.worker(opts.readyWorker
      ? { lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' }
      : {});
    const job = await world.job(employerId, { status: opts.jobStatus ?? 'paused' });
    const applicationId = await world.application(job.id, worker.id);
    const conversationId = await world.conversation({
      jobId: job.id, employerId, workerId: worker.id, applicationId,
      // Inside the reply window: a ready worker gets a freeform send.
      lastWorkerMessageAt: opts.readyWorker ? new Date(Date.now() - 60 * 60 * 1000) : null,
    });
    return { worker, job, applicationId, conversationId };
  }

  async function one(sql: string, params: unknown[]): Promise<any> {
    const { rows } = await world.su.query(sql, params);
    return rows[0];
  }
  const jobRow = (id: string) => one(`SELECT to_jsonb(j) AS row FROM jobs j WHERE id = $1`, [id]);
  const applicationRow = (id: string) => one(`SELECT to_jsonb(a) AS row FROM job_applications a WHERE id = $1`, [id]);
  const conversationRow = (id: string) => one(
    `SELECT to_jsonb(c) AS row,
            (SELECT count(*)::int FROM job_conversation_messages m WHERE m.conversation_id = c.id) AS messages
       FROM job_conversations c WHERE id = $1`, [id]);
  const templateRow = (id: string) => one(`SELECT to_jsonb(t) AS row FROM employer_job_templates t WHERE id = $1`, [id]);

  it('the owner lists every member\'s jobs; each foreman lists only their own', async () => {
    const jobA = await world.job(foremanA.id, { status: 'paused' });
    const jobB = await world.job(foremanB.id, { status: 'paused' });
    const strangerJob = await world.job(stranger.id, { status: 'paused' });

    const ownerList = ids(await call(listJobs, owner, {}));
    expect(ownerList).toEqual(expect.arrayContaining([jobA.id, jobB.id]));
    expect(ownerList).not.toContain(strangerJob.id);

    for (const [foreman, own, other] of [[foremanA, jobA, jobB], [foremanB, jobB, jobA]] as const) {
      const listed = ids(await call(listJobs, foreman, {}));
      expect(listed).toContain(own.id);
      expect(listed).not.toContain(other.id);
      const employers = await world.su.query<{ employer_id: string }>(
        `SELECT DISTINCT employer_id FROM jobs WHERE id = ANY($1::uuid[])`, [listed]);
      expect(employers.rows.map((r) => r.employer_id)).toEqual([foreman.id]);
    }

    expect(ids(await call(listJobs, stranger, {}))).not.toContain(jobA.id);
  });

  it('the owner reads and edits foreman A\'s job', async () => {
    const { job } = await thread(foremanA.id);
    expect((await call(jobDetail, owner, { pathParameters: { jobId: job.id } })).statusCode).toBe(200);
    const res = await call(jobUpdate, owner, { httpMethod: 'PATCH', pathParameters: { jobId: job.id }, body: jobEdit('Owner edit') });
    expect(res.statusCode).toBe(200);
    expect((await world.su.query('SELECT title, employer_id FROM jobs WHERE id = $1', [job.id])).rows[0])
      .toEqual({ title: 'Owner edit', employer_id: foremanA.id }); // the responsible person does not change
  });

  it('the owner writes on foreman A\'s job, applicants, conversation and templates', async () => {
    const t = await thread(foremanA.id, { jobStatus: 'active', readyWorker: true });
    const status = async () => (await world.su.query('SELECT status, employer_id FROM jobs WHERE id = $1', [t.job.id])).rows[0];

    // Pause, then reactivate: the activation takes the company lock and
    // checks the company's active-job limit (employer-jobs-update.ts:81-128).
    const paused = await call(jobUpdate, owner, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: { status: 'paused' } });
    expect({ statusCode: paused.statusCode, status: paused.body?.status }).toEqual({ statusCode: 200, status: 'paused' });
    expect(await status()).toEqual({ status: 'paused', employer_id: foremanA.id });
    const active = await call(jobUpdate, owner, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: { status: 'active' } });
    expect({ statusCode: active.statusCode, status: active.body?.status }).toEqual({ statusCode: 200, status: 'active' });
    expect(await status()).toEqual({ status: 'active', employer_id: foremanA.id });

    // Moves A's applicant forward.
    const moved = await call(statusUpdate, owner, {
      httpMethod: 'PATCH', pathParameters: { jobId: t.job.id, workerId: t.worker.id }, body: { status: 'contacted' },
    });
    expect(moved.statusCode).toBe(200);
    expect((await world.su.query('SELECT status FROM job_applications WHERE id = $1', [t.applicationId])).rows[0].status).toBe('contacted');

    // Sends in A's conversation; the database stamps the owner as the sender.
    const sentRes = await call(convSend, owner, {
      httpMethod: 'POST', pathParameters: { conversationId: t.conversationId }, body: { body: 'Fixture from the owner' },
    });
    expect(sentRes.statusCode).toBe(200);
    expect((await world.su.query(
      `SELECT sender_type, sender_user_id FROM job_conversation_messages WHERE conversation_id = $1 AND body = $2`,
      [t.conversationId, 'Fixture from the owner'],
    )).rows).toEqual([{ sender_type: 'employer', sender_user_id: owner.id }]);
    expect(sent.filter((s) => s.body?.includes('Fixture from the owner'))).toHaveLength(1);

    // Reads A's applicants.
    const applicants = await call(jobApplicants, owner, { pathParameters: { jobId: t.job.id } });
    expect(applicants.statusCode).toBe(200);
    expect(applicants.body.applicants).toEqual([
      expect.objectContaining({ application_id: t.applicationId, worker_id: t.worker.id }),
    ]);

    // Deletes a template of A's.
    const template = await world.template(foremanA.id, 'A template (owner deletes)');
    const deleted = await call(deleteTemplate, owner, { httpMethod: 'DELETE', pathParameters: { templateId: template } });
    expect(deleted.statusCode).toBe(204);
    expect(await templateRow(template)).toBeUndefined();
  });

  it('foreman B is refused foreman A\'s job, applicants, applicant status and upload links', async () => {
    const t = await thread(foremanA.id);
    const jobBefore = await jobRow(t.job.id);
    const applicationBefore = await applicationRow(t.applicationId);

    refused(await call(jobDetail, foremanB, { pathParameters: { jobId: t.job.id } }), 'job_not_found');
    refused(await call(jobUpdate, foremanB, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: jobEdit('B edit') }), 'forbidden');
    refused(await call(jobUpdate, foremanB, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: { status: 'closed' } }), 'forbidden');
    refused(await call(jobUpdate, foremanB, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: { status: 'active' } }), 'forbidden');
    refused(await call(jobApplicants, foremanB, { pathParameters: { jobId: t.job.id } }), 'forbidden');
    refused(await call(jobCandidates, foremanB, { pathParameters: { jobId: t.job.id } }), 'forbidden');
    // APPLICATION_STATUSES has no 'shortlisted' (400 invalid_status before any
    // scope check), so the refusal moves the application to 'contacted', a
    // real next stage.
    refused(await call(statusUpdate, foremanB, {
      httpMethod: 'PATCH', pathParameters: { jobId: t.job.id, workerId: t.worker.id }, body: { status: 'contacted' },
    }), 'forbidden');
    refused(await call(uploadToken, foremanB, { httpMethod: 'POST', body: { job_id: t.job.id, worker_id: t.worker.id } }), 'forbidden');
    refused(await call(jobDelete, foremanB, { httpMethod: 'DELETE', pathParameters: { jobId: t.job.id } }), 'forbidden');

    expect(await jobRow(t.job.id)).toEqual(jobBefore);
    expect(await applicationRow(t.applicationId)).toEqual(applicationBefore);
    expect((await world.su.query(`SELECT count(*)::int AS n FROM document_upload_tokens WHERE job_id = $1`, [t.job.id])).rows[0].n).toBe(0);
  });

  it('foreman B is refused foreman A\'s conversation and does not list it; the owner reads it', async () => {
    const t = await thread(foremanA.id);
    const before = await conversationRow(t.conversationId);

    refused(await call(convDetail, foremanB, { pathParameters: { conversationId: t.conversationId } }), 'conversation_not_found');
    refused(await call(convSend, foremanB, { httpMethod: 'POST', pathParameters: { conversationId: t.conversationId }, body: { body: 'from B' } }), 'conversation_not_found');
    refused(await call(convRead, foremanB, { httpMethod: 'POST', pathParameters: { conversationId: t.conversationId } }), 'conversation_not_found');
    refused(await call(convUpdate, foremanB, { httpMethod: 'PATCH', pathParameters: { conversationId: t.conversationId }, body: { status: 'closed' } }), 'conversation_not_found');
    expect(convIds(await call(convList, foremanB, {}))).not.toContain(t.conversationId);

    expect(await conversationRow(t.conversationId)).toEqual(before);
    expect(sent).toEqual([]);
    expect((await call(convDetail, owner, { pathParameters: { conversationId: t.conversationId } })).statusCode).toBe(200);
  });

  it('foreman B\'s inbox and applicants overview leave out foreman A\'s; the owner\'s include them', async () => {
    const t = await thread(foremanA.id);

    const bInbox = await call(inbox, foremanB, {});
    expect(bInbox.statusCode).toBe(200);
    for (const item of bInbox.body.items as Array<Record<string, string | null>>) {
      expect(item.conversation_id).not.toBe(t.conversationId);
      expect(item.application_id).not.toBe(t.applicationId);
      expect(item.worker_id).not.toBe(t.worker.id);
      expect(item.job_id).not.toBe(t.job.id);
    }
    expect((bInbox.body.jobs as Array<{ job_id: string }>).map((j) => j.job_id)).not.toContain(t.job.id);

    const bOverview = await call(applicantsOverview, foremanB, {});
    expect(bOverview.statusCode).toBe(200);
    for (const item of bOverview.body.applicants as Array<Record<string, string>>) {
      expect(item.application_id).not.toBe(t.applicationId);
      expect(item.worker_id).not.toBe(t.worker.id);
      expect(item.job_id).not.toBe(t.job.id);
    }
    expect((bOverview.body.jobs as Array<{ job_id: string }>).map((j) => j.job_id)).not.toContain(t.job.id);

    const ownerInbox = await call(inbox, owner, {});
    expect(ownerInbox.statusCode).toBe(200);
    expect(ownerInbox.body.items).toEqual(expect.arrayContaining([expect.objectContaining({
      conversation_id: t.conversationId, application_id: t.applicationId, worker_id: t.worker.id, job_id: t.job.id,
    })]));

    const ownerOverview = await call(applicantsOverview, owner, {});
    expect(ownerOverview.statusCode).toBe(200);
    expect(ownerOverview.body.applicants).toEqual(expect.arrayContaining([expect.objectContaining({
      application_id: t.applicationId, worker_id: t.worker.id, job_id: t.job.id,
    })]));
  });

  it('foreman B sees but cannot edit or delete foreman A\'s template; the owner can edit it', async () => {
    const template = await world.template(foremanA.id, 'A template (B case)');
    const before = await templateRow(template);

    expect(templateIds(await call(listTemplates, foremanB, {}))).toContain(template);
    refused(await call(saveTemplate, foremanB, { httpMethod: 'POST', body: { id: template, name: 'B rename', payload: TEMPLATE_PAYLOAD } }), 'forbidden');
    refused(await call(deleteTemplate, foremanB, { httpMethod: 'DELETE', pathParameters: { templateId: template } }), 'forbidden');
    expect(await templateRow(template)).toEqual(before);

    const renamed = await call(saveTemplate, owner, { httpMethod: 'POST', body: { id: template, name: 'Owner rename', payload: TEMPLATE_PAYLOAD } });
    expect(renamed.statusCode).toBe(200);
    expect((await world.su.query('SELECT name, employer_id FROM employer_job_templates WHERE id = $1', [template])).rows[0])
      .toEqual({ name: 'Owner rename', employer_id: foremanA.id });
  });

  it('the stranger is refused every one of foreman A\'s resources', async () => {
    const t = await thread(foremanA.id);
    const template = await world.template(foremanA.id, 'A template (stranger case)');
    const jobBefore = await jobRow(t.job.id);
    const applicationBefore = await applicationRow(t.applicationId);
    const conversationBefore = await conversationRow(t.conversationId);
    const templateBefore = await templateRow(template);

    refused(await call(jobDetail, stranger, { pathParameters: { jobId: t.job.id } }), 'job_not_found');
    refused(await call(jobUpdate, stranger, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: jobEdit('S') }), 'forbidden');
    refused(await call(jobApplicants, stranger, { pathParameters: { jobId: t.job.id } }), 'forbidden');
    refused(await call(statusUpdate, stranger, {
      httpMethod: 'PATCH', pathParameters: { jobId: t.job.id, workerId: t.worker.id }, body: { status: 'contacted' },
    }), 'forbidden');
    refused(await call(convDetail, stranger, { pathParameters: { conversationId: t.conversationId } }), 'conversation_not_found');
    refused(await call(convSend, stranger, { httpMethod: 'POST', pathParameters: { conversationId: t.conversationId }, body: { body: 'from S' } }), 'conversation_not_found');
    expect(convIds(await call(convList, stranger, {}))).not.toContain(t.conversationId);
    expect(templateIds(await call(listTemplates, stranger, {}))).not.toContain(template);
    refused(await call(saveTemplate, stranger, { httpMethod: 'POST', body: { id: template, name: 'S', payload: TEMPLATE_PAYLOAD } }), 'forbidden');

    expect(await jobRow(t.job.id)).toEqual(jobBefore);
    expect(await applicationRow(t.applicationId)).toEqual(applicationBefore);
    expect(await conversationRow(t.conversationId)).toEqual(conversationBefore);
    expect(await templateRow(template)).toEqual(templateBefore);
    expect(sent).toEqual([]);
  });

  it.each(['suspended', 'removed'] as const)(
    'a %s foreman is answered 403 membership_inactive on their own resources; the owner still lists and reads their jobs',
    async (memberStatus) => {
      const member = await world.foreman(owner.id, { status: memberStatus });
      const t = await thread(member.id);
      const template = await world.template(member.id, `${memberStatus} template`);
      const jobBefore = await jobRow(t.job.id);
      const applicationBefore = await applicationRow(t.applicationId);
      const conversationBefore = await conversationRow(t.conversationId);
      const templateBefore = await templateRow(template);

      membershipInactive(await call(listJobs, member, {}), memberStatus);
      membershipInactive(await call(jobDetail, member, { pathParameters: { jobId: t.job.id } }), memberStatus);
      membershipInactive(await call(jobUpdate, member, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: { status: 'closed' } }), memberStatus);
      membershipInactive(await call(jobUpdate, member, { httpMethod: 'PATCH', pathParameters: { jobId: t.job.id }, body: jobEdit('Inactive edit') }), memberStatus);
      membershipInactive(await call(statusUpdate, member, {
        httpMethod: 'PATCH', pathParameters: { jobId: t.job.id, workerId: t.worker.id }, body: { status: 'contacted' },
      }), memberStatus);
      membershipInactive(await call(convSend, member, {
        httpMethod: 'POST', pathParameters: { conversationId: t.conversationId }, body: { body: 'from an inactive member' },
      }), memberStatus);
      membershipInactive(await call(saveTemplate, member, {
        httpMethod: 'POST', body: { id: template, name: 'Inactive rename', payload: TEMPLATE_PAYLOAD },
      }), memberStatus);

      expect(await jobRow(t.job.id)).toEqual(jobBefore);
      expect(await applicationRow(t.applicationId)).toEqual(applicationBefore);
      expect(await conversationRow(t.conversationId)).toEqual(conversationBefore);
      expect(await templateRow(template)).toEqual(templateBefore);
      expect(sent).toEqual([]);

      expect(ids(await call(listJobs, owner, {}))).toContain(t.job.id);
      expect((await call(jobDetail, owner, { pathParameters: { jobId: t.job.id } })).statusCode).toBe(200);
    },
  );
});
