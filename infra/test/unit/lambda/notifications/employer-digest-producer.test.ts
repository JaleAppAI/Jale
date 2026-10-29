/**
 * Mocked harness for the employer daily-digest producer.
 *
 * Style follows email-outbox-sweeper.test.ts (module-level jest.mock of
 * lib/db) plus employer-candidate-ranking.test.ts's SQL-pattern-matched
 * client.query stub. No live database: every claim here is about the
 * producer's control flow, transaction shape, and the payload it hands to
 * queueEmail. The RLS/policy behaviour of the underlying statements is
 * covered by the migration-080 PostgreSQL suite, not by this file.
 */

const mockSqsClient = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: mockSqsClient,
  SendMessageCommand: jest.fn(),
}));

const sequence: string[] = [];
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockSetRlsContext = jest.fn();
const mockSetInternalUserRlsContext = jest.fn();
const mockQueueEmail = jest.fn();
const mockListEmployerCandidates = jest.fn();
const mockMintUnsubscribeToken = jest.fn();
const mockGetUnsubscribeSecret = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: (...args: unknown[]) => {
    sequence.push(`setRlsContext:${String(args[1])}`);
    return mockSetRlsContext(...args);
  },
  setInternalUserRlsContext: (...args: unknown[]) => {
    sequence.push(`setInternalUserRlsContext:${String(args[1])}`);
    return mockSetInternalUserRlsContext(...args);
  },
}));
jest.mock('../../../../lambda/lib/email-outbox', () => ({
  queueEmail: (...args: unknown[]) => {
    sequence.push('queueEmail');
    return mockQueueEmail(...args);
  },
}));
jest.mock('../../../../lambda/lib/employer-candidate-ranking', () => ({
  listEmployerCandidates: (...args: unknown[]) => mockListEmployerCandidates(...args),
}));
jest.mock('../../../../lambda/lib/unsubscribe-token', () => ({
  mintUnsubscribeToken: (...args: unknown[]) => {
    sequence.push('mint');
    return mockMintUnsubscribeToken(...args);
  },
}));
jest.mock('../../../../lambda/lib/unsubscribe-secret', () => ({
  getUnsubscribeSecret: (...args: unknown[]) => {
    sequence.push('getUnsubscribeSecret');
    return mockGetUnsubscribeSecret(...args);
  },
}));

import { handler } from '../../../../lambda/notifications/employer-digest-producer';

const EMPLOYER_A = '11111111-2222-4333-8444-555555555555';
const EMPLOYER_B = '22222222-3333-4444-8555-666666666666';
const JOB_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const BASE_URL = 'https://jaleapp.ai';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Deliberate skew between Node's clock and the "database" clock, applied to
 * EVERY fixture. applied_at and last_sent_at are both written by the DB, so the
 * cutoff the producer compares them against must come from the DB too. Making
 * the two clocks differ by default means any regression back to `new Date()`
 * shows up as a wrong candidate set somewhere in this file rather than only in
 * the one test that targets it.
 */
const DB_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface DueRow {
  employer_id: string;
  cognito_sub: string;
  email: string | null;
  send_hour_local: number;
  timezone: string;
  language: string;
  last_sent_at: Date | null;
  unsubscribe_token_version: number;
}

function dueRow(overrides: Partial<DueRow> = {}): DueRow {
  return {
    employer_id: EMPLOYER_A,
    cognito_sub: 'sub-a',
    email: 'a@example.com',
    send_hour_local: 8,
    timezone: 'America/Chicago',
    language: 'en',
    last_sent_at: new Date(Date.now() - DAY),
    unsubscribe_token_version: 1,
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    application_id: 'cccccccc-dddd-4eee-8fff-000000000000',
    worker_id: 'dddddddd-eeee-4fff-8000-111111111111',
    display_name: 'Maria Lopez',
    phone: '+15551234567',
    status: 'applied',
    applied_at: new Date(Date.now() - 60 * 60 * 1000),
    skills: [],
    availability: null,
    years_experience: null,
    location: 'Austin, TX',
    trust_score: 70,
    match_score: 80,
    score_band: 'strong',
    match_reasons: [],
    ...overrides,
  };
}

function rankingResult(candidates: unknown[], shouldEnqueueRerank = true) {
  return {
    response: {
      ranking_status: 'deterministic',
      ranking_version: 'sql-v1',
      candidates,
      total: candidates.length,
      computed_at: new Date().toISOString(),
    },
    sourceHash: 'hash',
    shouldEnqueueRerank,
  };
}

interface DbFixture {
  due: DueRow[];
  jobs: Record<string, Array<{ id: string; title: string }>>;
  localDate?: string;
  /** What `SELECT now()` hands back. Defaults to Node-now + DB_CLOCK_SKEW_MS. */
  dbCutoff?: Date;
  /** Set to 0 to simulate an RLS-filtered watermark UPDATE that matches nothing. */
  watermarkRowCount?: number;
  /** Set to true to have the clock query come back with no row at all. */
  clockReturnsNoRow?: boolean;
  /** F19: what the hire-details nudge claim hands back. */
  nudges?: Array<Record<string, unknown>>;
  nudgeClaimError?: Error;
  /** Phase 3: employers with no active membership (org_member_scope is '{}'). */
  inactive?: string[];
  /** Phase 3: org_owner_scope per employer; absent means '{}' (not an active owner). */
  ownerScope?: Record<string, string[]>;
}

