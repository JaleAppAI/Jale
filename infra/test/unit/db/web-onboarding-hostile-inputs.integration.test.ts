/**
 * web-onboarding-hostile-inputs.integration.test.ts
 *
 * ADVERSARIAL gate for the Sprint 22 R2 web onboarding door
 * (`lambda/whatsapp/web/worker-onboarding.ts` + `onboarding-driver.ts`) and
 * the WhatsApp v2 engine behind it, driven through the REAL Lambda handler
 * against REAL PostgreSQL 16 with migrations 001-087 applied.
 *
 * `web-onboarding-door.integration.test.ts` proves the door works for a
 * worker who behaves. This file proves what it does for one who does not:
 * SQL in every free-text field, NUL bytes and unpaired surrogates, length
 * boundaries counted three different ways, a type-confused JSON envelope, a
 * stale or duplicated optimistic lock, two simultaneous posts, an employer's
 * Cognito sub, and a completed run poked from the other door.
 *
 * THE CONTRACT THIS FILE PINS. Every hostile input must produce EITHER a
 * clean 4xx with a stable `error` code from the door's own vocabulary
 * (`invalid_request` / `worker_not_found` / `not_found` / `lock_conflict` /
 * `suspended` / `step_rejected` / `step_mismatch` / `unknown_step`) OR, where
 * it is accepted, a byte-exact row and an unchanged schema. A 500 is a
 * finding, not a behaviour. The first pass found six; all six are FIXED, and
 * each is asserted here as ordinary, currently-passing expectations — the
 * correct 4xx AND a blast-radius check that the transaction left nothing
 * behind. (An earlier revision recorded the open bugs with `test.failing`;
 * nothing remains failing now.)
 *
 * WHY BLAST-RADIUS TESTS ARE SEPARATE. Each fix is asserted twice: the reason
 * code on the rejection, and — in an independent, ordinary test — that the row
 * and schema are untouched, so neither half can mask a regression in the
 * other.
 *
 * CONNECTION. `JALE_TEST_DATABASE_URL` must be a SUPERUSER url for a
 * disposable database. The HANDLER connects on its own as `jale_whatsapp`
 * (`getDbPool` is mocked to hand it a pool authenticated with that role), so
 * the grants and policies under test are the real ones. The employer-side
 * reads run under `SET LOCAL ROLE jale_admin`, which is what subjects the
 * superuser session to RLS -- a bare superuser SELECT bypasses every policy
 * and would report a leak that does not exist.
 *
 * CLEANUP IS MANDATORY. This suite completes runs, which leave PENDING
 * `worker_domain_outbox` rows; left behind they change what
 * `lease_worker_domain_events` returns and break
 * `whatsapp-onboarding-concurrency.integration.test.ts` scenarios 4 and 5.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { TRUST_EXTRACTION_SQL } from '../../../lambda/api/employer-worker-profile';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

// The handler builds its own pool via `getDbPool()`. Mocking exactly that one
// export is what lets the REAL handler run against the REAL role.
let rolePool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => rolePool };
});

// SQS is the one AWS call the handler makes, post-commit, on completion.
const wakeCalls: unknown[] = [];
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { async send(command: unknown) { wakeCalls.push(command); return {}; } },
  SendMessageCommand: class { constructor(public readonly input: unknown) {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/whatsapp/web/worker-onboarding');

if (!databaseUrl) {
  test('CONCERN: the web-onboarding hostile-input suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[web-onboarding-hostile-inputs] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-087 applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

const maybeDescribe = databaseUrl ? describe : describe.skip;

interface Response { statusCode: number; body: Record<string, any> }

// ── The hostile alphabet ──────────────────────────────────────────────────
// Named constants rather than inline literals: several of them are invisible
// in an editor, and a test that reads `NUL` cannot be silently "cleaned up"
// by a formatter the way a literal 0x00 can.
const NUL = '\u0000';
/** An unpaired high surrogate. `JSON.parse` accepts it, `JSON.stringify`
 *  re-emits it as a `\ud800` escape, and PostgreSQL's jsonb parser rejects
 *  that escape -- which is the whole of BUG 2b/2c below. */
const LONE_SURROGATE = '\uD800';
const RTL_OVERRIDE = '\u202E';
const ZWJ = '\u200D';
const COMBINING_ACUTE = '\u0301';
/** Cyrillic es, indistinguishable from Latin c in most fonts. */
const HOMOGLYPH_CARPENTER = 'сarpenter';

/** Three answers long enough to clear the 15-character floor. */
const VALUE_ANSWERS = [
  'I frame houses and hang interior doors on remodels in Socorro.',
  'I walk the space first and check the plans against what is framed.',
  'A door jamb came in warped once; I re-ordered it and shimmed it square.',
];

const SQL_INJECTIONS: Array<[string, string]> = [
  ['tautology', "' OR 1=1 --"],
  ['drop-table', "'); DROP TABLE users; --"],
  ['dollar-quoted pg_sleep', '$$; SELECT pg_sleep(5); $$'],
  ['copy-to-file', "\\'; COPY users TO '/tmp/x'; --"],
  ['format placeholders', 'A $1 %s {{ x }} ${y} value'],
];

