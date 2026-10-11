import {
  parkPendingClaim,
  claimPendingReferral,
  resolveApplyToken,
  loadActiveJobLabel,
  findUnclaimedParkedJobId,
  isOpenUnappliedJob,
} from '../../../../../lambda/whatsapp/lib/referral-claims';
import { hashToken } from '../../../../../lambda/lib/referral-codes';

const PHONE_HASH = 'a'.repeat(64);
const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const SHARE_CODE = 'SHARECOD';
const REFERRER_ID = 'cccccccc-0000-0000-0000-000000000001';
const EMPLOYER_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const RAW_TOKEN = 'ABCD1234';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function makeClient() {
  const query = jest.fn();
  // Anything a test does not script resolves to an empty result rather than
  // `undefined`, so an unscripted statement can never pass by crashing inside
  // a SAVEPOINT that swallows the TypeError.
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  return { query, client: { query } as any };
}

/** The statements `query` saw, in order. */
function statements(query: jest.Mock): string[] {
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('parkPendingClaim', () => {
  it('never logs the raw token, and hashes it before querying', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ share_code: SHARE_CODE, job_id: JOB_ID, locale: 'es' }] }) // consume token
      .mockResolvedValueOnce({ rows: [{ referrer_worker_id: REFERRER_ID }] }) // share link lookup
      .mockResolvedValueOnce({ rows: [] }); // upsert pending claim

    const result = await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    // Sprint 27: the token row's job and locale come back with the park,
    // so the first reply can name the job in the language the link asked for.
    expect(result).toEqual({ parked: true, jobId: JOB_ID, locale: 'es' });
    const tokenCall = query.mock.calls[0];
    expect(tokenCall[0]).toMatch(/UPDATE referral_apply_tokens/);
    expect(tokenCall[0]).toMatch(/consumed_at IS NULL/);
    expect(tokenCall[0]).toMatch(/expires_at > \$2/);
    expect(tokenCall[1][0]).toBe(hashToken(RAW_TOKEN));
    expect(tokenCall[1][0]).not.toBe(RAW_TOKEN);
    // The raw token itself must never appear anywhere in the query params.
    expect(JSON.stringify(query.mock.calls)).not.toContain(RAW_TOKEN);
  });

  it('marks the token consumed with consumed_at and consumed_phone_hash together', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ share_code: null, job_id: JOB_ID, locale: null }] })
      .mockResolvedValueOnce({ rows: [] }); // upsert (no share_code lookup since share_code is null)

    await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    const tokenCall = query.mock.calls[0];
    expect(tokenCall[0]).toMatch(/consumed_phone_hash\s*=\s*\$3/);
    expect(tokenCall[1]).toEqual([hashToken(RAW_TOKEN), NOW.toISOString(), PHONE_HASH]);
    // No share_code -> no job_share_links lookup.
    expect(query.mock.calls.some(([sql]) => /job_share_links/.test(sql))).toBe(false);
  });

  it('derives referrer_worker_id and share_code from the token share link and upserts keyed on phone_hash', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ share_code: SHARE_CODE, job_id: JOB_ID, locale: 'en' }] })
      .mockResolvedValueOnce({ rows: [{ referrer_worker_id: REFERRER_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    const shareCall = query.mock.calls[1];
    expect(shareCall[0]).toMatch(/FROM job_share_links WHERE code = \$1/);
    expect(shareCall[1]).toEqual([SHARE_CODE]);

    const upsertCall = query.mock.calls[2];
    expect(upsertCall[0]).toMatch(/INSERT INTO referral_pending_claims/);
    expect(upsertCall[0]).toMatch(/ON CONFLICT \(phone_hash\) DO UPDATE/);
    expect(upsertCall[0]).toMatch(/claimed_at\s*=\s*NULL/);
    expect(upsertCall[0]).toMatch(/claimed_worker_id\s*=\s*NULL/);
    expect(upsertCall[1][0]).toBe(PHONE_HASH);
    expect(upsertCall[1][1]).toBe(JOB_ID);
    expect(upsertCall[1][2]).toBe(SHARE_CODE);
    expect(upsertCall[1][3]).toBe(REFERRER_ID);
    expect(upsertCall[1][4]).toBe('en');
    // expires_at ~= now + 30 days.
    const expiresAt = new Date(upsertCall[1][5]);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('an unknown/expired/already-consumed token parks nothing and never touches referral_pending_claims', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] }); // UPDATE matched zero rows

    const result = await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    // Nothing about the token leaks back either: no job, no locale.
    expect(result).toEqual({ parked: false, jobId: null, locale: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /referral_pending_claims/.test(sql))).toBe(false);
  });

  it('a second code from the same phone takes over the claim: the second upsert carries the second token\'s job/share/referrer for the same phone_hash', async () => {
    const { query, client } = makeClient();
    const firstJobId = 'dddddddd-0000-0000-0000-000000000010';
    const secondJobId = 'dddddddd-0000-0000-0000-000000000020';
    const secondToken = 'WXYZ9876';
    const secondShareCode = 'SHARECD2';
    const secondReferrer = 'eeeeeeee-0000-0000-0000-000000000020';

    // First code.
    query
      .mockResolvedValueOnce({ rows: [{ share_code: null, job_id: firstJobId, locale: null }] })
      .mockResolvedValueOnce({ rows: [] });
    await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    const firstUpsertCall = query.mock.calls[1];
    expect(firstUpsertCall[0]).toMatch(/ON CONFLICT \(phone_hash\) DO UPDATE/);
    expect(firstUpsertCall[1][0]).toBe(PHONE_HASH);
    expect(firstUpsertCall[1][1]).toBe(firstJobId);

    // Second, different code arrives from the SAME phone.
    query
      .mockResolvedValueOnce({ rows: [{ share_code: secondShareCode, job_id: secondJobId, locale: 'en' }] })
      .mockResolvedValueOnce({ rows: [{ referrer_worker_id: secondReferrer }] })
      .mockResolvedValueOnce({ rows: [] });
    const later = new Date(NOW.getTime() + 1000);
    const result = await parkPendingClaim(client, PHONE_HASH, secondToken, later);

    expect(result).toEqual({ parked: true, jobId: secondJobId, locale: 'en' });
    const secondUpsertCall = query.mock.calls[query.mock.calls.length - 1];
    expect(secondUpsertCall[0]).toMatch(/ON CONFLICT \(phone_hash\) DO UPDATE/);
    // Same phone_hash, but the SECOND token's job/share/referrer/locale win —
    // never a mix of the first and second claim's data.
    expect(secondUpsertCall[1]).toEqual([
      PHONE_HASH, secondJobId, secondShareCode, secondReferrer, 'en',
      new Date(later.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      later.toISOString(),
    ]);
  });

  it('keeps the job a new code replaces while the claim is unclaimed: appended once, never the incoming job, and a claimed row starts a new set', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ share_code: null, job_id: JOB_ID, locale: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    const upsert = String(query.mock.calls[1][0]).replace(/\s+/g, ' ');
    const insertColumns = upsert.slice(upsert.indexOf('('), upsert.indexOf(')') + 1);
    // A first park writes no set: the column's empty default applies.
    expect(insertColumns).not.toContain('earlier_job_ids');
    const setClause = upsert.slice(upsert.indexOf('DO UPDATE SET'));
    expect(setClause).toContain(
      'earlier_job_ids = CASE WHEN referral_pending_claims.claimed_at IS NULL '
      + 'THEN array_remove(array_remove(referral_pending_claims.earlier_job_ids, referral_pending_claims.job_id) '
      + '|| referral_pending_claims.job_id, EXCLUDED.job_id) '
      + "ELSE '{}'::uuid[] END",
    );
    // The credit columns still follow the last code.
    expect(setClause).toContain('job_id = EXCLUDED.job_id');
    expect(setClause).toContain('share_code = EXCLUDED.share_code');
    expect(setClause).toContain('referrer_worker_id = EXCLUDED.referrer_worker_id');
  });
});

