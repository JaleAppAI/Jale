import type { PoolClient } from 'pg';
import { upsertWorkerProfileFromUsers } from '../../../../lambda/whatsapp/lib/profile-flow';

describe('upsertWorkerProfileFromUsers', () => {
  const mockQuery = jest.fn();
  const client = { query: mockQuery } as unknown as PoolClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('upserts worker_profiles then seeds worker_skills, both scoped to the user', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [profileSql, profileParams] = mockQuery.mock.calls[0];
    expect(profileSql).toContain('INSERT INTO worker_profiles');
    expect(profileSql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(profileParams).toEqual(['user-1']);

    const [skillSql, skillParams] = mockQuery.mock.calls[1];
    expect(skillSql).toContain('INSERT INTO worker_skills');
    expect(skillParams).toEqual(['user-1']);
  });

  it('seeds the skill from main_trade_other when set, falling back to main_trade', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    const [skillSql] = mockQuery.mock.calls[1];
    // main_trade_other (trimmed, non-empty) wins over main_trade
    expect(skillSql).toContain("COALESCE(NULLIF(btrim(main_trade_other), ''), main_trade)");
  });

  it('never seeds the literal trade "other" as a skill', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    const [skillSql] = mockQuery.mock.calls[1];
    expect(skillSql).toContain("<> 'other'");
  });

  it('is idempotent and never clobbers web-added skills (ON CONFLICT DO NOTHING)', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    const [skillSql] = mockQuery.mock.calls[1];
    expect(skillSql).toContain('ON CONFLICT DO NOTHING');
    expect(skillSql).not.toContain('DO UPDATE');
  });

  it('normalizes the seeded skill: lowercased and capped at the 100-char column CHECK', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    const [skillSql] = mockQuery.mock.calls[1];
    expect(skillSql).toMatch(/lower\(left\(btrim\(.*\), 100\)\)/);
  });

  it('only seeds skills for worker rows', async () => {
    await upsertWorkerProfileFromUsers(client, 'user-1');

    const [skillSql] = mockQuery.mock.calls[1];
    expect(skillSql).toContain("user_type = 'worker'");
  });
});