maybeDescribe('R2: the web onboarding door under hostile input', () => {
  const su = new Client({ connectionString: databaseUrl });

  const ids: Record<string, string> = {};
  const subs: Record<string, string> = {};
  const phones: Record<string, string> = {};
  const tag = randomUUID().slice(0, 8);

  /** The exact shape API Gateway's Cognito authorizer hands the Lambda: ONE
   *  `{action}` resource, so `resource` is the TEMPLATE and the segment
   *  arrives in `pathParameters` (ApiStack has no room for named siblings). */
  function event(
    sub: string,
    opts: { method?: string; resource?: string; body?: unknown; rawBody?: string } = {},
  ): APIGatewayProxyEvent {
    const requestPath = opts.resource ?? '/worker/onboarding';
    const action = requestPath.replace(/^\/worker\/onboarding\/?/, '');
    return {
      httpMethod: opts.method ?? 'GET',
      resource: action ? '/worker/onboarding/{action}' : '/worker/onboarding',
      path: requestPath,
      pathParameters: action ? { action } : null,
      body: opts.rawBody !== undefined
        ? opts.rawBody
        : (opts.body === undefined ? null : JSON.stringify(opts.body)),
      requestContext: { authorizer: { claims: { sub } } },
    } as unknown as APIGatewayProxyEvent;
  }

  async function call(sub: string, opts: Parameters<typeof event>[1] = {}): Promise<Response> {
    const result: APIGatewayProxyResult = await handler(event(sub, opts));
    return { statusCode: result.statusCode, body: JSON.parse(result.body) };
  }

  /** A fresh worker, minted as the superuser exactly as signup does. */
  async function mkWorker(key: string): Promise<string> {
    // A reused key is a 23505 on `users_cognito_sub_key` reported at the
    // INSERT, which reads like a schema problem rather than what it is: two
    // tests asking for the same fixture name. Fail with the name instead.
    if (ids[key]) throw new Error(`fixture key reused: ${key}`);
    subs[key] = `r2hostile-${key}-${tag}`;
    phones[key] = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const inserted = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, phone, email)
       VALUES ($1, 'worker', $2, $3) RETURNING id`,
      [subs[key], phones[key], `r2hostile-${key}-${tag}@example.com`],
    );
    ids[key] = inserted.rows[0].id;
    return key;
  }

  const get = (key: string) => call(subs[key]);
  const envelope = (key: string, body: unknown, action = 'answers', method = 'POST') =>
    call(subs[key], { method, resource: `/worker/onboarding/${action}`, body });
  const answers = (key: string, lockVersion: number, items: Array<{ stepKey: string; value: unknown }>) =>
    envelope(key, { lockVersion, answers: items });
  const back = (key: string, lockVersion: number) => envelope(key, { lockVersion }, 'back');
  const language = (key: string, body: unknown) => envelope(key, body, 'language', 'PATCH');

  /**
   * Post ONE value at whatever lock version the run is actually on.
   *
   * Re-reading is not a convenience: `healPreAuthStep` runs on every request
   * and can bump `lock_version`, and a rejected item leaves it where it was,
   * so a cached version turns every later hostile case in a list into an
   * indistinguishable 409 instead of the answer being probed.
   */
  async function hostile(key: string, stepKey: string, value: unknown): Promise<Response> {
    const state = (await get(key)).body;
    return answers(key, state.run.lockVersion, [{ stepKey, value }]);
  }

  /** Drives a fresh worker to `step`, using values the engine accepts. */
  async function driveTo(key: string, step: string): Promise<Record<string, any>> {
    let s = (await get(key)).body;
    if (step === 'legal.review') return s;
    s = (await answers(key, s.run.lockVersion, [{ stepKey: 'legal.review', value: 'accept' }])).body;
    if (step === 'profile.name') return s;
    s = (await answers(key, s.run.lockVersion, [{ stepKey: 'profile.name', value: 'Ana Torres' }])).body;
    if (step === 'profile.location') return s;
    s = (await answers(key, s.run.lockVersion, [
      { stepKey: 'profile.location', value: { kind: 'city_state', city: 'El Paso', state: 'TX' } },
    ])).body;
    if (step === 'profile.trade') return s;
    if (step === 'profile.custom_trade') {
      return (await answers(key, s.run.lockVersion, [{ stepKey: 'profile.trade', value: 'other' }])).body;
    }
    s = (await answers(key, s.run.lockVersion, [{ stepKey: 'profile.trade', value: 'carpenter' }])).body;
    if (step === 'profile.experience') return s;
    s = (await answers(key, s.run.lockVersion, [
      { stepKey: 'profile.experience', value: '2-4' },
      { stepKey: 'profile.transportation', value: true },
      { stepKey: 'profile.availability', value: 'full_time' },
    ])).body;
    return s; // trust.question.1
  }

  /** The run row as the database holds it, for the after-shot of a hostile call. */
  async function runRow(key: string): Promise<{ n: number; lock_version: number; current_step_key: string; status: string }> {
    const r = await su.query(
      `SELECT count(*)::int n, max(lock_version) lock_version,
              max(current_step_key) current_step_key, max(status) status
         FROM worker_workflow_runs WHERE user_id = $1`,
      [ids[key]],
    );
    return r.rows[0];
  }

  /** Table-wide row counts, for "the hostile string changed no table". */
  async function tableCounts(): Promise<Record<string, number>> {
    const r = await su.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM users)::int users,
              (SELECT count(*) FROM worker_workflow_runs)::int runs,
              (SELECT count(*) FROM worker_trust_assessments)::int assessments,
              (SELECT count(*) FROM worker_onboarding_state)::int onboarding_state`,
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    rolePool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 6,
    });
    process.env.REQUIRED_TOS_VERSION = '1.0';
    process.env.DOMAIN_OUTBOX_WAKE_QUEUE_URL = 'https://sqs.test.invalid/queue/domain-wake';
  }, 60_000);

  afterAll(async () => {
    await rolePool?.end();
    const fixtureIds = Object.values(ids);
    if (fixtureIds.length > 0) {
      await su.query(`DELETE FROM whatsapp_conversations WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      // `worker_domain_outbox.aggregate_id` is a bare UUID with NO foreign key
      // (042:114), so deleting the users does NOT take these rows with it.
      await su.query(`DELETE FROM worker_domain_outbox WHERE aggregate_id = ANY($1::uuid[])`, [fixtureIds]);
      // legal_consent_log's FK is plain RESTRICT; everything else cascades.
      await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [fixtureIds]);
    }
    await su.end();
  });

  // =======================================================================
  // 1. SQL injection — parameterised all the way down
  // =======================================================================

  describe('1. injection strings are DATA, byte for byte', () => {
    test.each(SQL_INJECTIONS)(
      'profile.name accepts %s verbatim and changes no table',
      async (label, payload) => {
        const key = await mkWorker(`inj-name-${label.replace(/\W+/g, '')}`);
        await driveTo(key, 'profile.name');
        const before = await tableCounts();
        const started = Date.now();
        const response = await hostile(key, 'profile.name', payload);
        const elapsed = Date.now() - started;
        const after = await tableCounts();

        expect(response.statusCode).toBe(200);
        expect(response.body.run.stepKey).toBe('profile.location');
        // `pg_sleep(5)` inside a $$-quoted string must cost nothing: a
        // parameter is never parsed as SQL. Ten seconds is a ceiling that
        // cannot be tripped by a slow machine, only by execution.
        expect(elapsed).toBeLessThan(10_000);
        // Byte-exact, compared in SQL as well as in JS: an equal JS string
        // proves the round trip, `octet_length` proves no re-encoding.
        const row = await su.query<{ full_name: string; ol: number }>(
          `SELECT full_name, octet_length(full_name) ol FROM users WHERE id = $1`, [ids[key]],
        );
        expect(row.rows[0].full_name).toBe(payload);
        expect(row.rows[0].ol).toBe(Buffer.byteLength(payload, 'utf8'));
        // Nothing was created or destroyed by the payload itself.
        expect(after).toEqual(before);
      },
      60_000,
    );

    test('all three trust answers store injection payloads verbatim, one row, one index each', async () => {
      const key = await mkWorker('inj-trust');
      await driveTo(key, 'trust.question.1');
      const payloads = [
        `${SQL_INJECTIONS[0][1]} and then I re-hung the door square`,
        `${SQL_INJECTIONS[2][1]} then I shimmed the jamb`,
        `${SQL_INJECTIONS[4][1]} about framing interior walls`,
      ];
      const before = await tableCounts();
      for (let i = 0; i < payloads.length; i += 1) {
        const response = await hostile(key, `trust.question.${i + 1}`, { text: payloads[i] });
        expect(response.statusCode).toBe(200);
      }
      const after = await tableCounts();
      // Exactly one assessment row was created by three answers.
      expect(after.assessments - before.assessments).toBe(1);
      expect(after.users).toBe(before.users);

      const stored = await su.query<{ answers: Array<Record<string, unknown>> }>(
        `SELECT answers FROM worker_trust_assessments WHERE user_id = $1`, [ids[key]],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].answers.map((a) => a.answer_text)).toEqual(payloads);
      // No duplicate question_index — the merge in `saveTrustAnswer` is
      // filter-then-append, and a duplicate would be scored twice.
      expect(stored.rows[0].answers.map((a) => a.question_index)).toEqual([0, 1, 2]);
    }, 120_000);

    test('profile.custom_trade accepts a SQL payload verbatim and slugs it into the profession key', async () => {
      // The custom trade is the injection target with the LONGEST reach: it
      // becomes `users.main_trade_other`, the `profession_key` in
      // `worker_workflow_runs.context`, the `trade_questions` cache key, and
      // the profession string the question generator is prompted with. All
      // four have to treat it as data.
      const key = await mkWorker('inj-trade');
      await driveTo(key, 'profile.custom_trade');
      const payload = SQL_INJECTIONS[0][1]; // ' OR 1=1 --  (11 chars, no control bytes)
      const before = await tableCounts();
      const response = await hostile(key, 'profile.custom_trade', payload);
      const after = await tableCounts();

      expect(response.statusCode).toBe(200);
      expect(response.body.run.stepKey).toBe('profile.experience');
      expect(after).toEqual(before);

      const stored = await su.query<{ main_trade: string; main_trade_other: string }>(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids[key]],
      );
      expect(stored.rows[0].main_trade).toBe('other');
      expect(stored.rows[0].main_trade_other).toBe(payload);

      const context = await su.query<{ trade: string }>(
        `SELECT context->>'v2ProfileTrade' trade FROM worker_workflow_runs WHERE user_id = $1`, [ids[key]],
      );
      // `normalizeTrade` slugged it; whatever it produced is a plain string
      // that was carried, not executed.
      expect(typeof context.rows[0].trade).toBe('string');
      const cached = await su.query(
        `SELECT count(*)::int n FROM trade_questions WHERE profession_key = $1`, [context.rows[0].trade],
      );
      expect(cached.rows[0].n).toBeLessThanOrEqual(1);
      // And the door renders it straight back without a second thought.
      expect((await get(key)).body.profile.trade).toEqual({ key: 'other', other: payload });
    }, 120_000);

    test('SQL in a location city or ZIP is refused by the charset, never reaching users.city', async () => {
      const key = await mkWorker('inj-location');
      await driveTo(key, 'profile.location');
      const before = await tableCounts();
      const cases: Array<[Record<string, unknown>, string]> = [
        // city_state: refused by the resolver's charset (CITY_PART_RE).
        [{ kind: 'city_state', city: "' OR 1=1 --", state: 'TX' }, 'rejected'],
        [{ kind: 'city_state', city: "El Paso'); DROP TABLE users; --", state: 'TX' }, 'rejected'],
        [{ kind: 'city_state', city: 'El Paso', state: "TX' OR 1=1 --" }, 'rejected'],
        // zip: refused by the five-digit guard before the resolver sees it.
        [{ kind: 'zip', zip: "79901'--" }, 'invalid_value'],
      ];
      for (const [value, reason] of cases) {
        const response = await hostile(key, 'profile.location', value);
        expect(response.statusCode).toBe(422);
        expect(response.body).toMatchObject({ error: 'step_rejected', reason });
      }
      expect(await tableCounts()).toEqual(before);
      const stored = await su.query(`SELECT city FROM users WHERE id = $1`, [ids[key]]);
      expect(stored.rows[0].city).toBeNull();
    }, 180_000);

    test('a SQL payload in the Cognito sub itself is a 404, never a query', async () => {
      const response = await call("' OR 1=1 --");
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: 'worker_not_found' });
    }, 30_000);
  });

  // =======================================================================
  // 2. Encoding attacks
  //
  // FOUR BUGS LIVE HERE. Every one is a text-shaped value that passes the
  // door's own validation and only fails when PostgreSQL is asked to store
  // it: 0x00 is not representable in a `text` column, and neither 0x00 nor an
  // unpaired surrogate survives `JSON.stringify` -> `$n::jsonb`. The door's
  // only free-text guard, `CONTROL_CHARS` (onboarding-driver.ts:101), is
  // applied to `profile.custom_trade` and to nothing else, and does not cover
  // surrogates at all.
  //
  // THE FIX ALL FOUR SHARE, and why it is NOT "reuse CONTROL_CHARS". That
  // regex matches `\r` and `\n`, so applying it to `profile.name` would also
  // refuse `Ana\r\nX-Injected: 1` — which this file pins as ACCEPTED and
  // byte-exact three tests below, and which is a deliberate reading of the
  // door as a state machine rather than an output encoder. Widening the
  // guard to all control characters is a product decision, not a bug fix.
  // The minimal fix is a guard over exactly what PostgreSQL cannot store:
  //
  //   const UNSTORABLE_TEXT =
  //     /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  //
  // applied in `mapAnswerToEngineMessage` to `profile.name` and
  // `trust.question.*`, and ADDED ALONGSIDE `CONTROL_CHARS` in
  // `profile.custom_trade` — returning `{ ok: false, reason: 'invalid' }`,
  // which the door already renders as 422 `step_rejected`.
  // =======================================================================

  describe('2. encoding attacks', () => {
    // BUG 1 (high): a NUL byte in `profile.name` reaches
    // `UPDATE users SET full_name = $2` (onboarding-adapters.ts:524) and
    // PostgreSQL raises 22021 `invalid byte sequence for encoding "UTF8":
    // 0x00`. The door answers 500 `internal_error`.
    // MINIMAL FIX: the shared `UNSTORABLE_TEXT` guard described above, in the
    // `profile.name` branch of `mapAnswerToEngineMessage`
    // (onboarding-driver.ts), returning `{ ok: false, reason: 'invalid_value' }`
    // -> 422 `step_rejected`.
    test('BUG 1: a NUL byte in profile.name should be a 4xx, not a 500', async () => {
      const key = await mkWorker('nul-name');
      await driveTo(key, 'profile.name');
      const response = await hostile(key, 'profile.name', `Ana${NUL}Torres`);
      expect(response.statusCode).toBe(422);
      expect(response.body.error).toBe('step_rejected');
    }, 60_000);

    test('BUG 1 blast radius: the NUL request leaks nothing and leaves the run untouched', async () => {
      const key = await mkWorker('nul-name-state');
      await driveTo(key, 'profile.name');
      const beforeRun = await runRow(key);
      const beforeCounts = await tableCounts();
      const response = await hostile(key, 'profile.name', `Ana${NUL}Torres`);
      // Refused at the door (UNSTORABLE_TEXT); before the fix this was a 500
      // whose only merit was a stable body with no PostgreSQL text in it.
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
      expect(JSON.stringify(response.body)).not.toMatch(/UTF8|0x00|invalid byte/i);
      expect(await runRow(key)).toEqual(beforeRun);
      expect(await tableCounts()).toEqual(beforeCounts);
      const stored = await su.query(`SELECT full_name FROM users WHERE id = $1`, [ids[key]]);
      expect(stored.rows[0].full_name).toBeNull();
    }, 60_000);

    // BUG 2 (high): a NUL byte in a trust answer is serialised by
    // `JSON.stringify` into a `\u0000` escape and handed to `$4::jsonb`
    // (onboarding-adapters.ts:711-722); PostgreSQL raises 22P05 `unsupported
    // Unicode escape sequence`. 500 `internal_error`.
    // MINIMAL FIX: same guard, in the `trust.question.*` branch
    // (onboarding-driver.ts:407-419), before the length checks.
    test('BUG 2: a NUL byte in a trust answer should be a 4xx, not a 500', async () => {
      const key = await mkWorker('nul-trust');
      await driveTo(key, 'trust.question.1');
      const response = await hostile(key, 'trust.question.1', { text: `I hang doors${NUL} and frame walls` });
      expect(response.statusCode).toBe(422);
      expect(response.body.error).toBe('step_rejected');
    }, 120_000);

    // BUG 3 (high): an UNPAIRED SURROGATE in a trust answer takes the same
    // jsonb path and raises 22P02 `invalid input syntax for type json`.
    // Distinct from BUG 2 because `CONTROL_CHARS` would not catch it even if
    // it were applied here: U+D800 is not a control character.
    // MINIMAL FIX: the same `UNSTORABLE_TEXT` guard — which is why its
    // surrogate half is not optional.
    test('BUG 3: an unpaired surrogate in a trust answer should be a 4xx, not a 500', async () => {
      const key = await mkWorker('surrogate-trust');
      await driveTo(key, 'trust.question.1');
      const response = await hostile(key, 'trust.question.1', {
        text: `I hang doors${LONE_SURROGATE} and frame walls on remodels`,
      });
      expect(response.statusCode).toBe(422);
      expect(response.body.error).toBe('step_rejected');
    }, 120_000);

    test('BUG 2/3 blast radius: neither NUL nor a lone surrogate writes a partial assessment', async () => {
      const key = await mkWorker('trust-encoding-state');
      await driveTo(key, 'trust.question.1');
      const beforeRun = await runRow(key);
      for (const text of [
        `I hang doors${NUL} and frame walls`,
        `I hang doors${LONE_SURROGATE} and frame walls on remodels`,
      ]) {
        const response = await hostile(key, 'trust.question.1', { text });
        expect(response.statusCode).toBe(422);
        expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
      }
      expect(await runRow(key)).toEqual(beforeRun);
      const assessments = await su.query(
        `SELECT count(*)::int n FROM worker_trust_assessments WHERE user_id = $1`, [ids[key]],
      );
      expect(assessments.rows[0].n).toBe(0);
    }, 120_000);

    // BUG 4 (high): `profile.custom_trade` DOES run `CONTROL_CHARS`, so the
    // NUL case is correctly refused — but an unpaired surrogate passes it and
    // then reaches `worker_workflow_runs.context` as `v2ProfileTrade`
    // through `persistDurableStateContext`'s jsonb write. 500 again, and
    // this one is the strongest evidence that the guard needs to be about
    // "text PostgreSQL can store", not about control characters.
    test('BUG 4: an unpaired surrogate in profile.custom_trade should be a 4xx, not a 500', async () => {
      const key = await mkWorker('surrogate-trade');
      await driveTo(key, 'profile.custom_trade');
      const response = await hostile(key, 'profile.custom_trade', `we${LONE_SURROGATE}lder`);
      expect(response.statusCode).toBe(422);
      expect(response.body.error).toBe('step_rejected');
    }, 120_000);

    test('profile.custom_trade refuses control characters and unpaired surrogates', async () => {
      // The FIRST loop is the guard that exists working. The surrogate case
      // after it is BUG 4's blast radius, and it lives here rather than in
      // the `.failing` test above for the reason the file header gives: a
      // `.failing` wrapper swallows a setup error as readily as the defect,
      // so the evidence that nothing was written has to be an ordinary,
      // currently-passing assertion.
      const key = await mkWorker('ctrl-trade');
      await driveTo(key, 'profile.custom_trade');
      for (const [label, value] of [
        ['NUL', `we${NUL}lder`],
        ['CRLF', 'weld\r\ner'],
        ['DEL', 'weld\u007Fer'],
      ] as Array<[string, string]>) {
        const response = await hostile(key, 'profile.custom_trade', value);
        expect({ label, status: response.statusCode, error: response.body.error, reason: response.body.reason })
          .toEqual({ label, status: 422, error: 'step_rejected', reason: 'invalid' });
      }

      const beforeRun = await runRow(key);
      const beforeCounts = await tableCounts();
      const surrogate = await hostile(key, 'profile.custom_trade', `we${LONE_SURROGATE}lder`);
      // Refused by UNSTORABLE_TEXT alongside CONTROL_CHARS; before the fix it
      // reached `persistDurableStateContext`'s jsonb write and 500'd.
      expect(surrogate.statusCode).toBe(422);
      expect(surrogate.body).toMatchObject({ error: 'step_rejected', reason: 'invalid' });
      expect(JSON.stringify(surrogate.body)).not.toMatch(/json|surrogate|syntax/i);
      expect(await runRow(key)).toEqual(beforeRun);
      expect(await tableCounts()).toEqual(beforeCounts);

      const stored = await su.query<{ main_trade_other: string | null }>(
        `SELECT main_trade_other FROM users WHERE id = $1`, [ids[key]],
      );
      expect(stored.rows[0].main_trade_other).toBeNull();
      const context = await su.query<{ trade: string | null }>(
        `SELECT context->>'v2ProfileTrade' trade FROM worker_workflow_runs WHERE user_id = $1`, [ids[key]],
      );
      expect(context.rows[0].trade).toBeNull();
    }, 180_000);

    test('a comma or a prototype key in the ZIP field cannot smuggle a city past the cap', async () => {
      // BUG 5b (reviewer): `resolve()` splits on the LAST comma, so an
      // unguarded `zip` value was a second, uncapped city_state channel — an
      // 8000-char incompressible city there raised 54000 (index row too big)
      // as a 500, and a compressible one stored 8000+ bytes and echoed them
      // back. `__proto__`/`constructor` reached `inferCityState`'s object
      // lookup and, via a follow-up confirm, 500'd on `state.trim`.
      // FIX: /^\\d{5}$/ on the zip branch (onboarding-driver.ts).
      const key = await mkWorker('zip-smuggle');
      await driveTo(key, 'profile.location');
      const before = await tableCounts();
      for (const zip of [
        'ab'.repeat(4000) + ', TX',
        'z'.repeat(8000) + ', TX',
        '__proto__',
        'constructor',
        '79901, TX',
        '79901 ',
      ]) {
        const response = await hostile(key, 'profile.location', { kind: 'zip', zip });
        expect(response.statusCode).toBe(422);
        expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
      }
      expect(await tableCounts()).toEqual(before);
      const stored = await su.query(
        `SELECT (SELECT city FROM users WHERE id = $1) c,
                (SELECT count(*)::int FROM worker_preferred_cities WHERE user_id = $1) n,
                (SELECT context->'v2LocationPendingConfirm' FROM worker_workflow_runs WHERE user_id = $1) pending`,
        [ids[key]],
      );
      expect(stored.rows[0]).toEqual({ c: null, n: 0, pending: null });
      const ok = await hostile(key, 'profile.location', { kind: 'zip', zip: '79901' });
      expect(ok.statusCode).toBe(200);
    }, 180_000);

    test('the location resolver rejects NUL and surrogates by charset, so no 500 reaches the DB', async () => {
      // CITY_PART_RE is `/^\p{L}[\p{L} .'-]*$/u` (onboarding-adapters.ts:270).
      // Neither 0x00 nor a lone surrogate is `\p{L}`, so the resolver returns
      // null, the handler reprompts, and the value never reaches `users.city`.
      // This is the door's ONLY free-text field that is accidentally safe.
      const key = await mkWorker('loc-encoding');
      await driveTo(key, 'profile.location');
      for (const value of [
        { kind: 'zip', zip: `79901${NUL}` },
        { kind: 'city_state', city: 'El Paso', state: `TX${NUL}` },
        { kind: 'city_state', city: `El Paso${NUL}`, state: 'TX' },
        { kind: 'city_state', city: `El Pa${LONE_SURROGATE}so`, state: 'TX' },
      ]) {
        const response = await hostile(key, 'profile.location', value);
        expect(response.statusCode).toBe(422);
        expect(response.body.error).toBe('step_rejected');
      }
      const stored = await su.query(`SELECT city FROM users WHERE id = $1`, [ids[key]]);
      expect(stored.rows[0].city).toBeNull();
    }, 120_000);

    test('an unpaired surrogate in profile.name is refused, not silently mutated to U+FFFD', async () => {
      // Before UNSTORABLE_TEXT this was accepted: node-postgres encodes the
      // parameter as UTF-8 and Node replaces an unpaired surrogate with U+FFFD
      // at encode time, so the worker's stored name differed from what they
      // typed. Refusing at the door removes the silent mutation.
      const key = await mkWorker('surrogate-name');
      await driveTo(key, 'profile.name');
      const response = await hostile(key, 'profile.name', `Ana${LONE_SURROGATE}Torres`);
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
      const stored = await su.query<{ full_name: string | null }>(
        `SELECT full_name FROM users WHERE id = $1`, [ids[key]],
      );
      expect(stored.rows[0].full_name).toBeNull();
    }, 60_000);

    test('bidi overrides, ZWJ emoji and CRLF are stored verbatim, not sanitised', async () => {
      // By design: the door is a state machine, not an output encoder, and
      // escaping belongs to whatever renders the value. Pinned so a future
      // "let us strip control characters from names" change is a deliberate
      // decision with a failing test attached, not a silent one.
      const cases: Array<[string, string]> = [
        ['rtl-override', `Ana${RTL_OVERRIDE}Torres`],
        ['zwj-emoji', `\u{1F477}${ZWJ}♀️`],
        ['crlf-header', 'Ana\r\nX-Injected: 1'],
        ['homoglyph', HOMOGLYPH_CARPENTER],
      ];
      for (const [label, payload] of cases) {
        const key = await mkWorker(`raw-${label}`);
        await driveTo(key, 'profile.name');
        const response = await hostile(key, 'profile.name', payload);
        expect({ label, status: response.statusCode }).toEqual({ label, status: 200 });
        const stored = await su.query<{ full_name: string }>(
          `SELECT full_name FROM users WHERE id = $1`, [ids[key]],
        );
        expect(stored.rows[0].full_name).toBe(payload);
      }
    }, 180_000);

    test('a homoglyph custom trade is stored raw and becomes its own profession key', async () => {
      // Not a crash and not a validation failure — but worth pinning: the
      // Cyrillic form normalises to a DIFFERENT `profession_key` than the
      // Latin one, so it mints its own `trade_questions` cache row and its
      // own generated question set. That is a data-quality cost, not a
      // security one.
      const key = await mkWorker('homoglyph-trade');
      await driveTo(key, 'profile.custom_trade');
      const response = await hostile(key, 'profile.custom_trade', HOMOGLYPH_CARPENTER);
      expect(response.statusCode).toBe(200);
      const stored = await su.query<{ main_trade: string; main_trade_other: string }>(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids[key]],
      );
      expect(stored.rows[0].main_trade).toBe('other');
      expect(stored.rows[0].main_trade_other).toBe(HOMOGLYPH_CARPENTER);
      expect(stored.rows[0].main_trade_other).not.toBe('carpenter');
    }, 120_000);
  });

  // =======================================================================
  // 3. Boundaries — and WHICH unit the server counts in
  // =======================================================================

  describe('3. length boundaries', () => {
    test('trust answers: 14 rejected, 15 accepted, 2001 rejected, 2000 accepted', async () => {
      const key = await mkWorker('trust-bounds');
      await driveTo(key, 'trust.question.1');

      const short = await hostile(key, 'trust.question.1', { text: 'a'.repeat(14) });
      expect(short.statusCode).toBe(422);
      expect(short.body.reason).toBe('too_short');

      const atFloor = await hostile(key, 'trust.question.1', { text: 'b'.repeat(15) });
      expect(atFloor.statusCode).toBe(200);
      expect(atFloor.body.run.stepKey).toBe('trust.question.2');

      const long = await hostile(key, 'trust.question.2', { text: 'c'.repeat(2001) });
      expect(long.statusCode).toBe(422);
      expect(long.body.reason).toBe('too_long');

      const atCeiling = await hostile(key, 'trust.question.2', { text: 'd'.repeat(2000) });
      expect(atCeiling.statusCode).toBe(200);
      expect(atCeiling.body.run.stepKey).toBe('trust.question.3');
    }, 180_000);

    test('the cap is counted in UTF-16 CODE UNITS, so a 2000-unit answer can be 8000 bytes', async () => {
      // `String.prototype.length` (onboarding-driver.ts:413-415). Two
      // consequences, both pinned because the cap is documented as a
      // denial-of-service bound and the bound is therefore 4x looser in bytes
      // than it reads: 2000 astral emoji are 4000 units and REFUSED, while
      // 1000 of them are exactly 2000 units and ACCEPTED at 4000 bytes.
      const key = await mkWorker('trust-units');
      await driveTo(key, 'trust.question.1');

      const tooManyEmoji = await hostile(key, 'trust.question.1', { text: '\u{1F600}'.repeat(2000) });
      expect(tooManyEmoji.statusCode).toBe(422);
      expect(tooManyEmoji.body.reason).toBe('too_long');

      const atCap = await hostile(key, 'trust.question.1', { text: '\u{1F600}'.repeat(1000) });
      expect(atCap.statusCode).toBe(200);

      const stored = await su.query<{ units: number; bytes: number }>(
        `SELECT length(answers->0->>'answer_text') units,
                octet_length(answers->0->>'answer_text') bytes
           FROM worker_trust_assessments WHERE user_id = $1`,
        [ids[key]],
      );
      // PostgreSQL counts CODE POINTS, JavaScript counted CODE UNITS.
      expect(stored.rows[0].units).toBe(1000);
      expect(stored.rows[0].bytes).toBe(4000);

      // 2000 combining marks are 2000 units and pass the same way.
      const marks = await hostile(key, 'trust.question.2', { text: 'a' + COMBINING_ACUTE.repeat(1999) });
      expect(marks.statusCode).toBe(200);
    }, 180_000);

    test('whitespace-only and empty free text are refused everywhere', async () => {
      const key = await mkWorker('blank');
      await driveTo(key, 'profile.name');
      for (const value of ['', '   \n\t', ' ']) {
        const response = await hostile(key, 'profile.name', value);
        expect(response.statusCode).toBe(422);
        expect(response.body.error).toBe('step_rejected');
      }
      const trustKey = await mkWorker('blank-trust');
      await driveTo(trustKey, 'trust.question.1');
      const blank = await hostile(trustKey, 'trust.question.1', { text: '   \n\t' });
      expect(blank.statusCode).toBe(422);
      // Trimmed FIRST, so whitespace cannot buy the 15-character floor.
      expect(blank.body.reason).toBe('too_short');
    }, 180_000);

    test('profile.name is capped at 100; 101 reprompts as step_rejected', async () => {
      const key = await mkWorker('name-bounds');
      await driveTo(key, 'profile.name');
      const over = await hostile(key, 'profile.name', 'a'.repeat(101));
      expect(over.statusCode).toBe(422);
      expect(over.body).toMatchObject({ error: 'step_rejected', reason: 'rejected' });
      const at = await hostile(key, 'profile.name', 'a'.repeat(100));
      expect(at.statusCode).toBe(200);
    }, 120_000);

    test('profile.custom_trade is capped at 2..60', async () => {
      const key = await mkWorker('trade-bounds');
      await driveTo(key, 'profile.custom_trade');
      const short = await hostile(key, 'profile.custom_trade', 'a');
      expect(short.body).toMatchObject({ error: 'step_rejected', reason: 'too_short' });
      const long = await hostile(key, 'profile.custom_trade', 'a'.repeat(61));
      expect(long.body).toMatchObject({ error: 'step_rejected', reason: 'too_long' });
      const ok = await hostile(key, 'profile.custom_trade', 'a'.repeat(60));
      expect(ok.statusCode).toBe(200);
    }, 120_000);

    // BUG 5 (medium): `profile.location` is the ONE free-text field with no
    // length cap at all. `CITY_PART_RE` bounds the CHARACTER SET and nothing
    // else, so any run of letters up to the 16 KB body limit is accepted as a
    // city and written to FOUR columns: `users.city`,
    // `worker_preferred_cities.city` and `.city_key`, and
    // `worker_profiles.location`. This is precisely the failure the
    // `CUSTOM_TRADE_MAX_CHARS` comment describes ("a paste of a whole CV
    // becomes a profession") with `city` in place of `trade`.
    // MINIMAL FIX: cap city and state in the `profile.location` branch of
    // `mapAnswerToEngineMessage` (onboarding-driver.ts:343-349), mirroring
    // `CUSTOM_TRADE_MAX_CHARS` — e.g. 80 chars for city, 40 for state,
    // returning `{ ok: false, reason: 'too_long' }`.
    test('BUG 5: an 8000-character city should be refused', async () => {
      const key = await mkWorker('city-length');
      await driveTo(key, 'profile.location');
      const response = await hostile(key, 'profile.location', {
        kind: 'city_state', city: 'Ab'.repeat(4000), state: 'TX',
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'too_long' });
    }, 120_000);

    test('BUG 5 blast radius: the refused 8000-character city touches no column', async () => {
      const key = await mkWorker('city-length-state');
      await driveTo(key, 'profile.location');
      const beforeRun = await runRow(key);
      const city = 'Ab'.repeat(4000);
      const response = await hostile(key, 'profile.location', { kind: 'city_state', city, state: 'TX' });
      // Before the fix this was accepted and landed as 8000 bytes in
      // users.city, worker_preferred_cities.city/city_key and
      // worker_profiles.location, then came straight back out on the wire.
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'too_long' });
      expect(await runRow(key)).toEqual(beforeRun);

      const stored = await su.query<Record<string, number | null>>(
        `SELECT (SELECT city FROM users WHERE id = $1) users_city,
                (SELECT count(*)::int FROM worker_preferred_cities WHERE user_id = $1) preferred_rows,
                (SELECT location FROM worker_profiles WHERE user_id = $1) profile_location`,
        [ids[key]],
      );
      expect(stored.rows[0]).toEqual({ users_city: null, preferred_rows: 0, profile_location: null });
      // The longest real-world inputs still pass the cap.
      const ok = await hostile(key, 'profile.location', {
        kind: 'city_state', city: 'Rancho Santa Margarita', state: 'California',
      });
      expect([200, 422]).toContain(ok.statusCode);
      if (ok.statusCode === 422) expect(ok.body.reason).not.toBe('too_long');
    }, 120_000);

    test('the 16 KB body guard fires BEFORE JSON.parse and before the pool', async () => {
      const key = await mkWorker('body-cap');
      await driveTo(key, 'profile.name');
      const before = await runRow(key);
      for (const size of [100_000, 1024 * 1024]) {
        const response = await envelope(key, {
          lockVersion: before.lock_version,
          answers: [{ stepKey: 'profile.name', value: 'a'.repeat(size) }],
        });
        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({ error: 'invalid_request' });
      }
      // A body just under the cap is parsed and then refused on its merits.
      const underCap = await hostile(key, 'profile.name', 'a'.repeat(15_000));
      expect(underCap.statusCode).toBe(422);
      expect(await runRow(key)).toEqual(before);
    }, 120_000);

    test('a body that is not JSON, or is a JSON array, is 400 before any DB work', async () => {
      const key = await mkWorker('body-shape');
      for (const rawBody of ['not json at all', '[1,2,3]', '"a string"', 'null', '42']) {
        const result: APIGatewayProxyResult = await handler(
          event(subs[key], { method: 'POST', resource: '/worker/onboarding/answers', rawBody }),
        );
        expect({ rawBody, status: result.statusCode }).toEqual({ rawBody, status: 400 });
      }
      // No run was started for any of them — the guard is above `getDbPool`.
      const runs = await su.query(`SELECT count(*)::int n FROM worker_workflow_runs WHERE user_id = $1`, [ids[key]]);
      expect(runs.rows[0].n).toBe(0);
    }, 60_000);
  });

  // =======================================================================
  // 4. Type confusion in the envelope
  // =======================================================================

  describe('4. the JSON envelope', () => {
    let key: string;
    let lockVersion: number;

    beforeAll(async () => {
      key = await mkWorker('envelope');
      const state = await driveTo(key, 'profile.name');
      lockVersion = state.run.lockVersion;
    }, 60_000);

    test.each([
      ['answers is a string', () => ({ lockVersion, answers: 'x' })],
      ['answers is an object', () => ({ lockVersion, answers: { stepKey: 'profile.name', value: 'Ana' } })],
      ['answers is empty', () => ({ lockVersion, answers: [] })],
      ['answers has 7 items (cap is 6)', () => ({
        lockVersion,
        answers: Array.from({ length: 7 }, () => ({ stepKey: 'profile.name', value: 'Ana' })),
      })],
      ['an item is null', () => ({ lockVersion, answers: [null] })],
      ['an item is an array', () => ({ lockVersion, answers: [['profile.name', 'Ana']] })],
      ['stepKey is a number', () => ({ lockVersion, answers: [{ stepKey: 7, value: 'Ana' }] })],
      ['lockVersion is a string', () => ({ lockVersion: String(lockVersion), answers: [{ stepKey: 'profile.name', value: 'Ana' }] })],
      ['lockVersion is a float', () => ({ lockVersion: 0.5, answers: [{ stepKey: 'profile.name', value: 'Ana' }] })],
      ['lockVersion is absent', () => ({ answers: [{ stepKey: 'profile.name', value: 'Ana' }] })],
      ['lockVersion is null', () => ({ lockVersion: null, answers: [{ stepKey: 'profile.name', value: 'Ana' }] })],
      ['lockVersion is a boolean', () => ({ lockVersion: true, answers: [{ stepKey: 'profile.name', value: 'Ana' }] })],
    ])('%s is 400 invalid_request', async (_label, build) => {
      const response = await envelope(key, build());
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    }, 60_000);

    test('an out-of-range but INTEGER lockVersion is a 409, not a 400', async () => {
      // `Number.isInteger(1e308)` is true, so 1e308 and -1 are well-formed
      // lock versions that simply do not match. The 409 carries the real
      // state, so the browser self-corrects — which is why this is a note
      // rather than a defect.
      for (const value of [1e308, -1, Number.MAX_SAFE_INTEGER]) {
        const response = await envelope(key, {
          lockVersion: value, answers: [{ stepKey: 'profile.name', value: 'Ana' }],
        });
        expect({ value, status: response.statusCode }).toEqual({ value, status: 409 });
        expect(response.body.error).toBe('lock_conflict');
        expect(response.body.state.run.stepKey).toBe('profile.name');
      }
    }, 60_000);

    test.each([
      ['__proto__', '__proto__'],
      ['constructor', 'constructor'],
      ['prototype', 'prototype'],
      ['toString', 'toString'],
      ['profile.photo', 'profile.photo'],
      ['trust.question.4', 'trust.question.4'],
      ['trust.question.0', 'trust.question.0'],
      ['empty string', ''],
    ])('an unknown stepKey (%s) is 422 unknown_step and pollutes nothing', async (_label, stepKey) => {
      const response = await envelope(key, { lockVersion, answers: [{ stepKey, value: 'x' }] });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'unknown_step', rejectedStepKey: stepKey });
      // `WEB_ANSWERABLE_STEPS` is a Set, so `__proto__` is a member test and
      // not a property lookup; and JSON.parse never invokes a setter.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    }, 60_000);

    test.each([
      ['a number', 42],
      ['an array', ['Ana']],
      ['an object', { first: 'Ana' }],
      ['null', null],
      ['a boolean', true],
    ])('profile.name with %s as the value is 422 step_rejected/invalid_value', async (_label, value) => {
      const response = await envelope(key, { lockVersion, answers: [{ stepKey: 'profile.name', value }] });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
    }, 60_000);

    test.each([
      // The third element is a UNIQUE fixture id: `%s` labels collide once
      // punctuation is stripped ({text: {}} and {text: []} both become
      // "text"), and a colliding `cognito_sub` is a 23505, not a test result.
      ['{text: {}}', { text: {} }, 'obj'],
      ['{text: []}', { text: [] }, 'arr'],
      ['{text: null}', { text: null }, 'null'],
      ['{text: 42}', { text: 42 }, 'num'],
      ['a bare number', 42, 'bare-num'],
      ['a bare array', ['an answer long enough to pass'], 'bare-arr'],
      ['an empty object', {}, 'empty'],
    ])('a trust answer wrapped as %s is 422 step_rejected/invalid_value', async (_label, value, id) => {
      // `record(value)` unwraps `{ text }` and `asString` refuses everything
      // else — so a mis-shaped wrapper never reaches the length checks and
      // never reaches the jsonb write.
      const trustKey = await mkWorker(`trust-shape-${id}`);
      await driveTo(trustKey, 'trust.question.1');
      const response = await hostile(trustKey, 'trust.question.1', value);
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
    }, 180_000);

    test('a step BEHIND the cursor and a step AHEAD of it are both step_mismatch', async () => {
      const behind = await envelope(key, { lockVersion, answers: [{ stepKey: 'legal.review', value: 'accept' }] });
      expect(behind.statusCode).toBe(422);
      expect(behind.body).toMatchObject({ error: 'step_mismatch', reason: 'expected:profile.name' });

      const ahead = await envelope(key, { lockVersion, answers: [{ stepKey: 'profile.trade', value: 'carpenter' }] });
      expect(ahead.statusCode).toBe(422);
      expect(ahead.body).toMatchObject({ error: 'step_mismatch', reason: 'expected:profile.name' });
    }, 60_000);

    test('a duplicated stepKey applies once and then step_mismatches, keeping the first', async () => {
      const dupKey = await mkWorker('duplicate-step');
      const state = await driveTo(dupKey, 'profile.name');
      const response = await answers(dupKey, state.run.lockVersion, [
        { stepKey: 'profile.name', value: 'Ana Uno' },
        { stepKey: 'profile.name', value: 'Ana Dos' },
      ]);
      // 422 with the FRESH state: item 1 was applied and committed (the
      // door's documented partial-progress rule), item 2 refused.
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({
        error: 'step_mismatch', rejectedStepKey: 'profile.name', reason: 'expected:profile.location',
      });
      expect(response.body.state.run.stepKey).toBe('profile.location');
      const stored = await su.query(`SELECT full_name FROM users WHERE id = $1`, [ids[dupKey]]);
      expect(stored.rows[0].full_name).toBe('Ana Uno');
    }, 60_000);

    test('a partly-valid batch keeps the accepted prefix and refuses the rest exactly once', async () => {
      const batchKey = await mkWorker('batch-prefix');
      const state = await driveTo(batchKey, 'profile.experience');
      const response = await answers(batchKey, state.run.lockVersion, [
        { stepKey: 'profile.experience', value: '2-4' },
        { stepKey: 'profile.transportation', value: 'yes-please' },
        { stepKey: 'profile.availability', value: 'full_time' },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({
        error: 'step_rejected', rejectedStepKey: 'profile.transportation', reason: 'invalid_choice',
      });
      expect(response.body.state.run.stepKey).toBe('profile.transportation');
      const stored = await su.query<{ years_experience: string; availability: string }>(
        `SELECT years_experience, availability FROM users WHERE id = $1`, [ids[batchKey]],
      );
      // Item 1 kept, item 3 never reached.
      expect(stored.rows[0].years_experience).toBe('2-4');
      expect(stored.rows[0].availability).toBeNull();
    }, 120_000);

    test('a 500 inside a batch rolls the WHOLE batch back — no partial trust answer', async () => {
      // The counterpart to the test above: a rejection COMMITS the accepted
      // prefix, a raise does not. Worth pinning explicitly, because "partial
      // progress is kept" would be a corruption rule rather than a UX one if
      // it also applied to the error path. The door now refuses every input
      // that used to make PostgreSQL raise (NUL, lone surrogates), so the
      // raise is induced with a temporary superuser trigger on the row the
      // second answer writes — the same path a real 22xxx/40xxx would take.
      await su.query(`
        CREATE OR REPLACE FUNCTION pg_temp.hostile_raise_on_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.answers::text LIKE '%RAISE_ME_500%' THEN
            RAISE EXCEPTION 'hostile-inputs suite: induced failure' USING ERRCODE = 'XX000';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER hostile_raise_on_sentinel BEFORE INSERT OR UPDATE ON worker_trust_assessments
          FOR EACH ROW EXECUTE FUNCTION pg_temp.hostile_raise_on_sentinel();
      `);
      try {
        const key500 = await mkWorker('batch-raise');
        const state = await driveTo(key500, 'trust.question.1');
        const before = await runRow(key500);
        const response = await answers(key500, state.run.lockVersion, [
          { stepKey: 'trust.question.1', value: { text: 'I hang doors and frame walls on remodels.' } },
          { stepKey: 'trust.question.2', value: { text: 'I check the plans RAISE_ME_500 against the framing.' } },
        ]);
        expect(response.statusCode).toBe(500);
        expect(response.body).toEqual({ error: 'internal_error' });
        expect(JSON.stringify(response.body)).not.toMatch(/induced|hostile|XX000/);
        expect(await runRow(key500)).toEqual(before);
        const assessments = await su.query(
          `SELECT count(*)::int n FROM worker_trust_assessments WHERE user_id = $1`, [ids[key500]],
        );
        expect(assessments.rows[0].n).toBe(0);
      } finally {
        await su.query(`DROP TRIGGER IF EXISTS hostile_raise_on_sentinel ON worker_trust_assessments`);
        await su.query(`DROP FUNCTION IF EXISTS pg_temp.hostile_raise_on_sentinel()`);
      }
    }, 180_000);

    test('an unrouteable method/action pair is 404 not_found', async () => {
      for (const opts of [
        { method: 'POST', resource: '/worker/onboarding/bogus' },
        { method: 'GET', resource: '/worker/onboarding/answers' },
        { method: 'DELETE', resource: '/worker/onboarding' },
        { method: 'PATCH', resource: '/worker/onboarding/answers' },
      ]) {
        const response = await call(subs[key], { ...opts, body: {} });
        expect({ ...opts, status: response.statusCode }).toEqual({ ...opts, status: 404 });
        expect(response.body).toEqual({ error: 'not_found' });
      }
    }, 60_000);
  });

  // =======================================================================
  // 5. State-machine abuse
  // =======================================================================

  describe('5. the state machine', () => {
    test('a stale lockVersion is 409 and the body carries the CURRENT state', async () => {
      const key = await mkWorker('stale-lock');
      const state = await driveTo(key, 'profile.name');
      const response = await answers(key, state.run.lockVersion - 1, [{ stepKey: 'profile.name', value: 'Ana' }]);
      expect(response.statusCode).toBe(409);
      expect(response.body.error).toBe('lock_conflict');
      expect(response.body.state.run.lockVersion).toBe(state.run.lockVersion);
      expect(response.body.state.run.stepKey).toBe('profile.name');
      const stored = await su.query(`SELECT full_name FROM users WHERE id = $1`, [ids[key]]);
      expect(stored.rows[0].full_name).toBeNull();
    }, 60_000);

    test('two simultaneous posts at the SAME lockVersion: exactly one wins', async () => {
      const key = await mkWorker('concurrent');
      const state = await driveTo(key, 'profile.name');
      const [a, b] = await Promise.all([
        answers(key, state.run.lockVersion, [{ stepKey: 'profile.name', value: 'Ana Uno' }]),
        answers(key, state.run.lockVersion, [{ stepKey: 'profile.name', value: 'Ana Dos' }]),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.body.error).toBe('lock_conflict');

      // ONE advance, ONE run, and the loser's write rolled back with it.
      const run = await runRow(key);
      expect(run.n).toBe(1);
      expect(run.lock_version).toBe(state.run.lockVersion + 1);
      expect(run.current_step_key).toBe('profile.location');
      const stored = await su.query<{ full_name: string }>(
        `SELECT full_name FROM users WHERE id = $1`, [ids[key]],
      );
      expect(['Ana Uno', 'Ana Dos']).toContain(stored.rows[0].full_name);
      const transitions = await su.query(
        `SELECT count(*)::int n FROM worker_workflow_transitions t
           JOIN worker_workflow_runs r ON r.id = t.run_id
          WHERE r.user_id = $1 AND t.from_step_key = 'profile.name'`,
        [ids[key]],
      );
      expect(transitions.rows[0].n).toBe(1);
    }, 60_000);

    test('back at legal.review is a 200 no-op, not an error', async () => {
      const key = await mkWorker('back-legal');
      const state = (await get(key)).body;
      const response = await back(key, state.run.lockVersion);
      expect(response.statusCode).toBe(200);
      expect(response.body.run.stepKey).toBe('legal.review');
      expect(response.body.run.lockVersion).toBe(state.run.lockVersion);
    }, 60_000);

    test('legal.review accepts only "accept"; decline is refused rather than stranding the run', async () => {
      const key = await mkWorker('legal-decline');
      const state = (await get(key)).body;
      for (const value of ['decline', 'DECLINE', 'accept ', true, 1, null]) {
        const response = await answers(key, state.run.lockVersion, [{ stepKey: 'legal.review', value }]);
        expect({ value, status: response.statusCode }).toEqual({ value, status: 422 });
        expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'invalid_value' });
      }
      const run = await runRow(key);
      expect(run.status).toBe('active');
      expect(run.current_step_key).toBe('legal.review');
    }, 60_000);

    test('after completion: answers are step_mismatch, back and language are 200 no-ops, no re-scoring', async () => {
      const key = await mkWorker('after-ready');
      let state = await driveTo(key, 'trust.question.1');
      for (let i = 1; i <= 3; i += 1) {
        state = (await hostile(key, `trust.question.${i}`, { text: VALUE_ANSWERS[i - 1] })).body;
      }
      expect(state.lifecycle).toBe('ready');

      const assessmentsBefore = await su.query<{ n: number; answers: unknown }>(
        `SELECT count(*)::int n, min(answers::text) answers FROM worker_trust_assessments WHERE user_id = $1`,
        [ids[key]],
      );
      const outboxBefore = await su.query(
        `SELECT count(*)::int n FROM worker_domain_outbox WHERE aggregate_id = $1`, [ids[key]],
      );

      const late = await answers(key, state.run.lockVersion, [
        { stepKey: 'trust.question.3', value: { text: 'A completely different answer about drywall.' } },
      ]);
      expect(late.statusCode).toBe(422);
      expect(late.body).toMatchObject({ error: 'step_mismatch', reason: 'run_not_active' });

      const backAfter = await back(key, state.run.lockVersion);
      expect(backAfter.statusCode).toBe(200);
      expect(backAfter.body.run.stepKey).toBe('trust.question.3');
      expect(backAfter.body.lifecycle).toBe('ready');

      const languageAfter = await language(key, { preferredLanguage: 'es' });
      expect(languageAfter.statusCode).toBe(200);

      const assessmentsAfter = await su.query<{ n: number; answers: unknown }>(
        `SELECT count(*)::int n, min(answers::text) answers FROM worker_trust_assessments WHERE user_id = $1`,
        [ids[key]],
      );
      // No second assessment row, and the stored answers are untouched.
      expect(assessmentsAfter.rows[0]).toEqual(assessmentsBefore.rows[0]);
      const outboxAfter = await su.query(
        `SELECT count(*)::int n FROM worker_domain_outbox WHERE aggregate_id = $1`, [ids[key]],
      );
      expect(outboxAfter.rows[0].n).toBe(outboxBefore.rows[0].n);
      const run = await runRow(key);
      expect(run.n).toBe(1);
      expect(run.status).toBe('completed');
    }, 300_000);

    test.each([
      ['xx', 'xx'],
      ['EN with a trailing space', 'EN '],
      ['es-419', 'es-419'],
      ['uppercase EN', 'EN'],
      ['500 characters', 'e'.repeat(500)],
      ['null', null],
      ['a number', 1],
      ['an object', { preferredLanguage: 'en' }],
    ])('PATCH language with %s is 400 invalid_request', async (_label, preferredLanguage) => {
      const key = await mkWorker(`lang-${String(_label).replace(/\W+/g, '')}`);
      await get(key);
      const response = await language(key, { preferredLanguage });
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      const stored = await su.query<{ preferred_language: string }>(
        `SELECT preferred_language FROM worker_workflow_runs WHERE user_id = $1`, [ids[key]],
      );
      expect(stored.rows[0].preferred_language).toBe('en');
    }, 60_000);

    test('PATCH language honours a supplied lockVersion and does not demand one', async () => {
      const key = await mkWorker('lang-lock');
      const state = (await get(key)).body;
      const stale = await language(key, { preferredLanguage: 'es', lockVersion: state.run.lockVersion + 99 });
      expect(stale.statusCode).toBe(409);
      expect(stale.body.error).toBe('lock_conflict');

      const without = await language(key, { preferredLanguage: 'es' });
      expect(without.statusCode).toBe(200);
      expect(without.body.run.preferredLanguage).toBe('es');
    }, 60_000);
  });

  // =======================================================================
  // 6. Cross-door: the OTP bind must not re-open a web-completed worker
  // =======================================================================

  describe('6. cross-door', () => {
    test('binding a phone AFTER a web completion adopts the run and keeps lifecycle=ready', async () => {
      const key = await mkWorker('crossdoor');
      let state = await driveTo(key, 'trust.question.1');
      for (let i = 1; i <= 3; i += 1) {
        state = (await hostile(key, `trust.question.${i}`, { text: VALUE_ANSWERS[i - 1] })).body;
      }
      expect(state.lifecycle).toBe('ready');
      const runBefore = await runRow(key);
      expect(runBefore.n).toBe(1);

      // The OTP lane, exactly as `whatsapp-onboarding-042.integration.test.ts`
      // calls it: `save_worker_pre_auth` for the challenge, then the bind,
      // both as `jale_whatsapp`. The phone hash is the sha256 hex
      // `hashNormalizedPhone` produces; a differently-shaped one is refused
      // with 22023 before the interesting code runs.
      const conversation = await su.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (whatsapp_number, language, conversation_state)
         VALUES ($1, 'en', 'onboarding') RETURNING id`,
        [phones[key]],
      );
      const phoneHash = createHash('sha256').update(phones[key]).digest('hex');
      const ws = await (rolePool as Pool).connect();
      try {
        await ws.query('BEGIN');
        await ws.query('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [phoneHash, JSON.stringify({
          provider_challenge_id: `hostile-${tag}`,
          current_step_key: 'identity.verify_otp',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        })]);
        const bind = await ws.query<{ run_id: string }>(
          'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,1,$4,$5,$6::jsonb)',
          [phoneHash, ids[key], conversation.rows[0].id, 'en', `SMhostile${Date.now()}`, '{}'],
        );
        await ws.query('COMMIT');
        // 087: the COMPLETED run is adopted, not replaced.
        expect(bind.rows).toHaveLength(1);
      } finally {
        ws.release();
      }

      const lifecycle = await su.query<{ lifecycle: string }>(
        `SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`, [ids[key]],
      );
      expect(lifecycle.rows[0].lifecycle).toBe('ready');
      const runAfter = await runRow(key);
      expect(runAfter.n).toBe(1);
      expect(runAfter.status).toBe('completed');
      const assessments = await su.query(
        `SELECT count(*)::int n FROM worker_trust_assessments WHERE user_id = $1`, [ids[key]],
      );
      expect(assessments.rows[0].n).toBe(1);

      // And the web door still answers with the same completed run.
      const after = await get(key);
      expect(after.statusCode).toBe(200);
      expect(after.body.lifecycle).toBe('ready');
      expect(after.body.run.stepKey).toBe('trust.question.3');
    }, 300_000);
  });

  // =======================================================================
  // 7. Identity
  // =======================================================================

  describe('7. identity', () => {
    test('a Cognito sub with no users row is 404 worker_not_found', async () => {
      const response = await call(`r2hostile-nobody-${randomUUID()}`);
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: 'worker_not_found' });
    }, 30_000);

    test('an EMPLOYER sub is 404 and starts no worker onboarding', async () => {
      const employerSub = `r2hostile-employer-${tag}`;
      const employer = await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
        [employerSub, `r2hostile-employer-${tag}@example.com`],
      );
      ids['employer-404'] = employer.rows[0].id;
      const response = await call(employerSub);
      // Indistinguishable from "no such worker", by design (086).
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: 'worker_not_found' });
      const runs = await su.query(
        `SELECT count(*)::int n FROM worker_workflow_runs WHERE user_id = $1`, [employer.rows[0].id],
      );
      expect(runs.rows[0].n).toBe(0);
      const state = await su.query(
        `SELECT count(*)::int n FROM worker_onboarding_state WHERE user_id = $1`, [employer.rows[0].id],
      );
      expect(state.rows[0].n).toBe(0);
    }, 30_000);

    test('a missing sub claim is 401 before any DB work', async () => {
      const result: APIGatewayProxyResult = await handler({
        httpMethod: 'GET', resource: '/worker/onboarding', body: null, requestContext: {},
      } as unknown as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({ error: 'unauthorized' });
    }, 30_000);

    // BUG 6 (medium): a WHITESPACE-ONLY sub is truthy, so the 401 guard
    // (worker-onboarding.ts:219) lets it through; `resolve_worker_internal_id`
    // then raises 22023 `invalid cognito sub`. `classifyStartFailure`
    // (worker-onboarding.ts:117) ALREADY maps 22023 -> 400 invalid_request,
    // but `resolveWorker` (worker-onboarding.ts:261) is called OUTSIDE the
    // try/catch that consults it, so the raise falls through to the generic
    // handler and becomes a 500.
    // MINIMAL FIX: either tighten the guard to
    // `if (!cognitoSub || !cognitoSub.trim()) return fail(401, 'unauthorized')`,
    // or wrap `resolveWorker` in the same `classifyStartFailure` try the
    // `ensureGate` call below it already uses.
    test('BUG 6: a whitespace-only sub claim should be a 4xx, not a 500', async () => {
      const response = await call('   ');
      expect([400, 401, 404]).toContain(response.statusCode);
    }, 30_000);

    test('BUG 6 blast radius: the whitespace sub leaks nothing and writes nothing', async () => {
      const before = await tableCounts();
      const response = await call('   ');
      // Blank claim = unauthenticated (401), refused before any DB call; it
      // used to reach resolve_worker_internal_id and 500 on its 22023.
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
      expect(JSON.stringify(response.body)).not.toMatch(/cognito|invalid cognito sub/i);
      expect(await tableCounts()).toEqual(before);
    }, 30_000);

    test('a suspended worker is 409 on every route, including after the run began', async () => {
      const key = await mkWorker('suspended');
      await driveTo(key, 'profile.name');
      await su.query(
        `UPDATE worker_onboarding_state SET lifecycle = 'suspended', lifecycle_changed_at = now() WHERE user_id = $1`,
        [ids[key]],
      );
      const before = await runRow(key);
      for (const attempt of [
        () => get(key),
        () => answers(key, before.lock_version, [{ stepKey: 'profile.name', value: 'Ana' }]),
        () => back(key, before.lock_version),
        () => language(key, { preferredLanguage: 'es' }),
      ]) {
        const response = await attempt();
        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({ error: 'suspended', lifecycle: 'suspended' });
      }
      // No door worked around the operator's decision.
      expect(await runRow(key)).toEqual(before);
    }, 120_000);
  });

  // =======================================================================
  // 8. What the employer sees, and what they must not
  // =======================================================================

  describe('8. the employer side of a hostile profile', () => {
    let workerKey: string;
    let assessmentId: string;

    /** Answer 2 is the QUESTION echoed back, so it is read from the run
     *  rather than written as a literal. */
    let echoedQuestion: string;
    const CONTACT_DUMP = "https://example.test/resume.pdf ' OR 1=1 -- +1 555 123 4567 me@example.test";
    const REPEATED = 'z'.repeat(200);

    beforeAll(async () => {
      workerKey = await mkWorker('employer-read');
      let state = await driveTo(workerKey, 'trust.question.1');
      // Content that is not an attack but is not prose either: a contact
      // dump, the question echoed back, and one character 200 times. The
      // panel, the scorer and the extractor all have to survive it.
      echoedQuestion = state.trust.questions[1].q_en;
      expect(echoedQuestion.length).toBeGreaterThanOrEqual(15);
      for (const [index, text] of [CONTACT_DUMP, echoedQuestion, REPEATED].entries()) {
        const response = await hostile(workerKey, `trust.question.${index + 1}`, { text });
        expect({ index, status: response.statusCode }).toEqual({ index, status: 200 });
        state = response.body;
      }
      expect(state.lifecycle).toBe('ready');
      const assessment = await su.query<{ id: string }>(
        `SELECT id FROM worker_trust_assessments WHERE user_id = $1`, [ids[workerKey]],
      );
      assessmentId = assessment.rows[0].id;
    }, 300_000);

    test('a URL, a phone number, an email, an echoed question and a 200x repeat are stored RAW', async () => {
      // Deliberate: the extractor and the scorer are given what the worker
      // actually wrote. Sanitising here would silently change the input to a
      // model whose output an employer reads.
      const stored = await su.query<{ answers: Array<Record<string, unknown>> }>(
        `SELECT answers FROM worker_trust_assessments WHERE user_id = $1`, [ids[workerKey]],
      );
      const texts = stored.rows[0].answers.map((a) => a.answer_text as string);
      expect(texts[0]).toBe(CONTACT_DUMP);
      expect(texts[0]).toContain('https://example.test/resume.pdf');
      expect(texts[0]).toContain("' OR 1=1 --");
      // The answer is the question. Nothing detects or refuses that — it is
      // an editorial problem for the scorer, not a defect in this door.
      expect(texts[1]).toBe(echoedQuestion);
      expect(texts[2]).toBe(REPEATED);
      expect(stored.rows[0].answers.map((a) => a.question_index)).toEqual([0, 1, 2]);
      // Each answer carries the question it was really asked (the durable bag).
      expect(stored.rows[0].answers.map((a) => typeof a.q_en)).toEqual(['string', 'string', 'string']);
    }, 60_000);

    test('an answer in another language is stored raw against the English question', async () => {
      // The run's `preferred_language` does not gate the ANSWER, and must
      // not: a worker on the English flow who answers in Spanish (or in
      // Japanese) is answering. The stored row keeps both question
      // renderings, so the scorer can still tell what was asked.
      const key = await mkWorker('other-language');
      await driveTo(key, 'trust.question.1');
      const spanish = 'Reviso los planos antes de cortar y mido dos veces cada pieza.';
      const japanese = 'いつも図面を確認してから切断し、寸法を二度測ります。';
      expect((await hostile(key, 'trust.question.1', { text: spanish })).statusCode).toBe(200);
      expect((await hostile(key, 'trust.question.2', { text: japanese })).statusCode).toBe(200);
      const stored = await su.query<{ answers: Array<Record<string, unknown>> }>(
        `SELECT answers FROM worker_trust_assessments WHERE user_id = $1`, [ids[key]],
      );
      expect(stored.rows[0].answers.map((a) => a.answer_text)).toEqual([spanish, japanese]);
      expect(stored.rows[0].answers.every((a) => typeof a.q_en === 'string' && typeof a.q_es === 'string')).toBe(true);
    }, 180_000);

    test('a bare "N/A" is refused by the 15-character floor before it can be stored', async () => {
      // The floor the web door holds and WhatsApp does not. This is the one
      // low-effort answer the product most wants to keep out of the scorer.
      const key = await mkWorker('na-answer');
      await driveTo(key, 'trust.question.1');
      for (const text of ['N/A', 'n/a', 'nada', 'no se', '.']) {
        const response = await hostile(key, 'trust.question.1', { text });
        expect({ text, status: response.statusCode }).toEqual({ text, status: 422 });
        expect(response.body).toMatchObject({ error: 'step_rejected', reason: 'too_short' });
      }
      const assessments = await su.query(
        `SELECT count(*)::int n FROM worker_trust_assessments WHERE user_id = $1`, [ids[key]],
      );
      expect(assessments.rows[0].n).toBe(0);
    }, 180_000);

    test('the employer applicant reads run under real RLS and hand back JSON-safe rows', async () => {
      // The two queries `lambda/api/employer-worker-profile.ts` actually runs.
      // `SET LOCAL ROLE jale_admin` is what subjects this superuser session to
      // policy — a bare superuser SELECT bypasses RLS and would prove nothing.
      const ASSESSMENT_SQL = `SELECT id, profession_key, status, competency_score, score_components,
                answers, scored_at, rubric_version
           FROM worker_trust_assessments
          WHERE user_id = $1
          ORDER BY (status = 'scored') DESC, created_at DESC LIMIT 1`;

      const employerA = `r2hostile-empA-${tag}`;
      const employerB = `r2hostile-empB-${tag}`;
      await su.query('BEGIN');
      try {
        const ea = (await su.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1,'employer',$2) RETURNING id`,
          [employerA, `r2hostile-empa-${tag}@example.com`])).rows[0].id;
        const eb = (await su.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1,'employer',$2) RETURNING id`,
          [employerB, `r2hostile-empb-${tag}@example.com`])).rows[0].id;
        const jobId = (await su.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, location, job_type, status)
           VALUES ($1,'R2 hostile gate','Austin','full-time','active') RETURNING id`, [ea])).rows[0].id;
        await su.query(
          `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1,$2,'pending')`,
          [jobId, ids[workerKey]],
        );
        await su.query(
          `INSERT INTO worker_trust_extractions
             (assessment_id, user_id, status, extracted, summary_en, summary_es, model_id, extractor_version)
           VALUES ($1,$2,'completed','{"skills":[]}'::jsonb,'EN','ES','test-model','r2-hostile')`,
          [assessmentId, ids[workerKey]],
        );

        let scenario = 0;
        const asEmployer = async (sub: string, internalId: string, sql: string, params: unknown[]) => {
          const savepoint = `hostile_${(scenario += 1)}`;
          await su.query(`SAVEPOINT ${savepoint}`);
          await su.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
          await su.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [internalId]);
          await su.query('SET LOCAL ROLE jale_admin');
          try {
            const result = await su.query(sql, params);
            await su.query('RESET ROLE');
            await su.query(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (error) {
            await su.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
            await su.query('RESET ROLE').catch(() => undefined);
            throw error;
          }
        };

        // The employer who owns the job sees the assessment, and the hostile
        // answers survive JSON serialisation to the wire.
        const mine = await asEmployer(employerA, ea, ASSESSMENT_SQL, [ids[workerKey]]);
        expect(mine.rows).toHaveLength(1);
        expect((mine.rows[0] as any).answers).toHaveLength(3);
        expect(() => JSON.stringify(mine.rows[0])).not.toThrow();
        const roundTripped = JSON.parse(JSON.stringify((mine.rows[0] as any).answers));
        expect(roundTripped.map((a: any) => a.answer_text)).toEqual([CONTACT_DUMP, echoedQuestion, REPEATED]);

        const extraction = await asEmployer(employerA, ea, TRUST_EXTRACTION_SQL, [assessmentId, ids[workerKey]]);
        expect(extraction.rows).toHaveLength(1);

        // An UNRELATED employer sees neither, under the same policies.
        const notMineAssessment = await asEmployer(employerB, eb, ASSESSMENT_SQL, [ids[workerKey]]);
        expect(notMineAssessment.rows).toHaveLength(0);
        const notMineExtraction = await asEmployer(employerB, eb, TRUST_EXTRACTION_SQL, [assessmentId, ids[workerKey]]);
        expect(notMineExtraction.rows).toHaveLength(0);

        // And an employer with the CORRECT application but no internal-user
        // binding still sees nothing: wte_employer_applicant_read keys
        // entirely on app.current_internal_user_id.
        const unbound = await asEmployer(employerA, '', TRUST_EXTRACTION_SQL, [assessmentId, ids[workerKey]]);
        expect(unbound.rows).toHaveLength(0);
      } finally {
        await su.query('ROLLBACK').catch(() => undefined);
      }
    }, 120_000);

    test('the WORKER never sees a score, whatever they typed', async () => {
      const dto = await get(workerKey);
      const serialized = JSON.stringify(dto.body);
      for (const forbidden of ['competency_score', 'score_components', 'score_rationale']) {
        expect(serialized).not.toContain(forbidden);
      }
      const client = await (rolePool as Pool).connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ids[workerKey]]);
        await expect(
          client.query(`SELECT competency_score FROM worker_trust_assessments WHERE user_id = $1`, [ids[workerKey]]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }, 60_000);
  });
});