function configureDb(fixture: DbFixture): Date {
  const dbCutoff = fixture.dbCutoff ?? new Date(Date.now() + DB_CLOCK_SKEW_MS);
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      sequence.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    // The nudge sweep's per-row savepoint, by statement kind.
    const savepoint = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.exec(text);
    if (savepoint) {
      sequence.push(savepoint[1] === 'RELEASE SAVEPOINT' ? 'RELEASE' : savepoint[1]);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('mark_hire_details_nudged')) {
      sequence.push('mark');
      return Promise.resolve({ rows: [{ marked: true }], rowCount: 1 });
    }
    if (text.includes('due_digest_employers')) {
      sequence.push('due');
      return Promise.resolve({ rows: fixture.due, rowCount: fixture.due.length });
    }
    if (text.includes('AT TIME ZONE')) {
      sequence.push('clock');
      if (fixture.clockReturnsNoRow) return Promise.resolve({ rows: [], rowCount: 0 });
      // node-postgres parses timestamptz into a JS Date, so the stub does too.
      return Promise.resolve({
        rows: [{ cutoff: dbCutoff, local_date: fixture.localDate ?? '2026-08-21' }],
        rowCount: 1,
      });
    }
    // Phase 3: is the due employer an active member, and whose jobs does
    // their digest cover (an owner's company; '{}' for anyone else).
    if (text.includes('org_member_scope')) {
      sequence.push('member');
      const employerId = String((params ?? [])[0]);
      return Promise.resolve({ rows: [{ active: !(fixture.inactive ?? []).includes(employerId) }], rowCount: 1 });
    }
    if (text.includes('org_owner_scope')) {
      sequence.push('scope');
      const employerId = String((params ?? [])[0]);
      return Promise.resolve({ rows: [{ scope: fixture.ownerScope?.[employerId] ?? [] }], rowCount: 1 });
    }
    if (/FROM jobs\b/.test(text)) {
      sequence.push('jobs');
      const first = (params ?? [])[0];
      const employerIds = Array.isArray(first) ? first.map(String) : [String(first)];
      const rows = employerIds.flatMap((employerId) => fixture.jobs[employerId] ?? []);
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (text.includes('claim_hire_details_nudges')) {
      sequence.push('claim nudges');
      if (fixture.nudgeClaimError) return Promise.reject(fixture.nudgeClaimError);
      const rows = fixture.nudges ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (text.includes('UPDATE employer_digest_settings')) {
      sequence.push('watermark');
      return Promise.resolve({ rows: [], rowCount: fixture.watermarkRowCount ?? 1 });
    }
    sequence.push(`other:${text.slice(0, 40)}`);
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return dbCutoff;
}

/**
 * The digest's own steps: everything before the hire-details nudge sweep,
 * which opens its own transaction after the digest loop (F19).
 */
function digestSequence(): string[] {
  const claimAt = sequence.indexOf('claim nudges');
  return claimAt < 0 ? [...sequence] : sequence.slice(0, sequence.lastIndexOf('BEGIN', claimAt));
}

describe('employer-digest-producer', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    sequence.length = 0;
    process.env = { ...env, PUBLIC_SITE_BASE_URL: BASE_URL };
    mockQueueEmail.mockResolvedValue('outbox-id');
    mockMintUnsubscribeToken.mockResolvedValue('tok.sig');
    mockGetUnsubscribeSecret.mockResolvedValue('signing-secret');
    mockListEmployerCandidates.mockResolvedValue(rankingResult([]));
  });
  afterAll(() => { process.env = env; });

  // ── Configuration ─────────────────────────────────────────────────────────

  it('fails closed when PUBLIC_SITE_BASE_URL is missing — never mails a relative link', async () => {
    delete process.env.PUBLIC_SITE_BASE_URL;
    configureDb({ due: [], jobs: {} });
    await expect(handler()).rejects.toThrow(/PUBLIC_SITE_BASE_URL|base_url/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fails the WHOLE run before opening a connection when the signing secret is unreadable', async () => {
    // Not a per-employer concern. Fetching the secret lazily inside the loop
    // would put a Secrets-Manager-over-VPC call inside an open
    // email_outbox-writing transaction, and its failure would land in the
    // per-employer catch — invisible to metricErrors and to the DLQ. Warming it
    // up front turns a missing secret into a loud whole-run failure instead.
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [] } });
    mockGetUnsubscribeSecret.mockRejectedValue(new Error('unsubscribe_secret_empty'));
    await expect(handler()).rejects.toThrow(/unsubscribe_secret/);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('warms the signing secret before the first BEGIN, never inside a transaction', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    const warm = sequence.indexOf('getUnsubscribeSecret');
    const begin = sequence.indexOf('BEGIN');
    expect(warm).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(warm).toBeLessThan(begin);
  });

  /** Every mint or secret read that happened while a transaction was open. */
  function networkStepsInsideTransactions(): string[] {
    const inside: string[] = [];
    let open = false;
    for (const step of sequence) {
      if (step === 'BEGIN') open = true;
      else if (step === 'COMMIT' || step === 'ROLLBACK') open = false;
      else if (open && (step === 'mint' || step === 'getUnsubscribeSecret')) inside.push(step);
    }
    return inside;
  }

  it('mints every employer’s unsubscribe token before that employer’s BEGIN, never inside a transaction', async () => {
    configureDb({
      due: [dueRow(), dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b' })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }], [EMPLOYER_B]: [{ id: JOB_2, title: 'Plumber' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    const result = await handler();
    expect(result).toMatchObject({ due: 2, queued: 2, failed: 0 });
    expect(sequence.filter((step) => step === 'mint')).toHaveLength(2);
    expect(networkStepsInsideTransactions()).toEqual([]);
  });

  it('a mint failure still fails only an employer that has something to send; a quiet one stays quiet', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    configureDb({
      due: [dueRow(), dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b' })],
      jobs: { [EMPLOYER_A]: [], [EMPLOYER_B]: [{ id: JOB_2, title: 'Plumber' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    mockMintUnsubscribeToken.mockRejectedValue(new Error('unsubscribe_secret_throttled'));
    const result = await handler();
    expect(result).toMatchObject({ due: 2, quiet: 1, failed: 1, queued: 0 });
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(networkStepsInsideTransactions()).toEqual([]);
  });

  // ── Due-selection delegation ───────────────────────────────────────────────

  it('delegates due selection entirely to the SECURITY DEFINER function', async () => {
    configureDb({ due: [], jobs: {} });
    const result = await handler();
    const dueCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('due_digest_employers'));
    expect(dueCall).toBeDefined();
    expect(String(dueCall![0])).toContain('jale_digest_internal.due_digest_employers');
    expect(String(dueCall![0])).toContain('now()');
    // No hand-rolled hour/timezone/watermark predicate in the Lambda.
    const allSql = mockQuery.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allSql).not.toMatch(/send_hour_local\s*=/);
    expect(result).toMatchObject({ due: 0, queued: 0 });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('sets both RLS GUCs, in order, before reading the employer’s jobs', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [] } });
    await handler();
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'sub-a');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), EMPLOYER_A);
    const begin = sequence.indexOf('BEGIN');
    const sub = sequence.indexOf('setRlsContext:sub-a');
    const internal = sequence.indexOf(`setInternalUserRlsContext:${EMPLOYER_A}`);
    const jobs = sequence.indexOf('jobs');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(sub);
    expect(sub).toBeLessThan(internal);
    expect(internal).toBeLessThan(jobs);
  });

  // ── Watermark filtering ───────────────────────────────────────────────────

  it('counts only applicants after last_sent_at and at or before the cutoff', async () => {
    const lastSent = new Date(Date.now() - DAY);
    configureDb({ due: [dueRow({ last_sent_at: lastSent })], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'Fresh', applied_at: new Date(Date.now() - 60 * 1000) }),
      candidate({ display_name: 'Stale', applied_at: new Date(lastSent.getTime() - 1000) }),
      candidate({ display_name: 'ExactlyAtWatermark', applied_at: lastSent }),
      candidate({ display_name: 'FromTheFuture', applied_at: new Date(Date.now() + 10 * 60 * 1000) }),
    ]));
    await handler();
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.bodyText).toContain('Fresh');
    expect(input.bodyText).not.toContain('Stale');
    expect(input.bodyText).not.toContain('ExactlyAtWatermark');
    expect(input.bodyText).not.toContain('FromTheFuture');
    expect(input.subject).toMatch(/^1 new applicant\b/);
  });

  it('takes the cutoff from the DATABASE clock, not Node’s', async () => {
    // applied_at and last_sent_at are both DB-clock values. If the cutoff came
    // from Node and Lambda ran behind RDS, this applicant — already committed on
    // the DB clock, still "in the future" on Node's — would be dropped from this
    // digest AND from the next one (applied_at <= the advanced watermark).
    const dbCutoff = configureDb({
      due: [dueRow({ last_sent_at: new Date(Date.now() - DAY) })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'AheadOfNodeClock', applied_at: new Date(Date.now() + 2 * 60 * 1000) }),
      candidate({ display_name: 'AfterTheDbCutoff', applied_at: new Date(dbCutoff.getTime() + 1000) }),
    ]));
    await handler();
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.bodyText).toContain('AheadOfNodeClock');
    expect(input.bodyText).not.toContain('AfterTheDbCutoff');
  });

  it('stores the DB cutoff itself as the watermark, so no applicant falls between the two', async () => {
    const dbCutoff = configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    const watermarkCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE employer_digest_settings'));
    expect(watermarkCall![1]).toEqual([EMPLOYER_A, dbCutoff]);
  });

  it('reads the cutoff and the local date in ONE statement, from the DB clock, after the GUCs', async () => {
    configureDb({ due: [dueRow({ timezone: 'Asia/Tokyo' })], jobs: { [EMPLOYER_A]: [] } });
    await handler();
    const clockCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('AT TIME ZONE'));
    const sql = String(clockCall![0]);
    expect(sql).toMatch(/now\(\)\s+AS\s+cutoff/i);
    expect(sql).toContain('AT TIME ZONE');
    // The explicit ::text cast on the zone parameter — belt and braces on
    // unknown-parameter resolution for AT TIME ZONE.
    expect(sql).toContain('$1::text');
    expect(clockCall![1]).toEqual(['Asia/Tokyo']);
    // Exactly one clock round trip per employer: no separate local-date query.
    expect(sequence.filter((s) => s === 'clock')).toHaveLength(1);
    const internal = sequence.indexOf(`setInternalUserRlsContext:${EMPLOYER_A}`);
    expect(internal).toBeLessThan(sequence.indexOf('clock'));
  });

  it('fails the employer closed — no mail — when the clock row comes back empty', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
      clockReturnsNoRow: true,
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler();
    // A missing cutoff must NOT silently degrade into "nobody is new" — that
    // would look exactly like a quiet day and commit.
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(digestSequence()).toContain('ROLLBACK');
    expect(digestSequence()).not.toContain('COMMIT');
    expect(result).toMatchObject({ due: 1, queued: 0, quiet: 0, failed: 1 });
    errorLog.mockRestore();
  });

  it('treats a null last_sent_at as "everything is new"', async () => {
    configureDb({ due: [dueRow({ last_sent_at: null })], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'Ancient', applied_at: new Date(Date.now() - 400 * DAY) }),
    ]));
    await handler();
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][1].bodyText).toContain('Ancient');
  });

  it('drops jobs with zero new applicants but keeps the ones that have them', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }, { id: JOB_2, title: 'Plumber' }] },
    });
    mockListEmployerCandidates.mockImplementation((_client: unknown, jobId: string) =>
      Promise.resolve(jobId === JOB_1
        ? rankingResult([candidate({ display_name: 'Maria Lopez' })])
        : rankingResult([candidate({ display_name: 'TooOld', applied_at: new Date(Date.now() - 5 * DAY) })])));
    await handler();
    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.bodyText).toContain('Electrician');
    expect(input.bodyText).not.toContain('Plumber');
  });

  it('asks for exactly 100 candidates with contact details — never limit 0', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockListEmployerCandidates).toHaveBeenCalledWith(
      expect.anything(),
      JOB_1,
      { limit: 100, includeContact: true },
    );
  });

  it('reads only active jobs (the enum value is "active", not "open")', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [] } });
    await handler();
    const jobsCall = mockQuery.mock.calls.find((c) => /FROM jobs\b/.test(String(c[0])));
    expect(String(jobsCall![0])).toContain("status = 'active'");
    expect(String(jobsCall![0])).toContain('employer_id = ANY($1::uuid[])');
    expect(jobsCall![1]).toEqual([[EMPLOYER_A]]);
  });

  // ── Phase 3: the owner's digest covers the company ────────────────────────

  describe('company digest', () => {
    const FOREMAN = '55555555-6666-4777-8888-999999999999';
    const OWNER_JOB = JOB_1;
    const FOREMAN_JOB = JOB_2;

    function companyFixture(overrides: Partial<DbFixture> = {}): DbFixture {
      return {
        due: [dueRow()],
        jobs: {
          [EMPLOYER_A]: [{ id: OWNER_JOB, title: 'Electrician' }],
          [FOREMAN]: [{ id: FOREMAN_JOB, title: 'Plumber' }],
        },
        ownerScope: { [EMPLOYER_A]: [EMPLOYER_A, FOREMAN] },
        ...overrides,
      };
    }

    it('an owner\'s digest lists every member\'s active jobs', async () => {
      configureDb(companyFixture());
      mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));

      const result = await handler();

      expect(result).toMatchObject({ due: 1, queued: 1 });
      const scopeCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('org_owner_scope'));
      expect(String(scopeCall![0])).toBe('SELECT jale_internal.org_owner_scope($1::text, false) AS scope');
      expect(scopeCall![1]).toEqual([EMPLOYER_A]);
      const jobsCall = mockQuery.mock.calls.find((c) => /FROM jobs\b/.test(String(c[0])));
      expect(jobsCall![1]).toEqual([[EMPLOYER_A, FOREMAN]]);
      expect(mockListEmployerCandidates.mock.calls.map(([, jobId]) => jobId)).toEqual([OWNER_JOB, FOREMAN_JOB]);
      const [, input] = mockQueueEmail.mock.calls[0];
      expect(input.bodyText).toContain('Electrician');
      expect(input.bodyText).toContain('Plumber');
      // Still one digest, to the owner's address, keyed on the owner.
      expect(mockQueueEmail).toHaveBeenCalledTimes(1);
      expect(input.recipientEmail).toBe('a@example.com');
      expect(input.idempotencyKey).toMatch(new RegExp(`^employer-digest:${EMPLOYER_A}:`));
    });

    it('a foreman\'s digest lists only their own', async () => {
      configureDb(companyFixture({
        due: [dueRow({ employer_id: FOREMAN, cognito_sub: 'sub-f', email: 'f@example.com' })],
      }));
      mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));

      const result = await handler();

      expect(result).toMatchObject({ due: 1, queued: 1 });
      const jobsCall = mockQuery.mock.calls.find((c) => /FROM jobs\b/.test(String(c[0])));
      expect(jobsCall![1]).toEqual([[FOREMAN]]);
      // Membership first (right after the GUCs), then the scope, then the jobs.
      expect(digestSequence().filter((s) => ['BEGIN', 'setInternalUserRlsContext:' + FOREMAN, 'member', 'clock', 'scope', 'jobs'].includes(s)))
        .toEqual(['BEGIN', `setInternalUserRlsContext:${FOREMAN}`, 'member', 'clock', 'scope', 'jobs']);
      expect(mockListEmployerCandidates.mock.calls.map(([, jobId]) => jobId)).toEqual([FOREMAN_JOB]);
      const [, input] = mockQueueEmail.mock.calls[0];
      expect(input.bodyText).toContain('Plumber');
      expect(input.bodyText).not.toContain('Electrician');
    });

    it('an inactive member is skipped with digest_skipped_inactive_member and no watermark advance', async () => {
      configureDb(companyFixture({
        due: [
          dueRow({ employer_id: FOREMAN, cognito_sub: 'sub-f', email: 'f@example.com' }),
          dueRow(),
        ],
        inactive: [FOREMAN],
      }));
      mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
      const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

      const result = await handler();

      expect(result).toMatchObject({ due: 2, queued: 1, quiet: 0, skipped: 1, failed: 0 });
      expect(result.queued + result.quiet + result.skipped + result.failed + result.deferred).toBe(result.due);
      const memberCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('org_member_scope'));
      expect(String(memberCall![0])).toBe('SELECT cardinality(jale_internal.org_member_scope($1::text)) > 0 AS active');
      expect(memberCall![1]).toEqual([FOREMAN]);
      // The foreman's transaction: GUCs, the membership read, COMMIT -- no
      // jobs read, no mail, no watermark.
      const firstCommit = digestSequence().indexOf('COMMIT');
      expect(digestSequence().slice(0, firstCommit + 1)).toEqual([
        'getUnsubscribeSecret', 'due', 'mint', 'BEGIN',
        'setRlsContext:sub-f', `setInternalUserRlsContext:${FOREMAN}`, 'member', 'COMMIT',
      ]);
      expect(digestSequence().filter((s) => s === 'watermark')).toHaveLength(1);
      const watermarkCalls = mockQuery.mock.calls.filter((c) => String(c[0]).includes('UPDATE employer_digest_settings'));
      expect(watermarkCalls.map((c) => c[1]![0])).toEqual([EMPLOYER_A]);
      expect(mockQueueEmail.mock.calls.map(([, input]) => input.recipientEmail)).toEqual(['a@example.com']);
      const lines = info.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(JSON.stringify({ metric: 'digest_skipped_inactive_member', employerId: FOREMAN }));
      info.mockRestore();
    });

    it('stops before an employer once the time budget is short: the rest are deferred, untouched, logged once', async () => {
      const EMPLOYER_C = '33333333-4444-4555-8666-777777777777';
      configureDb(companyFixture({
        due: [
          dueRow(),
          dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b' }),
          dueRow({ employer_id: EMPLOYER_C, cognito_sub: 'sub-c' }),
        ],
        jobs: { [EMPLOYER_A]: [{ id: OWNER_JOB, title: 'Electrician' }] },
      }));
      // The first employer's ranking uses up the budget.
      let remaining = 40_000;
      mockListEmployerCandidates.mockImplementation(() => { remaining = 14_999; return Promise.resolve(rankingResult([candidate()])); });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await handler(undefined, { getRemainingTimeInMillis: () => remaining });
      const deadlines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('digest_run_deadline'));
      warn.mockRestore();

      expect(result).toEqual({ due: 3, queued: 1, quiet: 0, skipped: 0, failed: 0, deferred: 2 });
      expect(result.queued + result.quiet + result.skipped + result.failed + result.deferred).toBe(result.due);
      expect(deadlines).toEqual([JSON.stringify({ metric: 'digest_run_deadline', deferred: 2 })]);
      // B and C: no mint, no transaction, no watermark.
      expect(mockMintUnsubscribeToken).toHaveBeenCalledTimes(1);
      expect(sequence.filter((s) => s === 'BEGIN')).toHaveLength(1);
      expect(sequence).not.toContain('setRlsContext:sub-b');
      expect(sequence.filter((s) => s === 'watermark')).toHaveLength(1);
    });

    it('an owner whose scope comes back empty still gets their own jobs', async () => {
      configureDb(companyFixture({ ownerScope: {} }));
      mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));

      await handler();

      const jobsCall = mockQuery.mock.calls.find((c) => /FROM jobs\b/.test(String(c[0])));
      expect(jobsCall![1]).toEqual([[EMPLOYER_A]]);
    });
  });

  // ── Quiet day ─────────────────────────────────────────────────────────────

  it('commits without advancing the watermark and sends nothing when every job is empty', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([]));
    const result = await handler();
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(sequence).not.toContain('watermark');
    expect(sequence).toContain('COMMIT');
    expect(sequence).not.toContain('ROLLBACK');
    expect(result).toMatchObject({ due: 1, queued: 0, quiet: 1 });
  });

  // ── 10-cap + "+N more" ────────────────────────────────────────────────────

  it('renders at most 10 candidates per job and a "+N more" line for the rest', async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => candidate({
      display_name: `Worker${i}`,
      match_score: 99 - i,
      applied_at: new Date(Date.now() - (i + 1) * 60 * 1000),
    }));
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult(fifteen));
    await handler();
    const input = mockQueueEmail.mock.calls[0][1];
    // Ranked best -> lowest: the first ten survive, the rest become "+5 more".
    for (let i = 0; i < 10; i += 1) expect(input.bodyText).toContain(`Worker${i}`);
    for (let i = 10; i < 15; i += 1) expect(input.bodyText).not.toContain(`Worker${i}`);
    expect(input.bodyText).toMatch(/\+\s*5 more/);
    expect(input.bodyText).toContain(`${BASE_URL}/en/employer/jobs/${JOB_1}`);
    expect(input.subject).toMatch(/^15 new applicants\b/);
  });

  // ── Idempotency key and local date ────────────────────────────────────────

  it('derives the idempotency key from the employer’s LOCAL calendar date', async () => {
    configureDb({
      due: [dueRow({ timezone: 'Asia/Tokyo' })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
      localDate: '2026-08-22',
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    // The zone is the ONLY parameter: the timestamp side is now(), read from
    // the DB clock in the same statement rather than passed in from Node.
    const localDateCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('AT TIME ZONE'));
    expect(localDateCall![1]).toEqual(['Asia/Tokyo']);
    expect(mockQueueEmail.mock.calls[0][1]).toMatchObject({
      idempotencyKey: `employer-digest:${EMPLOYER_A}:2026-08-22`,
      sourceType: 'employer_digest',
      sourceId: EMPLOYER_A,
      recipientEmail: 'a@example.com',
    });
  });

  // ── Transaction shape ─────────────────────────────────────────────────────

  it('queues the email and advances the watermark inside the SAME transaction', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    const begin = digestSequence().indexOf('BEGIN');
    const queue = digestSequence().indexOf('queueEmail');
    const watermark = digestSequence().indexOf('watermark');
    const commit = digestSequence().indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(queue);
    expect(queue).toBeLessThan(watermark);
    expect(watermark).toBeLessThan(commit);
    // Exactly one transaction, and no COMMIT between the queue and the update.
    expect(digestSequence().filter((s) => s === 'COMMIT')).toHaveLength(1);
    const watermarkCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE employer_digest_settings'));
    expect(String(watermarkCall![0])).toContain('last_sent_at');
    expect(watermarkCall![1]![0]).toBe(EMPLOYER_A);
  });

  it('rolls the queued email BACK when the watermark UPDATE matches zero rows', async () => {
    // employer_digest_settings is FORCE RLS, and an RLS-filtered UPDATE that
    // matches nothing raises nothing. Committing here would send a digest with
    // an unadvanced watermark, which re-mails the same backlog every day
    // forever — silently. The at-most-once property depends on this check.
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
      watermarkRowCount: 0,
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler();
    // The email was queued inside the transaction, so the ROLLBACK unqueues it.
    expect(digestSequence()).toContain('queueEmail');
    expect(digestSequence()).toContain('watermark');
    expect(digestSequence()).toContain('ROLLBACK');
    expect(digestSequence()).not.toContain('COMMIT');
    expect(result).toMatchObject({ due: 1, queued: 0, failed: 1 });
    errorLog.mockRestore();
  });

  it('commits when the watermark UPDATE matches exactly one row', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
      watermarkRowCount: 1,
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    const result = await handler();
    expect(sequence).toContain('COMMIT');
    expect(sequence).not.toContain('ROLLBACK');
    expect(result).toMatchObject({ queued: 1, failed: 0 });
  });

  // ── Invalid email ─────────────────────────────────────────────────────────

  // Every case here must be caught by the guard rather than becoming a 23514
  // from email_outbox's `length BETWEEN 3 AND 320 AND position('@') > 1` CHECK:
  // a 23514 aborts the transaction and lands in the per-employer catch, which
  // reports the wrong failure shape (failed, not skipped).
  it.each([
    ['null', null],
    ['no at-sign', 'not-an-email'],
    ['over 320 chars', `${'a'.repeat(320)}@example.com`],
    ['at-sign first — position(@) = 1 fails the CHECK', '@bc'],
    ['shorter than the 3-char minimum', 'a@'],
    ['empty string', ''],
  ])('skips an employer with an invalid email (%s): logs the metric, commits, no watermark advance', async (_label, email) => {
    configureDb({ due: [dueRow({ email: email as string | null })], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await handler();
    // The metric name is the literal the NotificationsStack MetricFilter matches.
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => JSON.parse(line).metric === 'digest_skipped_invalid_email')).toBe(true);
    expect(logged.some((line) => JSON.parse(line).employerId === EMPLOYER_A)).toBe(true);
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(sequence).not.toContain('watermark');
    expect(sequence).toContain('COMMIT');
    expect(result).toMatchObject({ skipped: 1, queued: 0 });
    warn.mockRestore();
  });

  // ── Per-employer isolation ────────────────────────────────────────────────

  it('one failing employer does not starve the rest', async () => {
    configureDb({
      due: [
        dueRow({ employer_id: EMPLOYER_A, cognito_sub: 'sub-a', email: 'a@example.com' }),
        dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b', email: 'b@example.com' }),
      ],
      jobs: {
        [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }],
        [EMPLOYER_B]: [{ id: JOB_2, title: 'Plumber' }],
      },
    });
    mockListEmployerCandidates.mockImplementation((_client: unknown, jobId: string) => {
      if (jobId === JOB_1) return Promise.reject(new Error('employer A exploded'));
      return Promise.resolve(rankingResult([candidate({ display_name: 'Second Employer Worker' })]));
    });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler();
    expect(sequence).toContain('ROLLBACK');
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][1].recipientEmail).toBe('b@example.com');
    expect(result).toMatchObject({ due: 2, queued: 1, failed: 1 });
    expect(errorLog).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it('emits an alarmable digest_employer_failed line for a per-employer failure', async () => {
    // The catch returns normally, so metricErrors sees nothing and the DLQ stays
    // empty. Without this structured line every per-employer failure — a 23514,
    // an idempotency conflict, a Secrets Manager throttle — is invisible.
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockRejectedValue(new Error('boom'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await handler();
    // A single argument, so the JSON survives into the log event intact: a
    // second object argument would be formatted separately and no filter
    // pattern could match it.
    const metricLines = errorLog.mock.calls
      .filter((c) => c.length === 1 && typeof c[0] === 'string' && c[0].startsWith('{'))
      .map((c) => JSON.parse(String(c[0])));
    expect(metricLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'digest_employer_failed', employerId: EMPLOYER_A }),
    ]));
    errorLog.mockRestore();
  });

  it('accounts for every due employer exactly once across the summary counters', async () => {
    // due must equal queued + quiet + skipped + failed. Without this, a future
    // early-return path shows up as {due: 40} whose parts sum to 39 and nobody
    // notices — the exact observability gap the metrics above exist to close.
    const EMPLOYER_C = '33333333-4444-4555-8666-777777777777';
    const EMPLOYER_D = '44444444-5555-4666-8777-888888888888';
    const JOB_QUIET = 'cccccccc-1111-4222-8333-444444444444';
    const JOB_FAILS = 'dddddddd-1111-4222-8333-444444444444';
    configureDb({
      due: [
        dueRow({ employer_id: EMPLOYER_A, cognito_sub: 'sub-a', email: 'a@example.com' }),
        dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b', email: 'b@example.com' }),
        dueRow({ employer_id: EMPLOYER_C, cognito_sub: 'sub-c', email: 'not-an-email' }),
        dueRow({ employer_id: EMPLOYER_D, cognito_sub: 'sub-d', email: 'd@example.com' }),
      ],
      jobs: {
        // A queues, B is quiet, C is skipped before it ever reads jobs, D fails.
        [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }],
        [EMPLOYER_B]: [{ id: JOB_QUIET, title: 'Plumber' }],
        [EMPLOYER_C]: [{ id: JOB_2, title: 'Welder' }],
        [EMPLOYER_D]: [{ id: JOB_FAILS, title: 'Roofer' }],
      },
    });
    mockListEmployerCandidates.mockImplementation((_client: unknown, jobId: string) => {
      if (jobId === JOB_1) return Promise.resolve(rankingResult([candidate()]));
      if (jobId === JOB_QUIET) return Promise.resolve(rankingResult([]));
      if (jobId === JOB_FAILS) return Promise.reject(new Error('employer D exploded'));
      throw new Error(`unexpected job read for ${jobId} — the skipped employer must never reach a jobs query`);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler();
    expect(result).toMatchObject({ due: 4, queued: 1, quiet: 1, skipped: 1, failed: 1 });
    expect(result.queued + result.quiet + result.skipped + result.failed + result.deferred).toBe(result.due);
    warn.mockRestore();
    errorLog.mockRestore();
  });

  it('survives a ROLLBACK that itself throws, and still processes the NEXT employer', async () => {
    // The pool is max:1. A throwing ROLLBACK that escaped the guard would take
    // the single connection — and therefore every remaining employer — down
    // with it, so the second employer here is the whole point of the test.
    const dueRows = [
      dueRow({ employer_id: EMPLOYER_A, cognito_sub: 'sub-a', email: 'a@example.com' }),
      dueRow({ employer_id: EMPLOYER_B, cognito_sub: 'sub-b', email: 'b@example.com' }),
    ];
    configureDb({
      due: dueRows,
      jobs: {
        [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }],
        [EMPLOYER_B]: [{ id: JOB_2, title: 'Plumber' }],
      },
    });
    const baseQuery = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (String(sql) === 'ROLLBACK') {
        sequence.push('ROLLBACK');
        return Promise.reject(new Error('connection is dead'));
      }
      return baseQuery(sql, params);
    });
    mockListEmployerCandidates.mockImplementation((_client: unknown, jobId: string) => {
      if (jobId === JOB_1) return Promise.reject(new Error('boom'));
      return Promise.resolve(rankingResult([candidate({ display_name: 'Second Employer Worker' })]));
    });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler();
    expect(sequence).toContain('ROLLBACK');
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][1].recipientEmail).toBe('b@example.com');
    expect(result).toMatchObject({ due: 2, queued: 1, failed: 1 });
    expect(mockRelease).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  // ── Rerank must never be enqueued ─────────────────────────────────────────

  it('never enqueues a rerank, even though shouldEnqueueRerank is true', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()], true));
    process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL = 'https://sqs.example/queue';
    await handler();
    expect(mockSqsClient).not.toHaveBeenCalled();
    delete process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL;
  });

  // ── Unsubscribe link ──────────────────────────────────────────────────────

  it('mints the unsubscribe token with the version straight from the due row', async () => {
    configureDb({
      due: [dueRow({ unsubscribe_token_version: 4 })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    mockMintUnsubscribeToken.mockResolvedValue('minted-token');
    await handler();
    expect(mockMintUnsubscribeToken).toHaveBeenCalledWith(EMPLOYER_A, 4);
    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.bodyText).toContain(`${BASE_URL}/en/digest-unsubscribe?token=minted-token`);
    expect(input.bodyHtml).toContain(`${BASE_URL}/en/digest-unsubscribe?token=minted-token`);
    // Never built from the API Gateway URL.
    expect(input.bodyText).not.toMatch(/execute-api/);
  });

  // ── Bilingual ─────────────────────────────────────────────────────────────

  it('renders Spanish copy and Spanish links for language=es', async () => {
    configureDb({ due: [dueRow({ language: 'es' })], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electricista' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    mockMintUnsubscribeToken.mockResolvedValue('tok-es');
    await handler();
    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.subject).toMatch(/postulante/);
    expect(input.bodyText).toContain(`${BASE_URL}/es/employer/dashboard`);
    expect(input.bodyText).toContain(`${BASE_URL}/es/digest-unsubscribe?token=tok-es`);
    expect(input.bodyText).toContain(`${BASE_URL}/es/employer/jobs/${JOB_1}`);
  });

  it('falls back to English for an unexpected language value', async () => {
    configureDb({ due: [dueRow({ language: 'fr' })], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].bodyText).toContain(`${BASE_URL}/en/employer/dashboard`);
  });

  // ── Subject bound ─────────────────────────────────────────────────────────

  it('keeps the subject inside the email_outbox 200-char CHECK for a hostile job title', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'X'.repeat(5000) }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].subject.length).toBeLessThanOrEqual(200);
  });

  // ── Branded-shell model fields ────────────────────────────────────────────

  it('links the notification settings page in the HTML footer', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].bodyHtml)
      .toContain(`href="${BASE_URL}/en/employer/profile"`);

    jest.clearAllMocks();
    mockQueueEmail.mockResolvedValue('outbox-id');
    mockMintUnsubscribeToken.mockResolvedValue('tok.sig');
    mockGetUnsubscribeSecret.mockResolvedValue('signing-secret');
    configureDb({
      due: [dueRow({ language: 'es' })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electricista' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].bodyHtml)
      .toContain(`href="${BASE_URL}/es/employer/profile"`);
  });

  it('tells a first-time recipient the window is since they turned the digest on', async () => {
    // The intro must describe the SAME window the candidate filter used, and
    // that filter keys off last_sent_at being null — not off a separate flag
    // that could drift away from it.
    configureDb({
      due: [dueRow({ last_sent_at: null })],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].bodyText).toMatch(/since you turned on the daily digest/);

    jest.clearAllMocks();
    mockQueueEmail.mockResolvedValue('outbox-id');
    mockMintUnsubscribeToken.mockResolvedValue('tok.sig');
    mockGetUnsubscribeSecret.mockResolvedValue('signing-secret');
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));
    await handler();
    expect(mockQueueEmail.mock.calls[0][1].bodyText).toMatch(/since your last digest/);
  });

  // ── RFC 8058 one-click header material (sprint 22 R3-E) ──────────────────

  /**
   * TWO unsubscribe URLs and they are not interchangeable: the footer link is
   * the human page (whose GET is inert, because mail scanners follow links),
   * and the headers bag carries the API endpoint a mail provider can POST to.
   */
  it('queues the API one-click endpoint in headers while the body keeps the human page link', async () => {
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'Fresh', applied_at: new Date(Date.now() - 60 * 1000) }),
    ]));

    await handler();

    const input = mockQueueEmail.mock.calls[0][1];
    expect(input.headers).toEqual({
      unsubscribe_url: `${BASE_URL}/api/public/employer-digest/unsubscribe?token=tok.sig`,
    });
    // The rendered body still points at the Next.js page, not the API.
    expect(input.bodyText).toContain(`${BASE_URL}/en/digest-unsubscribe?token=tok.sig`);
    expect(input.bodyText).not.toContain('/api/public/employer-digest/unsubscribe');
  });

  it('honours an explicit PUBLIC_API_BASE_URL for a deployment whose API is elsewhere', async () => {
    process.env.PUBLIC_API_BASE_URL = 'https://api.jaleapp.ai/';
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'Fresh', applied_at: new Date(Date.now() - 60 * 1000) }),
    ]));

    await handler();

    expect(mockQueueEmail.mock.calls[0][1].headers).toEqual({
      unsubscribe_url: 'https://api.jaleapp.ai/public/employer-digest/unsubscribe?token=tok.sig',
    });
  });

  it('percent-encodes the token so a signature character cannot end the query string', async () => {
    mockMintUnsubscribeToken.mockResolvedValue('payload.sig+with/chars=');
    configureDb({
      due: [dueRow()],
      jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] },
    });
    mockListEmployerCandidates.mockResolvedValue(rankingResult([
      candidate({ display_name: 'Fresh', applied_at: new Date(Date.now() - 60 * 1000) }),
    ]));

    await handler();

    expect(mockQueueEmail.mock.calls[0][1].headers.unsubscribe_url)
      .toBe(`${BASE_URL}/api/public/employer-digest/unsubscribe?token=payload.sig%2Bwith%2Fchars%3D`);
  });

  // ── F19: the hire-details nudge (sprint 28, K4.4) ─────────────────────────

  describe('hire-details nudge', () => {
    const APP = 'eeeeeeee-ffff-4000-8111-222222222222';
    const APP_2 = 'ffffffff-0000-4111-8222-333333333333';
    const APP_3 = 'aaaaaaaa-0000-4111-8222-444444444444';
    const REMINDED_AT = new Date('2026-10-14T09:00:00.000Z');
    const nudge = (overrides: Record<string, unknown> = {}) => ({
      application_id: APP, job_id: JOB_1, employer_id: EMPLOYER_A, employer_email: 'a@example.com',
      worker_name: 'Ana Maria Ruiz', job_title: 'Glazier', kind: 'auto', requested_at: null, ...overrides,
    });
    const nudgeCalls = () => mockQueueEmail.mock.calls.filter(([, input]) => input.sourceType === 'hire_details_nudge');
    /** The applications the sweep stamped, in order. */
    const marked = () => mockQuery.mock.calls
      .filter(([sql]) => String(sql).includes('mark_hire_details_nudged'))
      .map(([, params]) => (params as unknown[])[0]);
    /** Everything from the sweep's own BEGIN on. */
    const sweep = () => sequence.slice(sequence.lastIndexOf('BEGIN', sequence.indexOf('claim nudges')));

    it('claims, queues and stamps in ONE transaction, one savepoint per row', async () => {
      configureDb({ due: [], jobs: {}, nudges: [nudge(), nudge({ application_id: APP_2, kind: 'remind', requested_at: REMINDED_AT })] });

      const result = await handler();

      expect(result).toEqual({ due: 0, queued: 0, quiet: 0, skipped: 0, failed: 0, deferred: 0 });
      const claim = mockQuery.mock.calls.find(([sql]) => String(sql).includes('claim_hire_details_nudges'));
      expect(claim?.[1]).toEqual([25]);
      expect(sweep()).toEqual([
        'BEGIN', 'claim nudges',
        'SAVEPOINT', 'queueEmail', 'mark', 'RELEASE',
        'SAVEPOINT', 'queueEmail', 'mark', 'RELEASE',
        'COMMIT',
      ]);
      expect(marked()).toEqual([APP, APP_2]);
      expect(nudgeCalls().map(([, input]) => [input.idempotencyKey, input.sourceId, input.recipientEmail])).toEqual([
        [`hire-details-nudge:${APP}`, APP, 'a@example.com'],
        [`hire-details-remind:${APP_2}:${REMINDED_AT.getTime()}`, APP_2, 'a@example.com'],
      ]);
      const [, first] = nudgeCalls()[0];
      expect(first.subject).toBe('Add start details for Ana · Agregue los detalles de inicio para Ana');
      expect(first.bodyText).toContain('Ana was hired for Glazier. Add a start date and where to report.');
      expect(first.bodyText).toContain('Se contrató a Ana para Glazier. Agregue una fecha de inicio y el lugar donde debe presentarse.');
      expect(first.bodyText).toContain(`${BASE_URL}/en/employer/applicants`);
      expect(first.bodyText).toContain(`${BASE_URL}/es/employer/applicants`);
      expect(nudgeCalls()[1][1].bodyText).toContain('Ana asked for their start details for Glazier.');
    });

    it('a throw mid-batch rolls back only that row, which stays unstamped and claimable', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      configureDb({ due: [], jobs: {}, nudges: [nudge(), nudge({ application_id: APP_2 }), nudge({ application_id: APP_3 })] });
      mockQueueEmail.mockImplementation((_client: unknown, input: { sourceId: string }) => (
        input.sourceId === APP_2 ? Promise.reject(new Error('boom')) : Promise.resolve('outbox-id')));

      await handler();

      expect(marked()).toEqual([APP, APP_3]);
      expect(sweep()).toEqual([
        'BEGIN', 'claim nudges',
        'SAVEPOINT', 'queueEmail', 'mark', 'RELEASE',
        'SAVEPOINT', 'queueEmail', 'ROLLBACK TO SAVEPOINT',
        'SAVEPOINT', 'queueEmail', 'mark', 'RELEASE',
        'COMMIT',
      ]);
      expect(error.mock.calls.map(([line]) => String(line)).some((line) => line.includes('hire_details_nudge_failed'))).toBe(true);
      error.mockRestore();
    });

    it('a render failure is caught by the same per-row guard', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      configureDb({ due: [], jobs: {}, nudges: [nudge({ job_title: null }), nudge({ application_id: APP_2 })] });

      await handler();

      expect(marked()).toEqual([APP_2]);
      expect(sweep()).toContain('ROLLBACK TO SAVEPOINT');
      error.mockRestore();
    });

    it('never stamps a row whose address cannot be sent to, so it stays claimable', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      configureDb({ due: [], jobs: {}, nudges: [nudge({ employer_email: '@bad' }), nudge({ application_id: APP_2 })] });

      await handler();

      expect(marked()).toEqual([APP_2]);
      expect(nudgeCalls().map(([, input]) => input.sourceId)).toEqual([APP_2]);
      expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.includes('hire_details_nudge_skipped_invalid_email'))).toBe(true);
      warn.mockRestore();
    });

    it('stops before the function runs out of time, leaving the rest unstamped', async () => {
      configureDb({ due: [], jobs: {}, nudges: [nudge(), nudge({ application_id: APP_2 }), nudge({ application_id: APP_3 })] });
      let remaining = 60_000;
      mockQueueEmail.mockImplementation(() => { remaining -= 25_000; return Promise.resolve('outbox-id'); });

      await handler(undefined, { getRemainingTimeInMillis: () => remaining });

      expect(marked()).toEqual([APP, APP_2]);
      expect(sweep()[sweep().length - 1]).toBe('COMMIT');
    });

    it('skips the sweep entirely when the digest left too little time', async () => {
      configureDb({ due: [], jobs: {}, nudges: [nudge()] });
      await handler(undefined, { getRemainingTimeInMillis: () => 5_000 });
      expect(sequence).not.toContain('claim nudges');
    });

    it('runs after the digest\'s last transaction', async () => {
      configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] }, nudges: [nudge()] });
      mockListEmployerCandidates.mockResolvedValue(rankingResult([candidate()]));

      await handler();

      expect(sequence.indexOf('watermark')).toBeLessThan(sequence.indexOf('claim nudges'));
    });

    it('a failing claim rolls the sweep back and never fails the digest run', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      configureDb({ due: [], jobs: {}, nudgeClaimError: new Error('claim down') });
      await expect(handler()).resolves.toEqual({ due: 0, queued: 0, quiet: 0, skipped: 0, failed: 0, deferred: 0 });
      expect(sweep()).toEqual(['BEGIN', 'claim nudges', 'ROLLBACK']);
      expect(error.mock.calls.map(([line]) => String(line)).some((line) => line.includes('hire_details_nudge_run_failed'))).toBe(true);
      error.mockRestore();
    });
  });
});
