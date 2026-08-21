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
  mintUnsubscribeToken: (...args: unknown[]) => mockMintUnsubscribeToken(...args),
}));

import { handler } from '../../../../lambda/notifications/employer-digest-producer';

const EMPLOYER_A = '11111111-2222-4333-8444-555555555555';
const EMPLOYER_B = '22222222-3333-4444-8555-666666666666';
const JOB_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const BASE_URL = 'https://jaleapp.ai';

const DAY = 24 * 60 * 60 * 1000;

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
}

function configureDb(fixture: DbFixture): void {
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      sequence.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('due_digest_employers')) {
      sequence.push('due');
      return Promise.resolve({ rows: fixture.due, rowCount: fixture.due.length });
    }
    if (text.includes('AT TIME ZONE')) {
      sequence.push('localDate');
      return Promise.resolve({ rows: [{ local_date: fixture.localDate ?? '2026-08-21' }], rowCount: 1 });
    }
    if (/FROM jobs\b/.test(text)) {
      sequence.push('jobs');
      const employerId = String((params ?? [])[0]);
      const rows = fixture.jobs[employerId] ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (text.includes('UPDATE employer_digest_settings')) {
      sequence.push('watermark');
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    sequence.push(`other:${text.slice(0, 40)}`);
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('employer-digest-producer', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    sequence.length = 0;
    process.env = { ...env, PUBLIC_SITE_BASE_URL: BASE_URL };
    mockQueueEmail.mockResolvedValue('outbox-id');
    mockMintUnsubscribeToken.mockResolvedValue('tok.sig');
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
    expect(jobsCall![1]).toEqual([EMPLOYER_A]);
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
    expect(result).toMatchObject({ due: 1, queued: 0 });
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
    const localDateCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('AT TIME ZONE'));
    expect(localDateCall![1]).toEqual([expect.any(String), 'Asia/Tokyo']);
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
    const begin = sequence.indexOf('BEGIN');
    const queue = sequence.indexOf('queueEmail');
    const watermark = sequence.indexOf('watermark');
    const commit = sequence.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(queue);
    expect(queue).toBeLessThan(watermark);
    expect(watermark).toBeLessThan(commit);
    // Exactly one transaction, and no COMMIT between the queue and the update.
    expect(sequence.filter((s) => s === 'COMMIT')).toHaveLength(1);
    const watermarkCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE employer_digest_settings'));
    expect(String(watermarkCall![0])).toContain('last_sent_at');
    expect(watermarkCall![1]![0]).toBe(EMPLOYER_A);
  });

  // ── Invalid email ─────────────────────────────────────────────────────────

  it.each([
    ['null', null],
    ['no at-sign', 'not-an-email'],
    ['over 320 chars', `${'a'.repeat(320)}@example.com`],
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

  it('survives a ROLLBACK that itself throws', async () => {
    configureDb({ due: [dueRow()], jobs: { [EMPLOYER_A]: [{ id: JOB_1, title: 'Electrician' }] } });
    mockListEmployerCandidates.mockRejectedValue(new Error('boom'));
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text === 'ROLLBACK') return Promise.reject(new Error('connection is dead'));
      if (text.includes('due_digest_employers')) {
        return Promise.resolve({ rows: [dueRow()], rowCount: 1 });
      }
      if (text.includes('AT TIME ZONE')) return Promise.resolve({ rows: [{ local_date: '2026-08-21' }] });
      if (/FROM jobs\b/.test(text)) return Promise.resolve({ rows: [{ id: JOB_1, title: 'Electrician' }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler()).resolves.toMatchObject({ failed: 1 });
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
});
