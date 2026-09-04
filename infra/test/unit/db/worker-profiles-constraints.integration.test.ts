/**
 * Real-PostgreSQL enforcement suite for the two multi-column CHECK
 * constraints that the 2026-07-26 incident proved unit mocks cannot cover:
 *
 *   - worker_profiles_location_complete (009_location_foundation.sql):
 *     latitude/longitude/location_source/location_confidence/
 *     location_updated_at are all-NULL or all-set.
 *   - chk_trade_other (004_whatsapp.sql): main_trade='other' requires
 *     main_trade_other non-NULL.
 *
 * The REAL adapters (createProfilePersistenceAdapter) run against the real
 * schema here — the exact writes that silently wedged every production
 * worker when they were only ever tested against always-agreeing fakes.
 *
 * Gated on JALE_TEST_DATABASE_URL like the 042/049 suites; runs via
 * `npm run test:whatsapp-v2-db` (scripts/run-whatsapp-v2-db-tests.sh, which
 * fails closed when the URL is unset).
 */
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import { createProfilePersistenceAdapter } from '../../../lambda/whatsapp/lib/onboarding-adapters';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: worker_profiles constraint PostgreSQL gate was not run', () => {
    console.warn('[worker-profiles-constraints] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a disposable PostgreSQL 16 database.');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('worker_profiles / users CHECK constraints vs the real adapters', () => {
  const workerId = randomUUID();
  const cognitoSub = `wa-constraints-${workerId}`;
  let setup: Client;
  const profile = createProfilePersistenceAdapter();

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`,
      [workerId, cognitoSub],
    );
  });

  afterAll(async () => {
    await setup.query('DELETE FROM worker_skills WHERE worker_id = $1', [workerId]);
    await setup.query('DELETE FROM worker_profiles WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM users WHERE id = $1', [workerId]);
    await setup.end();
  });

  test('the constraints this suite exists for are still present', async () => {
    const constraints = await setup.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('worker_profiles_location_complete', 'chk_trade_other')`,
    );
    expect(constraints.rows.map((r) => r.conname).sort()).toEqual([
      'chk_trade_other',
      'worker_profiles_location_complete',
    ]);
  });

  test('saveLocation (ZIP) commits cleanly against the real location CHECK', async () => {
    // The incident write: before the fix this violated
    // worker_profiles_location_complete on every worker's first ZIP.
    await setup.query('BEGIN');
    try {
      await profile.saveLocation(setup as unknown as PoolClient, workerId, {
        city: null,
        state: null,
        postalCode: '79928',
        source: 'zip',
      });
      await setup.query('COMMIT');
    } catch (err) {
      await setup.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    const row = await setup.query(
      `SELECT location, location_source, location_confidence,
              latitude, longitude, location_updated_at
         FROM worker_profiles WHERE user_id = $1`,
      [workerId],
    );
    expect(row.rows[0]).toEqual({
      location: '79928',
      location_source: null,
      location_confidence: null,
      latitude: null,
      longitude: null,
      location_updated_at: null,
    });
  });

  test('saveLocation (City, ST) also commits cleanly', async () => {
    await setup.query('BEGIN');
    try {
      await profile.saveLocation(setup as unknown as PoolClient, workerId, {
        city: 'El Paso',
        state: 'TX',
        postalCode: null,
        source: 'city_state',
      });
      await setup.query('COMMIT');
    } catch (err) {
      await setup.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    const row = await setup.query(
      `SELECT location FROM worker_profiles WHERE user_id = $1`,
      [workerId],
    );
    expect(row.rows[0]).toEqual({ location: 'El Paso, TX' });
  });

  test('the database still rejects the incident-shaped partial location write (suite honesty check)', async () => {
    // If this ever starts passing, the CHECK was dropped and the whole
    // suite is testing nothing — fail loudly instead.
    await setup.query('BEGIN');
    await expect(
      setup.query(
        `UPDATE worker_profiles
            SET location_source = 'geocoded_zip', location_updated_at = now()
          WHERE user_id = $1`,
        [workerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'worker_profiles_location_complete' });
    await setup.query('ROLLBACK');
  });

  test('saveCustomTrade writes main_trade=other + main_trade_other atomically past chk_trade_other', async () => {
    await setup.query('BEGIN');
    try {
      await profile.saveCustomTrade(setup as unknown as PoolClient, workerId, 'soldador');
      await setup.query('COMMIT');
    } catch (err) {
      await setup.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    const row = await setup.query(
      `SELECT main_trade, main_trade_other FROM users WHERE id = $1`,
      [workerId],
    );
    // Sprint 24 (D4): 'soldador' resolves the seeded welder alias row and is
    // stored as the Spanish canonical label; the CHECK still sees both columns
    // written atomically.
    expect(row.rows[0]).toEqual({ main_trade: 'other', main_trade_other: 'Soldador' });
  });

  test('the database still rejects main_trade=other without main_trade_other (suite honesty check)', async () => {
    await setup.query('BEGIN');
    await expect(
      setup.query(
        `UPDATE users SET main_trade = 'other', main_trade_other = NULL WHERE id = $1`,
        [workerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'chk_trade_other' });
    await setup.query('ROLLBACK');
  });
});

/**
 * The whole remaining v2 profile flow, adapter by adapter, in flow order,
 * executed AS `jale_whatsapp` — the role the processor Lambda actually runs
 * under. This is the "test tomorrow's SQL today" suite: every write the
 * steps AFTER profile.location will make gets exercised against the real
 * constraints, real column-scoped grants (049), and real RLS policies
 * before a live worker ever reaches them. A missing grant, an RLS policy
 * gap, or another partial-write constraint bug in ANY later step fails
 * here, not in production.
 */
maybeDescribe('full v2 profile flow SQL as jale_whatsapp (the Lambda role)', () => {
  const flowWorkerId = randomUUID();
  const flowCognitoSub = `wa-flow-${flowWorkerId}`;
  let setup: Client;
  const profile = createProfilePersistenceAdapter();

  /** Runs `fn` inside one committed transaction as jale_whatsapp — the
   * processor's exact execution shape (SET LOCAL ROLE inside BEGIN). */
  async function asWhatsapp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await client.query(
        `SELECT set_config('app.current_internal_user_id', $1, true)`,
        [flowWorkerId],
      );
      const result = await fn(client as unknown as PoolClient);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number) VALUES ($1, $2, 'worker', $3)`,
      [flowWorkerId, flowCognitoSub, '+15559990001'],
    );
  });

  afterAll(async () => {
    await setup.query('DELETE FROM worker_trust_assessments WHERE user_id = $1', [flowWorkerId]);
    await setup.query('DELETE FROM worker_skills WHERE worker_id = $1', [flowWorkerId]);
    await setup.query('DELETE FROM worker_profiles WHERE user_id = $1', [flowWorkerId]);
    await setup.query('DELETE FROM users WHERE id = $1', [flowWorkerId]);
    await setup.end();
  });

  test('profile.name -> saveName', async () => {
    await asWhatsapp((c) => profile.saveName(c, flowWorkerId, 'Luis Gomez'));
  });

  test('profile.location -> saveLocation', async () => {
    await asWhatsapp((c) => profile.saveLocation(c, flowWorkerId, {
      city: null, state: null, postalCode: '79928', source: 'zip',
    }));
  });

  test('profile.trade -> saveTrade (standard trade)', async () => {
    await asWhatsapp((c) => profile.saveTrade(c, flowWorkerId, 'electrician'));
  });

  test('profile.experience -> saveExperience', async () => {
    await asWhatsapp((c) => profile.saveExperience(c, flowWorkerId, '2-4'));
  });

  test('profile.transportation -> saveTransportation', async () => {
    await asWhatsapp((c) => profile.saveTransportation(c, flowWorkerId, true));
  });

  test('profile.availability -> saveAvailability', async () => {
    await asWhatsapp((c) => profile.saveAvailability(c, flowWorkerId, 'full_time'));
  });

  test('trust.question.1-3 -> saveTrustAnswer x3', async () => {
    for (let i = 0; i < 3; i += 1) {
      await asWhatsapp((c) => profile.saveTrustAnswer(c, {
        workerId: flowWorkerId,
        professionKey: 'electrician',
        questionIndex: i,
        qEn: `Standard question ${i + 1}?`,
        qEs: `Pregunta estandar ${i + 1}?`,
        answerText: `answer ${i + 1}`,
        answerSource: 'text',
        provenance: { rubricVersion: 'v1' },
      }));
    }
  });

  test('trust handoff -> syncProfileForTrustHandoff reports ready with no missing fields', async () => {
    const result = await asWhatsapp((c) => profile.syncProfileForTrustHandoff(c, flowWorkerId));
    expect(result).toEqual({ ready: true, missing: [] });
  });

  test('end state satisfies every constraint the flow touches', async () => {
    const user = await setup.query(
      `SELECT full_name, city, main_trade, years_experience, has_transportation, availability
         FROM users WHERE id = $1`,
      [flowWorkerId],
    );
    expect(user.rows[0]).toEqual({
      full_name: 'Luis Gomez',
      city: '79928',
      main_trade: 'electrician',
      years_experience: '2-4',
      has_transportation: true,
      availability: 'full_time',
    });

    const prof = await setup.query(
      `SELECT location, location_source FROM worker_profiles WHERE user_id = $1`,
      [flowWorkerId],
    );
    expect(prof.rows[0]).toEqual({ location: '79928', location_source: null });

    const skills = await setup.query(
      `SELECT count(*)::int AS count FROM worker_skills WHERE worker_id = $1`,
      [flowWorkerId],
    );
    expect((skills.rows[0] as { count: number }).count).toBeGreaterThan(0);
  });
});
