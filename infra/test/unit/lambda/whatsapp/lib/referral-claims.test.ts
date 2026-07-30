import { parkPendingClaim, claimPendingReferral } from '../../../../../lambda/whatsapp/lib/referral-claims';
import { hashToken } from '../../../../../lambda/lib/referral-codes';

const PHONE_HASH = 'a'.repeat(64);
const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const SHARE_CODE = 'SHARECOD';
const REFERRER_ID = 'cccccccc-0000-0000-0000-000000000001';
const RAW_TOKEN = 'ABCD1234';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function makeClient() {
  const query = jest.fn();
  return { query, client: { query } as any };
}

describe('parkPendingClaim', () => {
  it('never logs the raw token, and hashes it before querying', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ share_code: SHARE_CODE, job_id: JOB_ID, locale: 'es' }] }) // consume token
      .mockResolvedValueOnce({ rows: [{ referrer_worker_id: REFERRER_ID }] }) // share link lookup
      .mockResolvedValueOnce({ rows: [] }); // upsert pending claim

    const result = await parkPendingClaim(client, PHONE_HASH, RAW_TOKEN, NOW);

    expect(result).toEqual({ parked: true });
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

    expect(result).toEqual({ parked: false });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /referral_pending_claims/.test(sql))).toBe(false);
  });

  it('a second code from the same phone replaces the first: the second upsert carries the second token\'s job/share/referrer for the same phone_hash', async () => {
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

    expect(result).toEqual({ parked: true });
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
});

describe('claimPendingReferral', () => {
  it('returns claimed: false when no unclaimed, unexpired pending claim exists', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: false });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /worker_attribution/.test(sql))).toBe(false);
  });

  it('marks the claim claimed_at/claimed_worker_id together, resolves the channel from the share link, and writes first_* + latest_* on first claim', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: SHARE_CODE, referrer_worker_id: REFERRER_ID }] }) // claim UPDATE
      .mockResolvedValueOnce({ rows: [{ channel: 'facebook' }] }) // channel lookup on the share link
      .mockResolvedValueOnce({ rows: [] }); // worker_attribution upsert

    const result = await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(result).toEqual({ claimed: true });
    const claimCall = query.mock.calls[0];
    expect(claimCall[0]).toMatch(/UPDATE referral_pending_claims/);
    expect(claimCall[0]).toMatch(/claimed_at IS NULL/);
    expect(claimCall[0]).toMatch(/expires_at > \$2/);
    expect(claimCall[0]).toMatch(/claimed_worker_id\s*=\s*\$3/);
    expect(claimCall[1]).toEqual([PHONE_HASH, NOW.toISOString(), WORKER_ID]);

    const channelCall = query.mock.calls[1];
    expect(channelCall[0]).toMatch(/SELECT channel FROM job_share_links WHERE code = \$1/);
    expect(channelCall[1]).toEqual([SHARE_CODE]);

    const attributionCall = query.mock.calls[2];
    expect(attributionCall[0]).toMatch(/INSERT INTO worker_attribution/);
    expect(attributionCall[0]).toMatch(/first_referrer_worker_id/);
    expect(attributionCall[0]).toMatch(/latest_referrer_worker_id/);
    // The share link's ACTUAL channel ('facebook') is recorded, never a
    // fabricated 'whatsapp' — the arrival transport is not the earned channel.
    expect(attributionCall[1]).toEqual([WORKER_ID, SHARE_CODE, 'facebook', JOB_ID, REFERRER_ID, NOW.toISOString()]);
  });

  it('records channel "unknown" (never "whatsapp") when the claim has no share_code at all', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: null, referrer_worker_id: null }] }) // claim UPDATE, no share_code
      .mockResolvedValueOnce({ rows: [] }); // worker_attribution upsert — no channel lookup, since share_code is null

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    // No share_code -> no job_share_links lookup at all.
    expect(query.mock.calls.some(([sql]) => /job_share_links/.test(String(sql)))).toBe(false);

    const attributionCall = query.mock.calls[1];
    expect(attributionCall[0]).toMatch(/INSERT INTO worker_attribution/);
    expect(attributionCall[1]).toEqual([WORKER_ID, null, 'unknown', JOB_ID, null, NOW.toISOString()]);
  });

  it('writes first_* only once: a second call with a different referrer only moves latest_*, never first_*', async () => {
    const { query, client } = makeClient();

    // First claim.
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: SHARE_CODE, referrer_worker_id: REFERRER_ID }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'whatsapp' }] })
      .mockResolvedValueOnce({ rows: [] });
    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    // Second claim for the SAME worker, different referrer/job/share code.
    const secondJobId = 'dddddddd-0000-0000-0000-000000000002';
    const secondShareCode = 'OTHRSHR2';
    const secondReferrer = 'eeeeeeee-0000-0000-0000-000000000002';
    const later = new Date(NOW.getTime() + 1000);
    query
      .mockResolvedValueOnce({ rows: [{ job_id: secondJobId, share_code: secondShareCode, referrer_worker_id: secondReferrer }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'facebook' }] })
      .mockResolvedValueOnce({ rows: [] });
    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, later);

    const secondAttributionCall = query.mock.calls[5];
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
    expect(secondAttributionCall[1]).toEqual([WORKER_ID, secondShareCode, 'facebook', secondJobId, secondReferrer, later.toISOString()]);
  });

  it('never logs a phone or phone_hash (query params carry it, but no console call is made)', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rows: [{ job_id: JOB_ID, share_code: null, referrer_worker_id: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await claimPendingReferral(client, PHONE_HASH, WORKER_ID, NOW);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
