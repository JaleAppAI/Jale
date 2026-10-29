/**
 * r-paths-team.integration.test.ts -- team management end to end, through
 * the real Phase 3 handlers, on one bed.
 *
 * TEAM_MANAGEMENT_ENABLED is 'true'. The owner's operations go through the
 * team dispatcher (lambda/api/employer-team.ts, POST/GET
 * /employer/team/{action}), membership included; the public lookup runs on
 * jale_api_public, every other handler on jale_api (getDbPool is mocked to a
 * checked pool on that login), and the worker's reply on jale_whatsapp
 * through the worker lane's own function. The team pool carries the
 * dispatcher's session timeouts (statement 10 s, lock 3 s,
 * TEAM_DISPATCHER_DB_TIMEOUTS). Cognito is replaced at applyMemberAccess by a
 * recorder that also reads, through the superuser, what was committed when it
 * was called; post-confirmation's group call goes to a recording SDK client;
 * Twilio is a recorder. No AWS is reached.
 *
 * One company (Team Co, on Pro: 3 foreman seats) lives through the whole
 * story, in order: invite and token sign-up, email sign-up, the seat limit
 * (also under concurrency), billing seats, a single-job reassign with a
 * worker reply, remove-with-reassign, the removed foreman's templates, the
 * re-invite and signed-in rejoin. Beside it: the flag-on sign-ups with no
 * invite, a Free company, busy answers (55P03 / 57014 -> 503), a
 * conversation create racing a job move (409), and the timing of removing a
 * foreman who holds 1,000 jobs.
 *
 * The story cases share state (Team Co, its foremen, jobs, invites) and must
 * run in order, as jest runs them; run one alone and the later ones fail.
 *
 * Every row is the suite's own; every assertion on stored state reads through
 * the superuser. Rows the handlers create (sign-up users, posted jobs,
 * invites, invite mail) are adopted by the World or removed in afterAll.
 *
 * Run:
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *     --container <name> --port <port> -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/r-paths-team.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client, type Pool, type PoolClient } from 'pg';
import { createCheckedPool, setInternalUserRlsContext } from '../../../lambda/lib/db';
import { TEAM_DISPATCHER_DB_TIMEOUTS } from '../../../lib/stacks/billing-stack';
import { auditCallerFor } from '../../../lambda/lib/audit/caller';
import { setAuditContext } from '../../../lambda/lib/audit/context';
import * as jobMessaging from '../../../lambda/lib/job-messaging';
import { recordWorkerConversationReply } from '../../../lambda/lib/job-messaging';
import {
  apiEvent, FIXTURE_TOS_VERSION, parseResponse, TEMPLATE_PAYLOAD, World,
  type ApiEventInput, type ParsedResponse, type UserFixture,
} from './r-paths-world';
import { describeInProfiles, loginUrl, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
process.env.TEAM_MANAGEMENT_ENABLED = 'true';
process.env.PUBLIC_SITE_BASE_URL = 'https://app.fixture.test';
delete process.env.DLQ_URL;
jest.setTimeout(60_000);

// ── Twilio: a recorder ───────────────────────────────────────────────
const mockSent: Array<{ to: string; body: string | null }> = [];
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: { body: string | null }) => {
      mockSent.push({ to, body: row.body });
      return `fake-sid-${randomUUID()}`;
    }),
  };
});

// ── Cognito: applyMemberAccess is a recorder ─────────────────────────
// Each call also records what the superuser could read at that moment: the
// handler calls it after COMMIT, so the change is already visible there.
type AccessChange = { cognitoSub: string; enabled: boolean };
type AccessSnapshot = { cognitoSub: string; status: string | null; liveInvites: number };
const mockAccessCalls: Array<{ changes: AccessChange[]; seen: AccessSnapshot[] }> = [];
let mockAccessProbe: ((changes: AccessChange[]) => Promise<AccessSnapshot[]>) | undefined;
jest.mock('../../../lambda/lib/member-access', () => ({
  ...jest.requireActual('../../../lambda/lib/member-access'),
  applyMemberAccess: jest.fn(async (changes: AccessChange[]) => {
    const seen = mockAccessProbe ? await mockAccessProbe(changes) : [];
    mockAccessCalls.push({ changes: changes.map((c) => ({ ...c })), seen });
    return { converged: changes.length, failed: [] };
  }),
}));

// ── Post-confirmation's SDK clients: recorders ───────────────────────
const mockAwsCalls: Array<{ service: string; command: string; input: unknown }> = [];
function mockSdkModule(moduleName: string, clientName: string, service: string): Record<string, unknown> {
  const actual = jest.requireActual(moduleName);
  class FixtureClient {
    readonly config = {};
    async send(command: { constructor: { name: string }; input?: unknown }): Promise<unknown> {
      mockAwsCalls.push({ service, command: command.constructor.name, input: command.input });
      return {};
    }
    destroy(): void {}
  }
  return { ...actual, [clientName]: FixtureClient };
}
jest.mock('@aws-sdk/client-cognito-identity-provider', () =>
  mockSdkModule('@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient', 'cognito'));
jest.mock('@aws-sdk/client-sqs', () => mockSdkModule('@aws-sdk/client-sqs', 'SQSClient', 'sqs'));

// ── The database: one pool per login, switched per call ──────────────
let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockPool) throw new Error('r-paths-team: no pool is open');
      return mockPool;
    },
  };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { handler: team } = require('../../../lambda/api/employer-team');
const { handler: inviteLookup } = require('../../../lambda/api/employer-invite-lookup');
const { handler: inviteAccept } = require('../../../lambda/api/employer-invite-accept');
const { handler: postConfirmation } = require('../../../lambda/post-confirmation/index');
const { handler: listJobs } = require('../../../lambda/api/employer-jobs-list');
const { handler: jobDetail } = require('../../../lambda/api/employer-jobs-detail');
const { handler: createJob } = require('../../../lambda/api/employer-jobs-create');
const { handler: convDetail } = require('../../../lambda/api/employer-conversations-detail');
const { handler: convSend } = require('../../../lambda/api/employer-conversations-send');
const { handler: convCreate } = require('../../../lambda/api/employer-conversations-create');
const { handler: listTemplates } = require('../../../lambda/api/employer-templates-list');
const { handler: saveTemplate } = require('../../../lambda/api/employer-templates-save');
const { handler: getBilling } = require('../../../lambda/billing/get-billing');
/* eslint-enable @typescript-eslint/no-var-requires */