describe('claimPendingReferral', () => {
  /**
   * Order-independent fake for the whole claim: the claim UPDATE, the live
   * share-link read, the attribution upsert, and the referred-jobs record
   * with its SAVEPOINT pair. `link` null means the link read finds nothing --
   * which is what a revoked link looks like, since the read filters
   * `revoked_at IS NULL` itself. A failed record leaves the transaction
   * aborted, as PostgreSQL does: every later statement fails until a
   * ROLLBACK TO SAVEPOINT. `recordFailsFor` fails the record of those jobs
   * only; `recordFails` fails every record.
   */
  function claimClient(opts: {
    claim?: {
      job_id: string;
      share_code: string | null;
      referrer_worker_id?: string | null;
      earlier_job_ids?: string[];
    } | null;
    link?: { channel: string; referrer_worker_id: string | null; referrer_employer_id: string | null } | null;
    attributionRowCount?: number;
    recordFails?: boolean;
    recordFailsFor?: string[];
  }) {
    let aborted = false;
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
        aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (aborted) {
        throw new Error('current transaction is aborted, commands ignored until end of transaction block');
      }
      if (/UPDATE referral_pending_claims/.test(sql)) {
        return { rows: opts.claim ? [opts.claim] : [], rowCount: opts.claim ? 1 : 0 };
      }
      if (/FROM job_share_links/.test(sql)) {
        return { rows: opts.link ? [opts.link] : [], rowCount: opts.link ? 1 : 0 };
      }
      if (/INSERT INTO worker_attribution/.test(sql)) {
        return { rows: [], rowCount: opts.attributionRowCount ?? 1 };
      }
      if (/INSERT INTO worker_referred_jobs/.test(sql)) {
        if (opts.recordFails || opts.recordFailsFor?.includes(String(params?.[1]))) {
          aborted = true;
          throw new Error('simulated_record_failure');
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    return { query, client: { query } as any };
  }

  function attributionParams(query: jest.Mock): unknown[] | undefined {
    const call = query.mock.calls.find(([sql]) => /INSERT INTO worker_attribution/.test(String(sql)));
    return call?.[1] as unknown[] | undefined;
  }

  it('returns claimed: false and no job when no unclaimed, unexpired pending claim exists', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: false, jobId: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /worker_attribution/.test(sql))).toBe(false);
    // Nothing to record either: there is no job without a claim.
    expect(query.mock.calls.some(([sql]) => /worker_referred_jobs/.test(sql))).toBe(false);
  });

  it('marks the claim claimed_at/claimed_worker_id together, resolves channel AND both referrers from the live share link, and writes first_* + latest_* on first claim', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: SHARE_CODE }] }) // claim UPDATE
      .mockResolvedValueOnce({ rows: [{ channel: 'facebook', referrer_worker_id: REFERRER_ID, referrer_employer_id: null }] }) // live share link
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // worker_attribution upsert persists

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
    const claimCall = query.mock.calls[0];
    expect(claimCall[0]).toMatch(/UPDATE referral_pending_claims/);
    expect(claimCall[0]).toMatch(/claimed_at IS NULL/);
    expect(claimCall[0]).toMatch(/expires_at > \$2/);
    expect(claimCall[0]).toMatch(/claimed_worker_id\s*=\s*\$3/);
    expect(claimCall[1]).toEqual([PHONE_HASH, NOW.toISOString(), WORKER_ID]);

    // Sprint 27: the same read writeWebAttribution does -- both referrer
    // columns, and only a link that is still live.
    const linkCall = query.mock.calls[1];
    expect(linkCall[0]).toMatch(
      /SELECT channel, referrer_worker_id, referrer_employer_id\s+FROM job_share_links\s+WHERE code = \$1\s+AND revoked_at IS NULL/,
    );
    expect(linkCall[1]).toEqual([SHARE_CODE]);

    const attributionCall = query.mock.calls[2];
    expect(attributionCall[0]).toMatch(/INSERT INTO worker_attribution/);
    expect(attributionCall[0]).toMatch(/first_referrer_worker_id/);
    expect(attributionCall[0]).toMatch(/latest_referrer_worker_id/);
    // The share link's ACTUAL channel ('facebook') is recorded, never a
    // fabricated 'whatsapp' — the arrival transport is not the earned channel.
    expect(attributionCall[1]).toEqual([WORKER_ID, SHARE_CODE, 'facebook', JOB_ID, REFERRER_ID, null, NOW.toISOString()]);
  });

  it('credits an EMPLOYER referrer from the link -- the referrer the parked claim never carried', async () => {
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE, referrer_worker_id: null },
      link: { channel: 'whatsapp', referrer_worker_id: null, referrer_employer_id: EMPLOYER_ID },
    });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
    expect(attributionParams(query)).toEqual([WORKER_ID, SHARE_CODE, 'whatsapp', JOB_ID, null, EMPLOYER_ID, NOW.toISOString()]);
  });

  it('takes the worker referrer from the LIVE link, never the referrer_worker_id parked on the claim', async () => {
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE, referrer_worker_id: 'ffffffff-0000-0000-0000-00000000dead' },
      link: { channel: 'sms', referrer_worker_id: REFERRER_ID, referrer_employer_id: null },
    });

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(attributionParams(query)).toEqual([WORKER_ID, SHARE_CODE, 'sms', JOB_ID, REFERRER_ID, null, NOW.toISOString()]);
  });

  it('a REVOKED link credits nobody: job-only attribution, channel "unknown", no share code, no referrers', async () => {
    // The link read filters revoked_at IS NULL, so a revoked link is simply
    // not found -- exactly the untagged path below.
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE },
      link: null,
    });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
    expect(attributionParams(query)).toEqual([WORKER_ID, null, 'unknown', JOB_ID, null, null, NOW.toISOString()]);
  });

  it('records channel "unknown" (never "whatsapp") when the claim has no share_code at all', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: null }] }) // claim UPDATE, no share_code
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // worker_attribution upsert persists — no link read, since share_code is null

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    // No share_code -> no job_share_links lookup at all.
    expect(query.mock.calls.some(([sql]) => /job_share_links/.test(String(sql)))).toBe(false);

    const attributionCall = query.mock.calls[1];
    expect(attributionCall[0]).toMatch(/INSERT INTO worker_attribution/);
    expect(attributionCall[1]).toEqual([WORKER_ID, null, 'unknown', JOB_ID, null, null, NOW.toISOString()]);
  });

  it('a worker claiming their OWN share link writes no attribution -- but the claim is consumed and the job still recorded', async () => {
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE },
      link: { channel: 'sms', referrer_worker_id: WORKER_ID, referrer_employer_id: null },
    });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(attributionParams(query)).toBeUndefined();
    // `claimed` is about the pending claim, not the credit: the row WAS
    // consumed, and the worker did come for this job.
    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
    expect(statements(query).some((sql) => /INSERT INTO worker_referred_jobs/.test(sql))).toBe(true);
  });

  it('the employer-side self-referral guard holds too: referrer_employer_id equal to the claiming id writes no attribution', async () => {
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE },
      link: { channel: 'sms', referrer_worker_id: null, referrer_employer_id: WORKER_ID },
    });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(attributionParams(query)).toBeUndefined();
    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
  });

  it('records the claimed job in worker_referred_jobs AFTER the claim, behind its own SAVEPOINT', async () => {
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE },
      link: { channel: 'facebook', referrer_worker_id: REFERRER_ID, referrer_employer_id: null },
    });

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    const sql = statements(query);
    const claimIdx = sql.findIndex((s) => /UPDATE referral_pending_claims/.test(s));
    const savepointIdx = sql.indexOf('SAVEPOINT referral_claim_record');
    const recordIdx = sql.findIndex((s) => /INSERT INTO worker_referred_jobs/.test(s));
    const releaseIdx = sql.indexOf('RELEASE SAVEPOINT referral_claim_record');
    expect(claimIdx).toBe(0);
    expect(savepointIdx).toBeGreaterThan(claimIdx);
    expect(recordIdx).toBeGreaterThan(savepointIdx);
    expect(releaseIdx).toBeGreaterThan(recordIdx);

    const recordCall = query.mock.calls[recordIdx];
    expect(recordCall[1]).toEqual([WORKER_ID, JOB_ID, 'whatsapp_token', NOW.toISOString()]);
  });

  it('records every job parked before the last code, oldest first and each older than the claimed job, in the same SAVEPOINT', async () => {
    const firstJob = 'dddddddd-0000-0000-0000-000000000031';
    const secondJob = 'dddddddd-0000-0000-0000-000000000032';
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: SHARE_CODE, earlier_job_ids: [firstJob, secondJob] },
      link: { channel: 'whatsapp', referrer_worker_id: null, referrer_employer_id: EMPLOYER_ID },
    });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    // The claim and its credit are the last code's alone.
    expect(result).toEqual({ claimed: true, jobId: JOB_ID });
    expect(attributionParams(query)).toEqual([WORKER_ID, SHARE_CODE, 'whatsapp', JOB_ID, null, EMPLOYER_ID, NOW.toISOString()]);
    expect(String(query.mock.calls[0][0])).toMatch(/RETURNING job_id, share_code, referrer_worker_id, earlier_job_ids/);

    const sql = statements(query);
    const savepointIdx = sql.indexOf('SAVEPOINT referral_claim_record');
    const releaseIdx = sql.indexOf('RELEASE SAVEPOINT referral_claim_record');
    const records = query.mock.calls
      .map(([text, params], index) => ({ text: String(text), params: params as unknown[], index }))
      .filter((call) => /INSERT INTO worker_referred_jobs/.test(call.text));
    expect(records.map((r) => r.params)).toEqual([
      [WORKER_ID, firstJob, 'whatsapp_token', new Date(NOW.getTime() - 2).toISOString()],
      [WORKER_ID, secondJob, 'whatsapp_token', new Date(NOW.getTime() - 1).toISOString()],
      [WORKER_ID, JOB_ID, 'whatsapp_token', NOW.toISOString()],
    ]);
    for (const record of records) {
      expect(record.index).toBeGreaterThan(savepointIdx);
      expect(record.index).toBeLessThan(releaseIdx);
    }
  });

  it('never records the claimed job twice, even if the earlier set names it', async () => {
    const firstJob = 'dddddddd-0000-0000-0000-000000000041';
    const { query, client } = claimClient({
      claim: { job_id: JOB_ID, share_code: null, earlier_job_ids: [firstJob, JOB_ID] },
    });

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    const recorded = query.mock.calls
      .filter(([text]) => /INSERT INTO worker_referred_jobs/.test(String(text)))
      .map(([, params]) => (params as unknown[])[1]);
    expect(recorded).toEqual([firstJob, JOB_ID]);
  });

  it('an earlier job that cannot be recorded is rolled back alone: the other earlier job and the claimed job are still recorded, and the claim succeeds', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const firstJob = 'dddddddd-0000-0000-0000-000000000061';
      const secondJob = 'dddddddd-0000-0000-0000-000000000062';
      const { query, client } = claimClient({
        claim: { job_id: JOB_ID, share_code: null, earlier_job_ids: [firstJob, secondJob] },
        recordFailsFor: [firstJob],
      });

      await expect(claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW))
        .resolves.toEqual({ claimed: true, jobId: JOB_ID });

      const sql = statements(query);
      const records = query.mock.calls
        .map(([text, params], index) => ({ text: String(text), params: params as unknown[], index }))
        .filter((call) => /INSERT INTO worker_referred_jobs/.test(call.text));
      expect(records.map((r) => r.params)).toEqual([
        [WORKER_ID, firstJob, 'whatsapp_token', new Date(NOW.getTime() - 2).toISOString()],
        [WORKER_ID, secondJob, 'whatsapp_token', new Date(NOW.getTime() - 1).toISOString()],
        [WORKER_ID, JOB_ID, 'whatsapp_token', NOW.toISOString()],
      ]);
      // Each earlier job is recorded behind a savepoint of its own, inside
      // the outer one; the claimed job is recorded in the outer one.
      for (const earlier of records.slice(0, 2)) {
        expect(sql[earlier.index - 1]).toMatch(/^SAVEPOINT (?!referral_claim_record$)\w+$/);
      }
      expect(sql[records[2].index - 1]).not.toMatch(/^SAVEPOINT /);
      // Only the failed job's own savepoint is rolled back, right after its
      // record; the outer savepoint is released.
      const rollbacks = sql
        .map((text, index) => ({ text, index }))
        .filter(({ text }) => /^ROLLBACK TO SAVEPOINT /.test(text));
      expect(rollbacks.map(({ index }) => index)).toEqual([records[0].index + 1]);
      expect(sql).toContain('RELEASE SAVEPOINT referral_claim_record');
      expect(sql).not.toContain('ROLLBACK TO SAVEPOINT referral_claim_record');
      // A static metric only.
      const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).toContain('ReferredJobRecordFailed');
      expect(logged).not.toContain(firstJob);
      expect(logged).not.toContain(PHONE_HASH);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('when the claimed job itself cannot be recorded, the whole record rolls back and the claim still succeeds', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Every record fails here, the claimed job's included.
      const { query, client } = claimClient({
        claim: { job_id: JOB_ID, share_code: null, earlier_job_ids: ['dddddddd-0000-0000-0000-000000000051'] },
        recordFails: true,
      });

      await expect(claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW))
        .resolves.toEqual({ claimed: true, jobId: JOB_ID });
      const sql = statements(query);
      expect(sql).toContain('ROLLBACK TO SAVEPOINT referral_claim_record');
      expect(sql).not.toContain('RELEASE SAVEPOINT referral_claim_record');
      expect(errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('ReferredJobRecordFailed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a failed record rolls back to its own SAVEPOINT and never fails the claim -- completion calls this bare', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { query, client } = claimClient({
        claim: { job_id: JOB_ID, share_code: null },
        recordFails: true,
      });

      await expect(claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW))
        .resolves.toEqual({ claimed: true, jobId: JOB_ID });

      const sql = statements(query);
      expect(sql).toContain('ROLLBACK TO SAVEPOINT referral_claim_record');
      expect(sql).not.toContain('RELEASE SAVEPOINT referral_claim_record');
      // The attribution written before the record is untouched by the rollback.
      expect(sql.some((s) => /INSERT INTO worker_attribution/.test(s))).toBe(true);

      // A static metric only -- never the phone hash, the worker, or the job.
      const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).toContain('ReferredJobRecordFailed');
      expect(logged).not.toContain(PHONE_HASH);
      expect(logged).not.toContain(JOB_ID);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('writes first_* only once: a second call with a different referrer only moves latest_*, never first_*', async () => {
    const { query, client } = makeClient();

    // First claim: claim UPDATE, live link, attribution upsert, then the
    // record's SAVEPOINT / INSERT / RELEASE.
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: SHARE_CODE }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'whatsapp', referrer_worker_id: REFERRER_ID, referrer_employer_id: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    // Second claim for the SAME worker, different referrer/job/share code.
    const secondJobId = 'dddddddd-0000-0000-0000-000000000002';
    const secondShareCode = 'OTHRSHR2';
    const secondReferrer = 'eeeeeeee-0000-0000-0000-000000000002';
    const later = new Date(NOW.getTime() + 1000);
    query
      .mockResolvedValueOnce({ rows: [{ job_id: secondJobId, share_code: secondShareCode }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'facebook', referrer_worker_id: secondReferrer, referrer_employer_id: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, later);

    const attributionCalls = query.mock.calls.filter(([sql]) => /INSERT INTO worker_attribution/.test(String(sql)));
    expect(attributionCalls).toHaveLength(2);
    const secondAttributionCall = attributionCalls[1];
    const upsertSql = secondAttributionCall[0] as string;

    // The DO UPDATE SET list must not mention any first_* column — the
    // BEFORE UPDATE trigger raises if a first_* value changes, so simply
    // never including them in the SET list is what keeps this safe even
    // when the incoming referrer/job/share code differ from the first claim.
    const setClauseMatch = upsertSql.match(/DO UPDATE\s+SET([\s\S]*)$/);
    expect(setClauseMatch).not.toBeNull();
    const setClause = setClauseMatch![1];
    expect(setClause).not.toMatch(/first_share_code/);
    expect(setClause).not.toMatch(/first_channel/);
    expect(setClause).not.toMatch(/first_job_id/);
    expect(setClause).not.toMatch(/first_referrer_worker_id/);
    expect(setClause).not.toMatch(/first_seen_at/);
    expect(setClause).toMatch(/latest_referrer_worker_id\s*=\s*EXCLUDED\.latest_referrer_worker_id/);
    expect(secondAttributionCall[1]).toEqual([WORKER_ID, secondShareCode, 'facebook', secondJobId, secondReferrer, null, later.toISOString()]);
  });

  it('never logs a phone or phone_hash (query params carry it, but no console call is made)', async () => {
    const { client } = claimClient({ claim: { job_id: JOB_ID, share_code: null } });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('resolveApplyToken', () => {
  it('reads the token row by hash and NEVER consumes it', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({
      rows: [{ job_id: JOB_ID, share_code: SHARE_CODE, expires_at: '2026-07-30T12:00:00.000Z' }],
    });

    const row = await resolveApplyToken(client, RAW_TOKEN);

    expect(row).toEqual({ job_id: JOB_ID, share_code: SHARE_CODE, expires_at: '2026-07-30T12:00:00.000Z' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/SELECT job_id, share_code, expires_at FROM referral_apply_tokens WHERE token_hash = \$1/);
    expect(query.mock.calls[0][1]).toEqual([hashToken(RAW_TOKEN)]);
    // No expiry or consumption predicate: a consumed or expired token's row
    // still answers -- the row existing is the whole question.
    expect(query.mock.calls[0][0]).not.toMatch(/consumed_at|expires_at >/);
    expect(statements(query).some((sql) => /UPDATE/.test(sql))).toBe(false);
    expect(JSON.stringify(query.mock.calls)).not.toContain(RAW_TOKEN);
  });

  it('returns null for a token that was never issued', async () => {
    const { client } = makeClient();
    await expect(resolveApplyToken(client, RAW_TOKEN)).resolves.toBeNull();
  });
});

describe('loadActiveJobLabel', () => {
  it("reads an ACTIVE job's title and company, with the feed's 'Jale' default", async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ title: 'Finish Carpenter', company: 'Jale' }] });

    await expect(loadActiveJobLabel(client, JOB_ID)).resolves.toEqual({ title: 'Finish Carpenter', company: 'Jale' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ').trim()).toBe(
      "SELECT title, COALESCE(company, 'Jale') AS company FROM jobs WHERE id = $1 AND status = 'active'",
    );
    expect(params).toEqual([JOB_ID]);
  });

  it('returns null when the job is closed, filled or gone', async () => {
    const { client } = makeClient();
    await expect(loadActiveJobLabel(client, JOB_ID)).resolves.toBeNull();
  });
});