if (!databaseUrl) {
  test('CONCERN: the team end-to-end DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;

/** The team dispatcher's session timeouts, as BillingStack sets them on EmployerTeamLambda. */
const TEAM_TIMEOUTS = {
  statement_timeout: Number(TEAM_DISPATCHER_DB_TIMEOUTS.DB_STATEMENT_TIMEOUT_MS),
  lock_timeout: Number(TEAM_DISPATCHER_DB_TIMEOUTS.DB_LOCK_TIMEOUT_MS),
} as const;

/** A PATCH-free job post: employer-jobs-create's required fields. */
const CREATE_BODY = { title: 'Fixture Team Job', location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' };

type Handler = (event: unknown) => Promise<{ statusCode: number; headers?: Record<string, unknown>; body?: string }>;

async function call(handler: Handler, user: UserFixture, input: Omit<ApiEventInput, 'sub'>): Promise<ParsedResponse> {
  return parseResponse(await handler(apiEvent({ sub: user.sub, ...input })));
}

/** POST /employer/team/{action} through the dispatcher. */
async function teamPost(user: UserFixture, action: string, body: unknown): Promise<ParsedResponse> {
  return call(team, user, { httpMethod: 'POST', resource: '/employer/team/{action}', pathParameters: { action }, body });
}

/** GET /employer/team/{action} through the dispatcher. */
async function teamGet(user: UserFixture, action: string): Promise<ParsedResponse> {
  return call(team, user, { httpMethod: 'GET', resource: '/employer/team/{action}', pathParameters: { action } });
}

function jobIds(res: ParsedResponse): string[] {
  expect(res.statusCode).toBe(200);
  return (res.body.jobs as Array<{ id: string }>).map((j) => j.id);
}

function templateIds(res: ParsedResponse): string[] {
  expect(res.statusCode).toBe(200);
  return (res.body.templates as Array<{ id: string }>).map((t) => t.id);
}

describeInProfiles([...ALL_PROFILES], 'team management end to end, through the handlers', () => {
  let world: World;
  let apiPool: Pool;
  let publicPool: Pool;
  let whatsappPool: Pool;
  const extraPools: Pool[] = [];

  let owner: UserFixture;
  let orgId: string;
  const f1Email = `fixture-p3t12-f1-${randomUUID()}@fixture.invalid`;
  const f2Email = `fixture-p3t12-f2-${randomUUID()}@fixture.invalid`;
  let f1: UserFixture;
  let f2: UserFixture;
  /** F1's posted job; F1's second job (with a conversation) for the remove. */
  let f1Job: string;
  let f1SecondJob: { id: string; conversationId: string; worker: UserFixture & { phone: string | null } };
  /** The reassigned job with its conversation (step: reassign). */
  let movedThread: { jobId: string; conversationId: string; worker: UserFixture & { phone: string | null } };
  let f1Template: string;
  let pendingInviteToken: string;
  /** Users created by post-confirmation (adopted by the World too). */
  const signUps: string[] = [];

  beforeAll(async () => {
    apiPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 4, ...TEAM_TIMEOUTS }, 'jale_api', 'test');
    publicPool = await createCheckedPool({ connectionString: loginUrl('jale_api_public'), max: 1 }, 'jale_api_public', 'test');
    whatsappPool = await createCheckedPool({ connectionString: loginUrl('jale_whatsapp'), max: 1 }, 'jale_whatsapp', 'test');
    mockPool = apiPool;
    world = new World(databaseUrl!);
    await world.connect();
    owner = await world.employer({ companyName: 'Team Co', fullName: 'Fixture Team Owner' });
    orgId = (await world.su.query<{ organization_id: string }>(
      `SELECT organization_id FROM organization_members WHERE user_id = $1`, [owner.id])).rows[0].organization_id;
    await world.su.query(
      `INSERT INTO subscriptions (user_id, organization_id, plan_code, status) VALUES ($1, $2, 'employer_pro', 'active')`,
      [owner.id, orgId],
    );
    // Runs before every company's own cleanup (registered later, so first):
    // the invites and their mail, then what the handlers wrote for the
    // suite's users, then any company a sign-up started.
    world.onCleanup(async () => {
      const users = [...world.users];
      const orgs = (await world.su.query<{ organization_id: string }>(
        `SELECT DISTINCT organization_id FROM organization_members WHERE user_id = ANY($1::uuid[])`, [users])).rows
        .map((r) => r.organization_id);
      await world.su.query(
        `DELETE FROM email_outbox WHERE source_type = 'organization_invite'
            AND source_id IN (SELECT id FROM organization_invites WHERE organization_id = ANY($1::uuid[]))`, [orgs]);
      await world.su.query(`DELETE FROM organization_invites WHERE organization_id = ANY($1::uuid[])`, [orgs]);
      await world.su.query(
        `DELETE FROM job_message_outbox WHERE conversation_id IN (
            SELECT id FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[]))`, [users]);
      await world.su.query(`DELETE FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[])`, [users]);
      await world.su.query(`DELETE FROM job_visibility_events WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = ANY($1::uuid[]))`, [users]);
      await world.su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [users]);
      await world.su.query(`DELETE FROM worker_thread_counters WHERE worker_id = ANY($1::uuid[])`, [users]);
      // Companies started by a sign-up (no World company cleanup of their own).
      const started = (await world.su.query<{ organization_id: string }>(
        `SELECT organization_id FROM organization_members WHERE role = 'owner' AND user_id = ANY($1::uuid[])`,
        [signUps])).rows.map((r) => r.organization_id);
      await world.su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [started]);
      await world.su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [started]);
    });
  });

  afterAll(async () => {
    try {
      await world?.cleanup();
    } finally {
      await world?.end();
      for (const pool of [apiPool, publicPool, whatsappPool, ...extraPools]) await pool?.end();
      mockPool = undefined;
    }
  });

  beforeEach(() => {
    mockPool = apiPool;
    mockSent.length = 0;
    mockAccessCalls.length = 0;
    mockAwsCalls.length = 0;
    mockAccessProbe = async (changes) => Promise.all(changes.map(async ({ cognitoSub }) => {
      const { rows } = await world.su.query<{ status: string | null; live_invites: number }>(
        `SELECT m.status,
                (SELECT count(*)::int FROM organization_invites i
                  WHERE i.email = lower(btrim(u.email)) AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                    AND i.expires_at > now()) AS live_invites
           FROM users u LEFT JOIN organization_members m ON m.user_id = u.id
          WHERE u.cognito_sub = $1`, [cognitoSub]);
      return { cognitoSub, status: rows[0]?.status ?? null, liveInvites: rows[0]?.live_invites ?? 0 };
    }));
  });

  // ── helpers ─────────────────────────────────────────────────────────

  /** The raw token in the newest invite mail for this invite (only the superuser and the sender read it). */
  async function tokenOf(inviteId: string): Promise<string> {
    const { rows } = await world.su.query<{ body_text: string }>(
      `SELECT body_text FROM email_outbox WHERE source_type = 'organization_invite' AND source_id = $1
        ORDER BY created_at DESC LIMIT 1`, [inviteId]);
    const match = /token=([A-Za-z0-9_-]{43})/.exec(rows[0]?.body_text ?? '');
    if (!match) throw new Error('r-paths-team: no token in the invite mail');
    return match[1];
  }

  async function invite(email: string, contactName: string | null = null, by: UserFixture = owner): Promise<ParsedResponse> {
    return teamPost(by, 'invite', { email, contactName, locale: 'en' });
  }

  /** A synthetic PostConfirmation_ConfirmSignUp event, as Cognito sends it, run on jale_api. */
  async function signUp(input: {
    email: string; name: string; companyName?: string; inviteToken?: string; emailVerified?: boolean;
  }): Promise<UserFixture> {
    const sub = `fixture-employer-${randomUUID()}`;
    const attrs: Record<string, string> = {
      sub,
      'custom:user_type': 'employer',
      email: input.email,
      email_verified: input.emailVerified === false ? 'false' : 'true',
      name: input.name,
    };
    if (input.companyName) attrs['custom:company_name'] = input.companyName;
    const event = {
      version: '1',
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      region: 'fixture-region',
      userPoolId: 'fixture-employer-pool',
      userName: sub,
      callerContext: { awsSdkVersion: 'fixture', clientId: 'fixture-client' },
      request: { userAttributes: attrs, ...(input.inviteToken ? { clientMetadata: { inviteToken: input.inviteToken } } : {}) },
      response: {},
    };
    const result = await postConfirmation(event, { awsRequestId: `fixture-${randomUUID()}` });
    expect(result).toBe(event);
    const { rows } = await world.su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [sub]);
    expect(rows).toHaveLength(1);
    world.track('user', rows[0].id);
    signUps.push(rows[0].id);
    // The person accepts the Terms on first sign-in (the legal flow, not under test here).
    await world.su.query(`UPDATE users SET tos_version = $1 WHERE id = $2`, [FIXTURE_TOS_VERSION, rows[0].id]);
    return { id: rows[0].id, sub };
  }

  async function membershipOf(userId: string): Promise<{ organization_id: string; role: string; status: string } | undefined> {
    return (await world.su.query(
      `SELECT organization_id, role, status FROM organization_members WHERE user_id = $1`, [userId])).rows[0];
  }

  async function seats(): Promise<{ active: number; live: number }> {
    const { rows } = await world.su.query<{ active: number; live: number }>(
      `SELECT (SELECT count(*)::int FROM organization_members
                WHERE organization_id = $1 AND role = 'foreman' AND status = 'active') AS active,
              (SELECT count(*)::int FROM organization_invites
                WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS live`,
      [orgId]);
    return rows[0];
  }

  async function postJob(user: UserFixture, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call(createJob, user, { httpMethod: 'POST', resource: '/employer/jobs', body: { ...CREATE_BODY, ...extra } });
    expect(res.statusCode).toBe(201);
    world.track('job', res.body.id);
    return res.body.id;
  }

  /** An applicant of `jobId` who is ready on WhatsApp, inside the reply window, with an open conversation. */
  async function thread(jobId: string, employerId: string) {
    const worker = await world.worker({ lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' });
    const applicationId = await world.application(jobId, worker.id);
    const conversationId = await world.conversation({
      jobId, employerId, workerId: worker.id, applicationId,
      lastWorkerMessageAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return { worker, applicationId, conversationId };
  }

  async function employerOf(table: 'jobs' | 'job_conversations', id: string): Promise<string> {
    return (await world.su.query<{ employer_id: string }>(`SELECT employer_id FROM ${table} WHERE id = $1`, [id])).rows[0].employer_id;
  }

  async function asPublicLogin<T>(fn: () => Promise<T>): Promise<T> {
    const before = process.env.DB_EXPECTED_LOGIN;
    process.env.DB_EXPECTED_LOGIN = 'jale_api_public';
    mockPool = publicPool;
    try {
      return await fn();
    } finally {
      mockPool = apiPool;
      if (before === undefined) delete process.env.DB_EXPECTED_LOGIN;
      else process.env.DB_EXPECTED_LOGIN = before;
    }
  }

  async function lookup(token: string): Promise<ParsedResponse> {
    return asPublicLogin(async () => parseResponse(await inviteLookup(apiEvent({
      httpMethod: 'GET', resource: '/employer/invites/{token}', pathParameters: { token },
    }))));
  }

  /** The owner's digest session (jale_job_digest, the producer's context) reads these jobs. */
  async function digestReach(user: UserFixture, ids: string[]): Promise<string[]> {
    return withLoginClient('jale_job_digest', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [user.sub]);
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [user.id]);
        return (await c.query<{ id: string }>(`SELECT id FROM jobs WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id).sort();
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  /** Holds Team Co's company lock (128's first lock) in a superuser session until released. */
  async function holdCompanyLock(organizationId: string): Promise<{ release: () => Promise<void> }> {
    const holder = new Client({ connectionString: databaseUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [organizationId]);
    return {
      release: async () => {
        try { await holder.query('ROLLBACK'); } finally { await holder.end(); }
      },
    };
  }

  async function timedPool(config: { lock_timeout?: number; statement_timeout?: number }): Promise<Pool> {
    const pool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 2, ...config }, 'jale_api', 'test');
    extraPools.push(pool);
    return pool;
  }

  /** Waits until `count` jale_api backends are waiting on a lock (the handlers reached the contended row). */
  async function untilApiWaitsOnLock(count = 1): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await world.su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'jale_api' AND wait_event_type = 'Lock'`);
      if (rows[0].n >= count) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('r-paths-team: the handler never waited on the lock');
  }

  // ── the story ───────────────────────────────────────────────────────

  it('owner invites, the invitee looks it up publicly, signs up through post-confirmation with the token and lists only their own jobs', async () => {
    const ownerJob = await postJob(owner, { title: 'Fixture Owner Job' });

    const created = await invite(`  ${f1Email.toUpperCase()} `, 'Fixture Foreman One');
    expect(created.statusCode).toBe(201);
    expect(created.body.invite).toEqual(expect.objectContaining({ email: f1Email, contactName: 'Fixture Foreman One', expired: false }));
    expect(created.body.accessUpdated).toBe(true);
    expect(mockAccessCalls).toEqual([]); // a new email has no Cognito user to enable
    const token = await tokenOf(created.body.invite.inviteId);

    const looked = await lookup(token);
    expect(looked).toEqual({
      statusCode: 200,
      body: { companyName: 'Team Co', email: f1Email, contactName: 'Fixture Foreman One', existingAccount: false, expiresAt: expect.any(String) },
    });

    // Invite-mode sign-up: no custom:company_name; the token rides in ClientMetadata.
    f1 = await signUp({ email: f1Email, name: 'Fixture Foreman One', inviteToken: token });
    expect(await membershipOf(f1.id)).toEqual({ organization_id: orgId, role: 'foreman', status: 'active' });
    expect((await world.su.query(`SELECT accepted_at IS NOT NULL AS used FROM organization_invites WHERE id = $1`,
      [created.body.invite.inviteId])).rows[0].used).toBe(true);
    expect(mockAwsCalls).toEqual([expect.objectContaining({ service: 'cognito', command: 'AdminAddUserToGroupCommand' })]);
    expect((await lookup(token))).toEqual({ statusCode: 410, body: { error: 'invite_used' } });

    const membership = await teamGet(f1, 'membership');
    expect(membership).toEqual({
      statusCode: 200, body: { userId: f1.id, organizationId: orgId, role: 'foreman', companyName: 'Team Co' },
    });

    // The foreman posts and works on their own jobs only.
    f1Job = await postJob(f1, { title: 'Fixture F1 Job' });
    expect(await employerOf('jobs', f1Job)).toBe(f1.id);
    const secondJob = await postJob(f1, { title: 'Fixture F1 Second Job' });
    const t = await thread(secondJob, f1.id);
    f1SecondJob = { id: secondJob, conversationId: t.conversationId, worker: t.worker };

    const listed = jobIds(await call(listJobs, f1, {}));
    expect(listed.sort()).toEqual([f1Job, secondJob].sort());
    expect((await call(jobDetail, f1, { pathParameters: { jobId: ownerJob } })).statusCode).toBe(404);
    expect(jobIds(await call(listJobs, owner, {}))).toEqual(expect.arrayContaining([ownerJob, f1Job, secondJob]));

    // A template F1 saves (it stays with the company after F1 leaves).
    const saved = await call(saveTemplate, f1, { httpMethod: 'POST', body: { name: 'Fixture F1 Template', payload: TEMPLATE_PAYLOAD } });
    expect(saved.statusCode).toBe(201);
    f1Template = saved.body.id;
  });

  it('an invitee who signs up without the token joins by email', async () => {
    const created = await invite(f2Email, 'Fixture Foreman Two');
    expect(created.statusCode).toBe(201);

    // Confirmed outside the invite page: no ClientMetadata. The single live
    // invite to the confirmed email is accepted; no company of their own.
    f2 = await signUp({ email: f2Email, name: 'Fixture Foreman Two' });
    expect(await membershipOf(f2.id)).toEqual({ organization_id: orgId, role: 'foreman', status: 'active' });
    expect((await world.su.query(`SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1`, [f2.id])).rows[0].n).toBe(1);
    expect((await teamGet(f2, 'membership')).body).toEqual(expect.objectContaining({ role: 'foreman', organizationId: orgId }));
    expect(await seats()).toEqual({ active: 2, live: 0 });
  });

  it('flag on, no invite: an invite-mode sign-up stays orgless; a self sign-up starts its own company', async () => {
    const inviteMode = await signUp({ email: `fixture-p3t12-nobody-${randomUUID()}@fixture.invalid`, name: 'Fixture Nobody' });
    expect(await membershipOf(inviteMode.id)).toBeUndefined();
    expect(await teamGet(inviteMode, 'membership')).toEqual({ statusCode: 403, body: { error: 'no_organization' } });

    // A token that is not a token, and no live invite to the email: still orgless.
    const badToken = await signUp({
      email: `fixture-p3t12-bad-${randomUUID()}@fixture.invalid`, name: 'Fixture Bad Token', inviteToken: 'not-a-token',
    });
    expect(await membershipOf(badToken.id)).toBeUndefined();

    const selfSignUp = await signUp({
      email: `fixture-p3t12-self-${randomUUID()}@fixture.invalid`, name: 'Fixture Self', companyName: 'Fixture Self Co',
    });
    const own = await membershipOf(selfSignUp.id);
    expect(own).toEqual({ organization_id: expect.any(String), role: 'owner', status: 'active' });
    expect(own!.organization_id).not.toBe(orgId);
  });

  it('a second invite for the last Free/Pro seat is refused with seat_limit_reached', async () => {
    // Pro: 3 seats. Two active foremen + this pending invite = 3.
    const third = await invite(`fixture-p3t12-p3-${randomUUID()}@fixture.invalid`);
    expect(third.statusCode).toBe(201);
    pendingInviteToken = await tokenOf(third.body.invite.inviteId);
    expect(await seats()).toEqual({ active: 2, live: 1 });

    const fourth = await invite(`fixture-p3t12-p4-${randomUUID()}@fixture.invalid`);
    expect(fourth).toEqual({ statusCode: 403, body: { error: 'seat_limit_reached' } });
    expect(await seats()).toEqual({ active: 2, live: 1 });

    // Two invites for the one seat a revoke frees, at the same time: exactly
    // one wins. The company lock is held until both are waiting on it, so
    // they really overlap; it is released inside the 3 s lock_timeout.
    const revoked = await teamPost(owner, 'revoke', { inviteId: third.body.invite.inviteId });
    expect(revoked).toEqual({ statusCode: 200, body: { revoked: true, accessUpdated: true } });
    const held = await holdCompanyLock(orgId);
    let racing: Promise<ParsedResponse[]>;
    try {
      racing = Promise.all([
        invite(`fixture-p3t12-race-a-${randomUUID()}@fixture.invalid`),
        invite(`fixture-p3t12-race-b-${randomUUID()}@fixture.invalid`),
      ]);
      await untilApiWaitsOnLock(2);
    } finally {
      await held.release();
    }
    const [a, b] = await racing;
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 403]);
    const loser = a.statusCode === 403 ? a : b;
    const winner = a.statusCode === 201 ? a : b;
    expect(loser.body).toEqual({ error: 'seat_limit_reached' });
    pendingInviteToken = await tokenOf(winner.body.invite.inviteId);
    expect(await seats()).toEqual({ active: 2, live: 1 });

    // Free: no foreman seat at all.
    const freeOwner = await world.employer({ companyName: 'Fixture Free Co' });
    expect(await invite(`fixture-p3t12-free-${randomUUID()}@fixture.invalid`, null, freeOwner))
      .toEqual({ statusCode: 403, body: { error: 'seat_limit_reached' } });
  });

  it('GET /employer/billing seats show used and pending', async () => {
    const ownerView = await call(getBilling, owner, { resource: '/employer/billing' });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.body).toEqual(expect.objectContaining({
      planCode: 'employer_pro', foremanSeatLimit: 3, role: 'owner',
      seats: { used: 2, pending: 1, limit: 3, suspended: 0 },
    }));
    const foremanView = await call(getBilling, f1, { resource: '/employer/billing' });
    expect(foremanView.statusCode).toBe(200);
    expect(foremanView.body).toEqual(expect.objectContaining({ role: 'foreman', seats: null }));
  });

  it('the owner reassigns one job; its conversation follows; a worker reply through the worker lane lands on the new employer\'s conversation', async () => {
    const t = await thread(f1Job, f1.id);
    movedThread = { jobId: f1Job, conversationId: t.conversationId, worker: t.worker };

    const moved = await teamPost(owner, 'reassign', { jobId: f1Job, userId: f2.id });
    expect(moved).toEqual({ statusCode: 200, body: { jobId: f1Job, assigneeUserId: f2.id, changed: true } });
    expect(await employerOf('jobs', f1Job)).toBe(f2.id);
    expect(await employerOf('job_conversations', t.conversationId)).toBe(f2.id);
    expect((await world.su.query(`SELECT created_by_user_id FROM jobs WHERE id = $1`, [f1Job])).rows[0].created_by_user_id).toBe(f1.id);

    expect((await call(convDetail, f1, { pathParameters: { conversationId: t.conversationId } })).statusCode).toBe(404);
    expect((await call(convDetail, f2, { pathParameters: { conversationId: t.conversationId } })).statusCode).toBe(200);
    expect(jobIds(await call(listJobs, f1, {}))).not.toContain(f1Job);
    expect(jobIds(await call(listJobs, f2, {}))).toContain(f1Job);

    // The worker answers on WhatsApp: jale_whatsapp, the worker lane's own function.
    const client = await whatsappPool.connect();
    try {
      await client.query('BEGIN');
      await setInternalUserRlsContext(client, t.worker.id);
      await setAuditContext(client, auditCallerFor(`fixture-${randomUUID()}`, { kind: 'worker', id: t.worker.id }, 'whatsapp'), 'whatsapp.inbound');
      const routed = await recordWorkerConversationReply(
        client as PoolClient, t.worker.id, 'Fixture worker reply after the move', `whatsapp:${t.worker.phone}`, `SMfixture${randomUUID().replace(/-/g, '')}`, null,
      );
      await client.query('COMMIT');
      expect(routed).toEqual({ status: 'routed', conversationId: t.conversationId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const detail = await call(convDetail, f2, { pathParameters: { conversationId: t.conversationId } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ sender_type: 'worker', direction: 'inbound', body: 'Fixture worker reply after the move' }),
    ]));

    // The owner's digest still covers the moved job; it is now F2's, not F1's.
    expect(await digestReach(owner, [f1Job, f1SecondJob.id])).toEqual([f1Job, f1SecondJob.id].sort());
    expect(await digestReach(f2, [f1Job, f1SecondJob.id])).toEqual([f1Job]);
    expect(await digestReach(f1, [f1Job, f1SecondJob.id])).toEqual([f1SecondJob.id]);
  });

  it('after remove-with-reassign the assignee reads and answers the conversation; the removed foreman gets 403 membership_inactive removed', async () => {
    const removed = await teamPost(owner, 'remove', { userId: f1.id, reassignTo: f2.id });
    expect(removed).toEqual({ statusCode: 200, body: { removed: true, movedJobs: 1, accessUpdated: true } });
    // Cognito: disabled after COMMIT (the recorder already sees the removal).
    expect(mockAccessCalls).toEqual([{
      changes: [{ cognitoSub: f1.sub, enabled: false }],
      seen: [{ cognitoSub: f1.sub, status: 'removed', liveInvites: 0 }],
    }]);
    expect(await membershipOf(f1.id)).toEqual({ organization_id: orgId, role: 'foreman', status: 'removed' });
    expect(await employerOf('jobs', f1SecondJob.id)).toBe(f2.id);
    expect(await employerOf('job_conversations', f1SecondJob.conversationId)).toBe(f2.id);

    const read = await call(convDetail, f2, { pathParameters: { conversationId: f1SecondJob.conversationId } });
    expect(read.statusCode).toBe(200);
    const answered = await call(convSend, f2, {
      httpMethod: 'POST', pathParameters: { conversationId: f1SecondJob.conversationId }, body: { body: 'Fixture answer from the assignee' },
    });
    expect(answered.statusCode).toBe(200);
    expect((await world.su.query(
      `SELECT sender_user_id FROM job_conversation_messages WHERE conversation_id = $1 AND body = $2`,
      [f1SecondJob.conversationId, 'Fixture answer from the assignee'])).rows).toEqual([{ sender_user_id: f2.id }]);
    expect(mockSent.filter((s) => s.body?.includes('Fixture answer from the assignee'))).toHaveLength(1);

    expect(await call(listJobs, f1, {})).toEqual({ statusCode: 403, body: { error: 'membership_inactive', membershipStatus: 'removed' } });
    expect(await call(convDetail, f1, { pathParameters: { conversationId: f1SecondJob.conversationId } }))
      .toEqual({ statusCode: 403, body: { error: 'membership_inactive', membershipStatus: 'removed' } });
    expect(await teamGet(f1, 'membership')).toEqual({
      statusCode: 403, body: { error: 'membership_inactive', membershipStatus: 'removed', hasInvite: false },
    });
    expect(await seats()).toEqual({ active: 1, live: 1 });
  });

  it('the removed foreman\'s templates stay with the company: the owner and the assignee list and use them', async () => {
    expect((await world.su.query(`SELECT employer_id FROM employer_job_templates WHERE id = $1`, [f1Template])).rows)
      .toEqual([{ employer_id: f1.id }]);
    expect(templateIds(await call(listTemplates, owner, {}))).toContain(f1Template);
    expect(templateIds(await call(listTemplates, f2, {}))).toContain(f1Template);

    // Using it: a job posted from it records the template.
    for (const user of [owner, f2]) {
      const jobId = await postJob(user, { title: 'Fixture From F1 Template', template_id: f1Template });
      expect((await world.su.query(`SELECT employer_id, created_from_template_id FROM jobs WHERE id = $1`, [jobId])).rows)
        .toEqual([{ employer_id: user.id, created_from_template_id: f1Template }]);
    }
    // The owner still edits it.
    const renamed = await call(saveTemplate, owner, {
      httpMethod: 'POST', body: { id: f1Template, name: 'Fixture F1 Template (owner)', payload: TEMPLATE_PAYLOAD },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await world.su.query(`SELECT name FROM employer_job_templates WHERE id = $1`, [f1Template])).rows[0].name)
      .toBe('Fixture F1 Template (owner)');
  });

  it('re-invite of the removed foreman: Cognito enabled after COMMIT, sign-in accept rejoins, their old jobs stay with the assignee', async () => {
    const reinvited = await invite(f1Email);
    expect(reinvited.statusCode).toBe(201);
    expect(reinvited.body.accessUpdated).toBe(true);
    expect(mockAccessCalls).toEqual([{
      changes: [{ cognitoSub: f1.sub, enabled: true }],
      seen: [{ cognitoSub: f1.sub, status: 'removed', liveInvites: 1 }],
    }]);
    expect(await teamGet(f1, 'membership')).toEqual({
      statusCode: 403, body: { error: 'membership_inactive', membershipStatus: 'removed', hasInvite: true },
    });

    const token = await tokenOf(reinvited.body.invite.inviteId);
    expect((await lookup(token)).body).toEqual(expect.objectContaining({ email: f1Email, existingAccount: true }));

    mockAccessCalls.length = 0;
    const accepted = await call(inviteAccept, f1, {
      httpMethod: 'POST', resource: '/employer/invites/{token}', pathParameters: { token },
    });
    expect(accepted).toEqual({ statusCode: 200, body: { outcome: 'rejoined', organizationId: orgId } });
    expect(mockAccessCalls).toEqual([{
      changes: [{ cognitoSub: f1.sub, enabled: true }],
      seen: [{ cognitoSub: f1.sub, status: 'active', liveInvites: 0 }],
    }]);
    expect(await teamGet(f1, 'membership')).toEqual({
      statusCode: 200, body: { userId: f1.id, organizationId: orgId, role: 'foreman', companyName: 'Team Co' },
    });

    const listed = jobIds(await call(listJobs, f1, {}));
    expect(listed).not.toContain(f1Job);
    expect(listed).not.toContain(f1SecondJob.id);
    expect(await employerOf('jobs', f1Job)).toBe(f2.id);
    expect(await employerOf('jobs', f1SecondJob.id)).toBe(f2.id);
    expect(await seats()).toEqual({ active: 2, live: 1 });
  });

  // ── busy answers: lock wait and statement timeout ──────────────────

  it('a team call waiting past lock_timeout on the company lock answers 503 busy with Retry-After 2; nothing is written', async () => {
    const before = await seats();
    const warn = jest.spyOn(console, 'warn');
    const held = await holdCompanyLock(orgId);
    try {
      // The dispatcher's own 3 s lock_timeout.
      const startedAt = Date.now();
      const res = await team(apiEvent({
        sub: owner.sub, httpMethod: 'POST', resource: '/employer/team/{action}', pathParameters: { action: 'invite' },
        body: { email: `fixture-p3t12-busy-${randomUUID()}@fixture.invalid`, locale: 'en' },
      }));
      const waited = Date.now() - startedAt;
      expect({ statusCode: res.statusCode, retryAfter: res.headers?.['Retry-After'], body: JSON.parse(res.body) })
        .toEqual({ statusCode: 503, retryAfter: '2', body: { error: 'busy', retryable: true, retryAfterSeconds: 2 } });
      expect(waited).toBeGreaterThanOrEqual(2_500);
      expect(waited).toBeLessThan(9_000);

      // A short lock_timeout: the reassign and the signed-in accept give the same answer.
      mockPool = await timedPool({ lock_timeout: 300 });
      const reassign = await teamPost(owner, 'reassign', { jobId: f1Job, userId: owner.id });
      expect(reassign).toEqual({ statusCode: 503, body: { error: 'busy', retryable: true, retryAfterSeconds: 2 } });
      const accept = await call(inviteAccept, f2, {
        httpMethod: 'POST', resource: '/employer/invites/{token}', pathParameters: { token: pendingInviteToken },
      });
      expect(accept).toEqual({ statusCode: 503, body: { error: 'busy', retryable: true, retryAfterSeconds: 2 } });

      // No lock_timeout, a short statement_timeout: 57014, the same answer.
      mockPool = await timedPool({ statement_timeout: 300 });
      const remove = await teamPost(owner, 'remove', { userId: f1.id, reassignTo: f2.id });
      expect(remove).toEqual({ statusCode: 503, body: { error: 'busy', retryable: true, retryAfterSeconds: 2 } });

      // Each answer came from the SQLSTATE it names: lock waits 55P03, the statement timeout 57014.
      expect(warn.mock.calls).toEqual([
        ['employer-team-invite-create busy:', '55P03'],
        ['employer-team-job-reassign busy:', '55P03'],
        [JSON.stringify({ event: 'invite_accept_busy', error: '55P03' })],
        ['employer-team-member-remove busy:', '57014'],
      ]);
    } finally {
      warn.mockRestore();
      mockPool = apiPool;
      await held.release();
    }
    expect(await seats()).toEqual(before);
    expect(await membershipOf(f1.id)).toEqual({ organization_id: orgId, role: 'foreman', status: 'active' });
    expect(await employerOf('jobs', f1Job)).toBe(f2.id);
    expect(mockAccessCalls).toEqual([]);
  });

  // ── conversations-create racing a job move ─────────────────────────

  it('a conversation create racing a job move answers 409 job_move_conflict, whichever check refuses it', async () => {
    // What the database answered inside the handler, per variant.
    const refusals: unknown[] = [];
    const original = jobMessaging.createApplicantConversation;
    const spy = jest.spyOn(jobMessaging, 'createApplicantConversation').mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        refusals.push({ code: e.code, constraint: e.constraint });
        throw err;
      }
    });
    const mover = new Client({ connectionString: databaseUrl });
    await mover.connect();
    try {
      for (const variant of ['in flight: the foreign key (23503)', 'committed first: the application guard (23514)'] as const) {
        const jobId = await postJob(f2, { title: `Fixture Race Job ${variant}` });
        const worker = await world.worker({ lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' });
        await world.application(jobId, worker.id);
        const committedFirst = variant.startsWith('committed');
        if (committedFirst) {
          await world.su.query(`INSERT INTO worker_thread_counters (worker_id, last_number) VALUES ($1, 0) ON CONFLICT DO NOTHING`, [worker.id]);
        }

        await mover.query('BEGIN');
        // committed first: hold the worker's thread counter, so the handler
        // stops between its scope read and its insert; the move commits there.
        if (committedFirst) await mover.query(`SELECT 1 FROM worker_thread_counters WHERE worker_id = $1 FOR UPDATE`, [worker.id]);
        await mover.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [owner.id, jobId]);

        const pending = call(convCreate, f2, {
          httpMethod: 'POST', resource: '/employer/conversations',
          body: { job_id: jobId, worker_id: worker.id, initial_message: 'Fixture racing hello' },
        });
        await untilApiWaitsOnLock();
        await mover.query('COMMIT');
        const res = await pending;

        expect({ variant, res }).toEqual({ variant, res: { statusCode: 409, body: { error: 'job_move_conflict' } } });
        expect((await world.su.query(`SELECT count(*)::int AS n FROM job_conversations WHERE job_id = $1`, [jobId])).rows[0].n).toBe(0);
        expect(await employerOf('jobs', jobId)).toBe(owner.id);
      }
      expect(mockSent).toEqual([]);
      expect(refusals).toEqual([
        { code: '23503', constraint: 'job_conversations_job_employer_fkey' },
        { code: '23514', constraint: undefined },
      ]);
    } finally {
      spy.mockRestore();
      try { await mover.query('ROLLBACK'); } catch { /* already ended */ }
      await mover.end();
    }
  });

  // ── remove timing ──────────────────────────────────────────────────

  it('removing a foreman who holds 1,000 jobs (40 with conversations) finishes well inside the 10 s statement timeout', async () => {
    const timingOwner = await world.employer({ companyName: 'Fixture Timing Co' });
    const holder = await world.foreman(timingOwner.id, { fullName: 'Fixture Busy Foreman' });
    await world.su.query(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       SELECT $1, 'Fixture Timing Job ' || g, 'Fixture City', 'full-time', CASE WHEN g % 25 = 0 THEN 'paused' ELSE 'closed' END
         FROM generate_series(1, 1000) AS g`, [holder.id]);
    const workers = [];
    for (let i = 0; i < 5; i += 1) workers.push(await world.worker());
    await world.su.query(
      `WITH picked AS (
         SELECT id, row_number() OVER (ORDER BY id) AS n FROM jobs WHERE employer_id = $1 ORDER BY id LIMIT 40
       ), apps AS (
         INSERT INTO job_applications (job_id, worker_id, status)
         SELECT p.id, ($2::uuid[])[1 + (p.n % 5)::int], 'pending' FROM picked p
         RETURNING id, job_id, worker_id
       )
       INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id)
       SELECT a.job_id, $1, a.worker_id, a.id FROM apps a`,
      [holder.id, workers.map((w) => w.id)]);

    const startedAt = Date.now();
    const res = await teamPost(timingOwner, 'remove', { userId: holder.id, reassignTo: timingOwner.id });
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.info(`[r-paths-team] remove-with-reassign of 1,000 jobs / 40 conversations: ${elapsedMs} ms`);

    expect(res).toEqual({ statusCode: 200, body: { removed: true, movedJobs: 1000, accessUpdated: true } });
    expect(elapsedMs).toBeLessThan(5_000);
    expect((await world.su.query(
      `SELECT (SELECT count(*)::int FROM jobs WHERE employer_id = $1) AS held,
              (SELECT count(*)::int FROM jobs WHERE employer_id = $2) AS moved,
              (SELECT count(*)::int FROM job_conversations WHERE employer_id = $2) AS conversations`,
      [holder.id, timingOwner.id])).rows[0]).toEqual({ held: 0, moved: 1000, conversations: 40 });
  });
});