describe('findUnclaimedParkedJobId', () => {
  it("returns the job of this phone's UNCLAIMED parked claim", async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ job_id: JOB_ID }] });

    await expect(findUnclaimedParkedJobId(client, PHONE_HASH)).resolves.toBe(JOB_ID);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/SELECT job_id\s+FROM referral_pending_claims\s+WHERE phone_hash = \$1\s+AND claimed_at IS NULL/);
    expect(params).toEqual([PHONE_HASH]);
  });

  it('returns null when nothing is parked (or the claim was already claimed)', async () => {
    const { client } = makeClient();
    await expect(findUnclaimedParkedJobId(client, PHONE_HASH)).resolves.toBeNull();
  });
});

describe('isOpenUnappliedJob', () => {
  it('is true only for an active job this worker has not applied to, binding the worker explicitly', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ open: 1 }], rowCount: 1 });

    await expect(isOpenUnappliedJob(client, JOB_ID, WORKER_ID)).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("j.status = 'active'");
    // The worker is bound in the statement itself, so another worker's
    // application never hides the job.
    expect(text).toContain('ja.worker_id = $2');
    expect(params).toEqual([JOB_ID, WORKER_ID]);
  });

  it('is false for a closed job or one the worker already applied to', async () => {
    const { client } = makeClient();
    await expect(isOpenUnappliedJob(client, JOB_ID, WORKER_ID)).resolves.toBe(false);
  });
});
