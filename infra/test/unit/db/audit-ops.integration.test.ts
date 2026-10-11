/**
 * audit-ops.integration.test.ts -- the operator read functions in jale_ops and
 * the personal operator login procedures (migration 112).
 *
 * Operator functions (they do not depend on the procedures: their operator
 * login is created by hand, by the master, in the accepted shape):
 *   - each is a definer owned by jale_ops_owner with a pinned search_path,
 *     executable by the operator group only (and the master for the two audit
 *     counts); the owner reads exactly the columns the fragment lists through
 *     one read policy per table;
 *   - an operator login of the accepted shape keeps the posture check and the
 *     coverage guard clean, signs in read-only, executes every operator
 *     function, and can read no table, write nothing and run no other definer;
 *   - on seeded rows full of values, the functions return identifiers, codes,
 *     times and counts only.
 * The seeded checks run as the operator login by SET ROLE inside one
 * superuser transaction that is rolled back, so no seeded row is ever visible
 * to another suite on the shared CI bed. The sign-in checks use a real
 * authenticated connection in every profile.
 *
 * The held-row listing (jale_audit.list_holds, for the master's supervised
 * holds runbook): a held row is listed with codes and times only and the kind
 * of value its free text holds; a released row is not; every runtime login
 * and an operator login are refused.
 *
 * Personal-login procedures (a separate unit, tested on its own below):
 * provision_person produces exactly the accepted shape, signs in with the
 * person's own password, renews and removes; it rejects every malformed input
 * without echoing it, and never prints the verifier; only the master runs it.
 *
 * Connection: JALE_TEST_DATABASE_URL (the superuser URL bootstrap-testbed.sh
 * exports) for fixtures and catalog reads; the master and the operator logins
 * sign in for real.
 */
import { Client } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { coverageViolations } from '../../../db/access/coverage';
import { checkPosture } from '../../../db/access/posture';
import { auditPosture } from '../../../db/access/posture-audit';
import { readCatalog } from '../../../db/access/snapshot';
import { adminRevealEvent, syntheticUuid } from './helpers/audit-events';
import {
  acceptedOperatorShape,
  AUDIT_COUNT_FUNCTIONS,
  createOperatorLoginByHand,
  loginShape,
  OPERATOR_SETTINGS,
  OPS_FUNCTIONS,
  PERSON_PROCEDURES,
  personUrl,
  scramVerifier,
  stringsIn,
  throwawayPassword,
  uniqueHandle,
} from './helpers/audit-ops';
import { VALUE_SCAN_NEGATIVES, VALUE_SCAN_POSITIVES } from './helpers/audit-value-samples';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit operator-function PostgreSQL gate was not run', () => {
    console.warn('[audit-ops] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const MASTER = 'jale_admin';
/** The EXECUTE holders of function `p`, besides its owner, in name order. */
const EXECUTE_HOLDERS = `COALESCE((SELECT array_agg(h.holder ORDER BY h.holder COLLATE "C")
               FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS holder
                       FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) h), '{}')`;
/** Text an operator function may return: codes, ids, versions, file names, digests. */
const CODE_SHAPED = /^[A-Za-z0-9_.:/+-]{1,128}$/;

async function failure(run: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? '' };
  }
}

async function connectAs(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

maybeDescribe('operator read functions (jale_ops)', () => {
  const manifest = loadManifest();
  let su: Client;
  const operator = `jale_person_${uniqueHandle('opsfn')}`;
  const operatorPassword = throwawayPassword();
  const operatorUrl = () => personUrl(databaseUrl as string, operator, operatorPassword);

  beforeAll(async () => {
    su = await connectAs(databaseUrl as string);
    await withLoginClient(MASTER, (m) => createOperatorLoginByHand(m, operator, scramVerifier(operatorPassword)));
  });

  afterAll(async () => {
    try {
      await su.query(`DROP ROLE IF EXISTS ${operator}`);
    } finally {
      await su.end();
    }
  });

  describe('catalog', () => {
    it('each operator function is a definer owned by jale_ops_owner, search_path pinned, executable by the operator group only (and the master for the audit counts)', async () => {
      const { rows } = await su.query<{ signature: string; owner: string; definer: boolean; config: string[] | null; kind: string; execute: string[] }>(
        `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                p.prokind::text AS kind,
                ${EXECUTE_HOLDERS} AS execute
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'jale_ops' AND p.prokind = 'f'
          ORDER BY 1`,
      );
      expect(rows).toEqual(OPS_FUNCTIONS.map((f) => ({
        signature: f.signature, owner: 'jale_ops_owner', definer: true,
        config: ['search_path=pg_catalog, pg_temp'], kind: 'f', execute: [...f.execute],
      })));
    });

    it('the two audit count definers belong to jale_audit_owner, executable by jale_ops_owner alone', async () => {
      const { rows } = await su.query<{ signature: string; owner: string; definer: boolean; execute: string[] }>(
        `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
                ${EXECUTE_HOLDERS} AS execute
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'jale_audit' AND p.proname IN ('export_status', 'event_counts')
          ORDER BY 1`,
      );
      expect(rows.map(({ signature, owner, definer, execute }) => ({ signature, owner, definer, execute }))).toEqual(
        AUDIT_COUNT_FUNCTIONS.map((signature) => ({ signature, owner: 'jale_audit_owner', definer: true, execute: ['jale_ops_owner'] })),
      );
    });

    it('jale_ops is closed to PUBLIC, with USAGE for the operator group and the master and CREATE for nobody', async () => {
      const { rows } = await su.query<{ grantee: string; privilege_type: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type
           FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
          WHERE n.nspname = 'jale_ops' AND a.grantee <> n.nspowner
          ORDER BY 1, 2`,
      );
      expect(rows).toEqual([
        { grantee: 'jale_admin', privilege_type: 'USAGE' },
        { grantee: 'jale_ops_readonly', privilege_type: 'USAGE' },
      ]);
    });

    it('the owner reads exactly the columns the manifest lists, with no table-level right, through one read policy per table', async () => {
      const columns = await su.query<{ table_name: string; columns: string[] }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS table_name, array_agg(att.attname::text ORDER BY att.attname) AS columns
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
                aclexplode(att.attacl) a
          WHERE a.grantee = 'jale_ops_owner'::regrole AND a.privilege_type = 'SELECT'
          GROUP BY 1 ORDER BY 1`,
      );
      const listed = Object.entries(manifest.tables)
        .filter(([, entry]) => entry.access.jale_ops_owner !== undefined)
        .map(([name, entry]) => ({ table_name: name, columns: [...(entry.access.jale_ops_owner.select as string[])].sort() }))
;
      expect(listed.length).toBeGreaterThan(0);
      const ledgerPresent = (await su.query(`SELECT pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL AS present`)).rows[0].present;
      const byName = (a: { table_name: string }, b: { table_name: string }) => (a.table_name < b.table_name ? -1 : 1);
      expect([...columns.rows].sort(byName))
        .toEqual(listed.filter((t) => ledgerPresent || t.table_name !== 'public.schema_migrations').sort(byName));
      for (const entry of Object.values(manifest.tables)) {
        const access = entry.access.jale_ops_owner;
        if (access) expect(Object.keys(access).sort()).toEqual(['reason', 'select']);
      }

      const tableLevel = await su.query(
        `SELECT c.oid::regclass::text FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE a.grantee IN ('jale_ops_owner'::regrole, 'jale_ops_readonly'::regrole)`,
      );
      expect(tableLevel.rows).toEqual([]);

      const policies = await su.query<{ table_name: string; policyname: string; cmd: string; qual: string; permissive: string }>(
        `SELECT format('%I.%I', schemaname, tablename) AS table_name, policyname, cmd, qual, permissive
           FROM pg_catalog.pg_policies WHERE 'jale_ops_owner' = ANY (roles) ORDER BY 1`,
      );
      const rlsTables = listed.filter((t) => manifest.tables[t.table_name].rls.enabled).map((t) => t.table_name);
      expect(policies.rows.map((p) => p.table_name).sort()).toEqual([...rlsTables].sort());
      for (const p of policies.rows) {
        expect(p).toMatchObject({ cmd: 'SELECT', qual: 'true', permissive: 'PERMISSIVE' });
        expect(manifest.policies[`${p.table_name}.${p.policyname}`])
          .toMatchObject({ command: 'SELECT', permissive: true, to: ['jale_ops_owner'], using: 'true', open: true });
      }
    });
  });

  describe('an operator login in the accepted shape', () => {
    it('has exactly the accepted shape', async () => {
      const shape = await loginShape(su, operator);
      expect(shape).toEqual({ ...acceptedOperatorShape(MASTER), settings: [...OPERATOR_SETTINGS] });
    });

    it('keeps the posture check (audit checks included) and the coverage guard clean', async () => {
      const posture = await withLoginClient('jale_posture', (c) => checkPosture(c, manifest, [auditPosture]));
      expect(posture.violations).toEqual([]);
      expect(posture.complete).toBe(true);
      expect(coverageViolations(await readCatalog(su), manifest)).toEqual([]);
    });

    it('signs in read-only, with a 30-second statement timeout', async () => {
      const c = await connectAs(operatorUrl());
      try {
        const ro = await c.query('SHOW default_transaction_read_only');
        const timeout = await c.query('SHOW statement_timeout');
        expect([ro.rows[0].default_transaction_read_only, timeout.rows[0].statement_timeout]).toEqual(['on', '30s']);
      } finally {
        await c.end();
      }
    });

    it('executes every operator function', async () => {
      const nobody = syntheticUuid();
      const c = await connectAs(operatorUrl());
      try {
        expect((await c.query('SELECT jale_ops.find_user($1, $2) AS id', ['email', `nobody-${nobody}@example.com`])).rows)
          .toEqual([{ id: null }]);
        for (const fn of ['user_status', 'onboarding_status', 'trust_assessment_status', 'outbox_status', 'delivery_status']) {
          expect((await c.query(`SELECT * FROM jale_ops.${fn}($1)`, [nobody])).rows).toEqual([]);
        }
        const ledger = await c.query('SELECT * FROM jale_ops.migration_ledger()');
        const direct = await su.query(
          `SELECT filename, applied_at, checksum, applied_by FROM public.schema_migrations ORDER BY filename`,
        );
        expect(ledger.rows).toEqual(direct.rows);
        expect(ledger.rows.length).toBeGreaterThan(0);

        const exportStatus = await c.query('SELECT * FROM jale_ops.audit_export_status()');
        expect(exportStatus.rows.map((r) => r.stream)).toEqual(['admin_actions_legacy', 'changes', 'events']);
        expect(exportStatus.rows).toEqual((await su.query('SELECT * FROM jale_audit.export_status()')).rows);
        const counts = await c.query(`SELECT * FROM jale_ops.audit_event_counts(now() - interval '1 day')`);
        expect(counts.fields.map((f) => f.name)).toEqual(['kind', 'outcome', 'surface', 'events']);
      } finally {
        await c.end();
      }
    });

    it('reads no table and runs no audit function', async () => {
      const c = await connectAs(operatorUrl());
      try {
        const codes: Record<string, string | undefined> = {};
        for (const [label, sql] of Object.entries({
          users: 'SELECT 1 FROM public.users LIMIT 1',
          ledger: 'SELECT 1 FROM public.schema_migrations LIMIT 1',
          audit_events: 'SELECT 1 FROM jale_audit.events LIMIT 1',
          record_event: `SELECT jale_audit.record_event('{}'::jsonb)`,
          export_status: 'SELECT * FROM jale_audit.export_status()',
        })) codes[label] = (await failure(() => c.query(sql)))?.code;
        expect(codes).toEqual({ users: '42501', ledger: '42501', audit_events: '42501', record_event: '42501', export_status: '42501' });
      } finally {
        await c.end();
      }
    });

    it('writes nothing, even after opting out of the read-only default', async () => {
      const c = await connectAs(operatorUrl());
      try {
        expect((await failure(() => c.query(`UPDATE public.users SET updated_at = updated_at WHERE false`)))?.code).toBe('25006');
        const codes: Record<string, string | undefined> = {};
        for (const [label, sql] of Object.entries({
          insert: 'INSERT INTO public.trade_aliases DEFAULT VALUES',
          update: 'UPDATE public.users SET updated_at = updated_at WHERE false',
          delete: 'DELETE FROM public.users WHERE false',
          truncate: 'TRUNCATE public.trade_aliases',
          create_public: 'CREATE TABLE public.audit_ops_probe (a int)',
          create_ops: 'CREATE TABLE jale_ops.audit_ops_probe (a int)',
          ops_function: 'CREATE FUNCTION jale_ops.audit_ops_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
        })) {
          await c.query('BEGIN READ WRITE');
          codes[label] = (await failure(() => c.query(sql)))?.code;
          await c.query('ROLLBACK');
        }
        expect(codes).toEqual({
          insert: '42501', update: '42501', delete: '42501', truncate: '42501',
          create_public: '42501', create_ops: '42501', ops_function: '42501',
        });
      } finally {
        await c.end();
      }
    });

    it('holds no right on any table, column or sequence, CREATE on no schema, and EXECUTE on no definer outside jale_ops', async () => {
      const { rows } = await su.query<{ object: string }>(
        `SELECT 'table ' || c.oid::regclass::text AS object
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            AND (pg_catalog.has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                 OR pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
         UNION ALL
         SELECT 'sequence ' || c.oid::regclass::text
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            -- CASE: the planner may test a qual before relkind, and the function rejects a non-sequence.
            AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE') ELSE false END
         UNION ALL
         SELECT 'schema ' || n.nspname FROM pg_catalog.pg_namespace n
          WHERE pg_catalog.has_schema_privilege($1, n.oid, 'CREATE')
         UNION ALL
         SELECT 'definer ' || p.oid::regprocedure::text
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname <> 'jale_ops'
            AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
          ORDER BY 1`,
        [operator],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('on seeded rows full of values (one transaction, rolled back)', () => {
    const W = syntheticUuid();
    const OTHER = syntheticUuid();
    const RUN = syntheticUuid();
    const INTENT = syntheticUuid();
    const WA_OUT = syntheticUuid();
    const tag = syntheticUuid().slice(-12);
    const NAME = 'Opal Testworker';
    const EMAIL = `opal.testworker.${tag}@example.com`;
    const SUB = `ops-test-sub-${tag}`;
    const FREE_TEXT = [
      NAME, 'Exampleville', '12 Example St', 'Strong answers from Opal', 'I wired the panel', 'reply to me',
      'Interview at', 'Hello Opal', 'Your number', 'Bounce for', 'unreachable', 'Name given',
    ];
    let phone = '';
    let whatsapp = '';
    let surface = '';

    /** Picks two numbers in the fictional 555-01xx range that no user holds. */
    async function freeNumbers(): Promise<[string, string]> {
      const { rows } = await su.query<{ n: string }>(
        `SELECT '+1202555' || lpad(i::text, 4, '0') AS n
           FROM generate_series(100, 199) i
          WHERE NOT EXISTS (SELECT 1 FROM public.users u
                             WHERE regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = '1202555' || lpad(i::text, 4, '0')
                                OR regexp_replace(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g') = '1202555' || lpad(i::text, 4, '0'))
          ORDER BY random() LIMIT 2`,
      );
      if (rows.length < 2) throw new Error('audit-ops: no free synthetic number');
      return [rows[0].n, rows[1].n];
    }

    async function seed(): Promise<void> {
      [phone, whatsapp] = await freeNumbers();
      const display = `+1 (202) 555-${phone.slice(-4)}`;
      // The functions read these rows by key; the foreign-key chain behind a
      // job conversation is irrelevant to them, so the fixture skips FK and
      // trigger enforcement for its own inserts.
      await su.query('SET LOCAL session_replication_role = replica');
      await su.query(
        `INSERT INTO public.users (id, cognito_sub, user_type, email, phone, full_name, whatsapp_number, whatsapp_linked_at,
                                   city, main_trade, years_experience, availability, trade_competency_score,
                                   tos_version, tos_accepted_at, privacy_version, privacy_accepted_at)
         VALUES ($1, $2, 'worker', $3, $4, $5, $6, now(), 'Exampleville', 'electrician', '5-9', 'full_time', 88,
                 '2026-01', now(), '2026-01', now())`,
        [W, SUB, EMAIL, phone, NAME, whatsapp],
      );
      await su.query(
        `INSERT INTO public.worker_onboarding_state (id, user_id, lifecycle) VALUES ($1, $2, 'onboarding')`,
        [syntheticUuid(), W],
      );
      await su.query(
        `INSERT INTO public.worker_workflow_runs (id, user_id, workflow_version, current_step_key, status, preferred_language, context)
         VALUES ($1, $2, 1, 'profile.name', 'active', 'en', $3::jsonb)`,
        [RUN, W, JSON.stringify({ full_name: NAME, phone: display })],
      );
      await su.query(
        `INSERT INTO public.worker_workflow_transitions (id, run_id, from_step_key, to_step_key, reason, metadata)
         VALUES ($1, $2, 'identity.verify_otp', 'profile.name', $3, $4::jsonb)`,
        [syntheticUuid(), RUN, `Name given: ${NAME}`, JSON.stringify({ note: display })],
      );
      await su.query(
        `INSERT INTO public.worker_identity_challenges (id, phone_hash, provider_challenge_id, candidate_user_id,
                                                        preferred_language, current_step_key, context, status, attempts, expires_at)
         VALUES ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), $3, $4, 'en', 'identity.verify_otp', $5::jsonb,
                 'pending', 1, now() + interval '10 minutes')`,
        [syntheticUuid(), phone, `test-challenge-${tag}`, W, JSON.stringify({ phone: display })],
      );
      await su.query(
        `INSERT INTO public.worker_trust_assessments (id, user_id, profession_key, answers, status, competency_score,
                                                      score_components, score_rationale, rubric_version, scoring_model_id, scored_at)
         VALUES ($1, $2, 'electrician', $3::jsonb, 'scored', 88, $4::jsonb, $5::jsonb, 'v3', 'test-model-1', now())`,
        [syntheticUuid(), W, JSON.stringify([{ answer: `I wired the panel at 12 Example St, call ${display}` }]),
          JSON.stringify({ safety: 91 }), JSON.stringify({ text: `Strong answers from Opal, ${EMAIL}` })],
      );
      await su.query(
        `INSERT INTO public.worker_domain_outbox (id, event_type, aggregate_id, event_key, payload, status, attempts, last_error)
         VALUES ($1, 'worker.ready', $2, $3, $4::jsonb, 'failed', 3, $5)`,
        [syntheticUuid(), W, `ops-test-${tag}-${phone}`, JSON.stringify({ email: EMAIL }), `delivery to ${EMAIL} failed`],
      );
      await su.query(
        `INSERT INTO public.whatsapp_outbox (id, sequence, whatsapp_number, body, status, source_type, source_id, attempt_count,
                                             twilio_delivery_status, twilio_error_code, twilio_error_message, last_error)
         VALUES ($1, 0, $2, $3, 'failed', 'worker_intent', $4, 2, 'undelivered', '63016', $5, $6)`,
        [WA_OUT, whatsapp, `Hi ${NAME}, reply to me at ${display}`, INTENT, `Failed to send to ${whatsapp}`, `${NAME} unreachable`],
      );
      await su.query(
        `INSERT INTO public.worker_message_intents (id, user_id, category, owner_service, source_type, source_id, dedupe_key,
                                                    priority, status, policy_version, decision_reason, payload, outbox_id)
         VALUES ($1, $2, 'onboarding', 'onboarding-v2', 'workflow', $3, $4, 10, 'delivered', 1, $5, $6::jsonb, $7)`,
        [INTENT, W, syntheticUuid(), `ops-test-${tag}-${whatsapp}`, `Sent to ${NAME}`, JSON.stringify({ text: `Hello ${NAME}` }), WA_OUT],
      );
      await su.query(
        `INSERT INTO public.job_message_outbox (id, conversation_id, whatsapp_number, send_kind, body, status, attempt_count, sent_at, last_error)
         VALUES ($1, $2, $3, 'freeform', $4, 'sent', 1, now(), $5)`,
        [syntheticUuid(), syntheticUuid(), whatsapp, `Interview at 12 Example St with ${NAME}`, `${NAME} unreachable`],
      );
      await su.query(
        `INSERT INTO public.email_outbox (id, recipient_email, subject, body_text, source_type, source_id, status, attempt_count, last_error)
         VALUES ($1, upper($2), $3, $4, 'job_digest', $5, 'failed', 2, $6)`,
        [syntheticUuid(), EMAIL, `Hello ${NAME}`, `Your number ${display}`, syntheticUuid(), `Bounce for ${EMAIL}`],
      );
      await su.query('SET LOCAL session_replication_role = origin');

      surface = `employer.ops_count_${tag}`;
      for (let i = 0; i < 3; i += 1) {
        await su.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify({
          kind: 'read', outcome: 'allowed', actor_kind: 'employer', actor_id: syntheticUuid(), channel: 'web',
          surface, categories: ['profile'], subject_user_ids: [W], record_type: 'user', record_ids: [W],
          result_count: 1, field_names: ['full_name'], purpose_kind: 'job', purpose_id: syntheticUuid(),
          request_id: `ops-test-${tag}`,
        })]);
      }
    }

    /** Runs `fn` as the operator login inside the seeded transaction. */
    async function asOperator<T>(fn: () => Promise<T>): Promise<T> {
      // A savepoint, so an expected error inside still leaves the superuser
      // transaction usable: rolling back to it also ends the SET ROLE.
      await su.query('SAVEPOINT as_operator');
      await su.query(`SET LOCAL ROLE ${operator}`);
      try {
        return await fn();
      } finally {
        await su.query('ROLLBACK TO SAVEPOINT as_operator');
        await su.query('RELEASE SAVEPOINT as_operator');
      }
    }

    let outputs: Record<string, unknown[]> = {};
    let since: Date;

    beforeAll(async () => {
      await su.query('BEGIN');
      since = (await su.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0].t;
      await seed();
      outputs = await asOperator(async () => {
        const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;
        return {
          find_email: await q('SELECT jale_ops.find_user($1, $2) AS id', ['email', `  ${EMAIL.toUpperCase()} `]),
          find_phone: await q('SELECT jale_ops.find_user($1, $2) AS id', ['phone', `+1 (202) 555-${phone.slice(-4)}`]),
          find_whatsapp: await q('SELECT jale_ops.find_user($1, $2) AS id', ['whatsapp', whatsapp]),
          find_sub: await q('SELECT jale_ops.find_user($1, $2) AS id', ['cognito_sub', SUB]),
          find_none: await q('SELECT jale_ops.find_user($1, $2) AS id', ['email', `nobody.${tag}@example.com`]),
          user_status: await q('SELECT * FROM jale_ops.user_status($1)', [W]),
          onboarding_status: await q('SELECT * FROM jale_ops.onboarding_status($1)', [W]),
          trust_assessment_status: await q('SELECT * FROM jale_ops.trust_assessment_status($1)', [W]),
          outbox_status: await q('SELECT * FROM jale_ops.outbox_status($1)', [W]),
          delivery_status: await q('SELECT * FROM jale_ops.delivery_status($1)', [W]),
          migration_ledger: await q('SELECT * FROM jale_ops.migration_ledger()'),
          audit_export_status: await q('SELECT * FROM jale_ops.audit_export_status()'),
          audit_event_counts: await q('SELECT * FROM jale_ops.audit_event_counts($1)', [since]),
        };
      });
    });

    afterAll(async () => {
      await su.query('ROLLBACK');
    });

    it('find_user finds the user by each kind, ignoring case, spacing and punctuation, and reports no match as NULL', () => {
      expect([outputs.find_email, outputs.find_phone, outputs.find_whatsapp, outputs.find_sub, outputs.find_none])
        .toEqual([[{ id: W }], [{ id: W }], [{ id: W }], [{ id: W }], [{ id: null }]]);
    });

    it('find_user refuses an ambiguous match with a count, never the value', async () => {
      await su.query('SAVEPOINT ambiguous');
      try {
        await su.query(
          `INSERT INTO public.users (id, cognito_sub, user_type, email, phone) VALUES ($1, $2, 'worker', $3, $4)`,
          [OTHER, `${SUB}-other`, `other.${EMAIL}`, phone],
        );
        const err = await asOperator(() => failure(() => su.query('SELECT jale_ops.find_user($1, $2)', ['phone', phone])));
        expect(err?.code).toBe('21000');
        expect(err?.message).toBe('find_user: 2 users match; look the user up by another kind');
      } finally {
        await su.query('ROLLBACK TO SAVEPOINT ambiguous');
      }
    });

    it('user_status returns account codes, presence flags and times', () => {
      expect(outputs.user_status).toHaveLength(1);
      expect(outputs.user_status[0]).toMatchObject({
        user_id: W, user_type: 'worker', tenant_id: null, has_email: true, has_phone: true, has_whatsapp: true,
        tos_version: '2026-01', privacy_version: '2026-01',
      });
    });

    it('onboarding_status returns the state, the run, the step change and the challenge', () => {
      expect(outputs.onboarding_status.map((r) => (r as { source: string }).source))
        .toEqual(['onboarding_state', 'workflow_run', 'workflow_transition', 'identity_challenge']);
      expect(outputs.onboarding_status[1]).toMatchObject({ record_id: RUN, status: 'active', step_key: 'profile.name' });
      expect(outputs.onboarding_status[2]).toMatchObject({ run_id: RUN, step_key: 'identity.verify_otp', to_step_key: 'profile.name' });
      expect(outputs.onboarding_status[3]).toMatchObject({ status: 'pending', step_key: 'identity.verify_otp', attempts: 1 });
    });

    it('trust_assessment_status returns statuses and versions, never a score or an answer', () => {
      expect(outputs.trust_assessment_status).toHaveLength(1);
      expect(Object.keys(outputs.trust_assessment_status[0] as object))
        .toEqual(['assessment_id', 'profession_key', 'status', 'rubric_version', 'scoring_model_id', 'created_at', 'scored_at']);
      expect(outputs.trust_assessment_status[0]).toMatchObject({ profession_key: 'electrician', status: 'scored', rubric_version: 'v3' });
    });

    it('outbox_status returns the domain event and the message intent', () => {
      expect(outputs.outbox_status.map((r) => {
        const { source, kind, service, status, attempts, outbox_id: outboxId } = r as Record<string, unknown>;
        return { source, kind, service, status, attempts, outboxId };
      }).sort((a, b) => String(a.source).localeCompare(String(b.source)))).toEqual([
        { source: 'domain_event', kind: 'worker.ready', service: null, status: 'failed', attempts: 3, outboxId: null },
        { source: 'message_intent', kind: 'onboarding', service: 'onboarding-v2', status: 'delivered', attempts: null, outboxId: WA_OUT },
      ]);
    });

    it('delivery_status returns the WhatsApp message, the job message and the email, with provider codes only', () => {
      expect(outputs.delivery_status.map((r) => {
        const { channel, kind, status, provider_status: ps, provider_error_code: code, attempts } = r as Record<string, unknown>;
        return { channel, kind, status, ps, code, attempts };
      }).sort((a, b) => String(a.channel).localeCompare(String(b.channel)))).toEqual([
        { channel: 'email', kind: 'job_digest', status: 'failed', ps: null, code: null, attempts: 2 },
        { channel: 'job_message', kind: 'freeform', status: 'sent', ps: null, code: null, attempts: 1 },
        { channel: 'whatsapp', kind: 'worker_intent', status: 'failed', ps: 'undelivered', code: '63016', attempts: 2 },
      ]);
    });

    it('audit_event_counts counts the events since a time per kind, outcome and surface; audit_export_status reports each stream', () => {
      expect(outputs.audit_event_counts.filter((r) => (r as { surface: string }).surface === surface))
        .toEqual([{ kind: 'read', outcome: 'allowed', surface, events: '3' }]);
      expect(outputs.audit_export_status.map((r) => (r as { stream: string }).stream))
        .toEqual(['admin_actions_legacy', 'changes', 'events']);
    });

    it('no function returns a seeded value, a value-shaped span or free text', async () => {
      const strings = stringsIn(outputs);
      const forbidden = [
        ...FREE_TEXT, EMAIL, EMAIL.toUpperCase(), SUB, phone, whatsapp, phone.slice(1), whatsapp.slice(1),
        `555-${phone.slice(-4)}`, `555-${whatsapp.slice(-4)}`, `test-challenge-${tag}`, 'Failed to send',
      ];
      const hits = strings.filter((s) => forbidden.some((f) => s.includes(f)));
      expect(hits).toEqual([]);
      // Every text value is code-shaped: no spaces, no '@', nothing longer than a digest.
      expect(strings.filter((s) => !CODE_SHAPED.test(s))).toEqual([]);
      // And the shared value-span rule (migration 110) finds nothing to remove.
      const { rows } = await su.query<{ s: string }>(
        `SELECT s FROM unnest($1::text[]) s WHERE jale_audit.redact_value_spans(s) IS DISTINCT FROM s`, [strings],
      );
      expect(rows).toEqual([]);
    });

    it('migration_ledger returns no rows where the ledger does not exist; audit_event_counts needs a time', async () => {
      await su.query('SAVEPOINT no_ledger');
      try {
        await su.query('ALTER TABLE public.schema_migrations RENAME TO schema_migrations_absent');
        expect(await asOperator(async () => (await su.query('SELECT * FROM jale_ops.migration_ledger()')).rows)).toEqual([]);
      } finally {
        await su.query('ROLLBACK TO SAVEPOINT no_ledger');
      }
      const err = await asOperator(() => failure(() => su.query('SELECT * FROM jale_ops.audit_event_counts(NULL)')));
      expect(err?.code).toBe('22023');
    });

    it('find_user rejects a bad kind or value without echoing either', async () => {
      // [label, kind, value, the input that must never appear in the message]
      const cases: Array<[string, unknown, unknown, string | null]> = [
        ['unknown kind', 'full_name', NAME, NAME],
        ['swapped arguments', phone, 'phone', phone],
        ['null kind', null, EMAIL, EMAIL],
        ['null value', 'email', null, null],
        ['blank value', 'email', '   ', null],
        ['oversized value', 'email', `${'x'.repeat(320)}@example.com`, 'xxxxxxxx'],
        ['too few digits', 'phone', '555-014', '555-014'],
        ['too many digits', 'whatsapp', '+1 202 555 0142 0142 01', '0142 0142'],
      ];
      const results: Record<string, { code?: string; echoed: boolean } | null> = {};
      for (const [label, kind, value, secret] of cases) {
        const err = await asOperator(() => failure(() => su.query('SELECT jale_ops.find_user($1, $2)', [kind, value])));
        results[label] = err && { code: err.code, echoed: secret !== null && err.message.includes(secret) };
      }
      expect(results).toEqual(Object.fromEntries(cases.map(([label]) => [label, { code: '22023', echoed: false }])));
    });
  });
});

maybeDescribe('the held-row listing (jale_audit.list_holds)', () => {
  const manifest = loadManifest();
  let su: Client;

  beforeAll(async () => {
    su = await connectAs(databaseUrl as string);
  });

  afterAll(async () => {
    await su.end();
  });

  /** The kind each shared positive sample must be named. */
  const kindOf = (label: string) => (label.includes('phone') ? 'phone' : label.includes('email') ? 'email' : 'url');

  it('list_holds is a definer owned by jale_audit_owner, search_path pinned, executable by jale_admin alone; value_span_kind by its owner alone', async () => {
    const { rows } = await su.query(
      `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
              pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              ${EXECUTE_HOLDERS} AS execute
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'jale_audit' AND p.proname IN ('list_holds', 'value_span_kind')
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { signature: 'jale_audit.list_holds()', owner: 'jale_audit_owner', definer: true, config: ['search_path=pg_catalog, pg_temp'], execute: ['jale_admin'] },
      { signature: 'jale_audit.value_span_kind(text)', owner: 'jale_audit_owner', definer: false, config: ['search_path=pg_catalog, pg_temp'], execute: [] },
    ]);
    expect(manifest.functions['jale_audit.list_holds()']).toMatchObject({ owner: 'jale_audit_owner', security: 'definer', execute: ['jale_admin'] });
    expect(manifest.functions['jale_audit.value_span_kind(text)']).toMatchObject({ owner: 'jale_audit_owner', security: 'invoker', execute: [] });
  });

  it('value_span_kind names the kind of every shared sample, and finds a value exactly where the shared redaction does', async () => {
    const samples = [
      ...VALUE_SCAN_NEGATIVES.map(([label, text]) => ({ label, text, kind: 'none' })),
      ...VALUE_SCAN_POSITIVES.map(([label, text]) => ({ label, text, kind: kindOf(label) })),
      { label: 'two kinds', text: 'Wrote to someone@example.com and called +15555550123.', kind: 'several' },
      { label: 'empty', text: '', kind: 'none' },
    ];
    const { rows } = await su.query<{ text: string; kind: string; redacted: boolean }>(
      `SELECT s AS text, jale_audit.value_span_kind(s) AS kind, jale_audit.redact_value_spans(s) <> s AS redacted
         FROM unnest($1::text[]) WITH ORDINALITY AS t(s, i) ORDER BY i`,
      [samples.map((x) => x.text)],
    );
    expect(rows.map((r, i) => [samples[i].label, r.kind])).toEqual(samples.map((x) => [x.label, x.kind]));
    expect(rows.filter((r) => (r.kind !== 'none') !== r.redacted)).toEqual([]);
    expect((await su.query('SELECT jale_audit.value_span_kind(NULL) AS kind')).rows).toEqual([{ kind: 'none' }]);
  });

  describe('on seeded holds (one transaction, rolled back)', () => {
    const tag = syntheticUuid().slice(-12);
    const EMAIL = `holds.${tag}@example.com`;
    let held = 0;
    let released = 0;
    let heldChange = 0;
    let heldLegacy = 0;
    let listed: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    async function asMaster<T>(fn: () => Promise<T>): Promise<T> {
      await su.query('SAVEPOINT as_master');
      await su.query('SET LOCAL ROLE jale_admin');
      try {
        return await fn();
      } finally {
        await su.query('ROLLBACK TO SAVEPOINT as_master');
        await su.query('RELEASE SAVEPOINT as_master');
      }
    }

    beforeAll(async () => {
      await su.query('BEGIN');
      const record = async (reason: string) => Number((await su.query<{ seq: string }>(
        'SELECT jale_audit.record_event($1::jsonb) AS seq', [JSON.stringify(adminRevealEvent({ reason, request_id: `holds-${tag}` }))],
      )).rows[0].seq);
      held = await record(`Wrote to ${EMAIL} about the case.`);
      released = await record('Called +15555550123 about the case.');
      heldChange = Number((await su.query<{ seq: string }>(
        `INSERT INTO jale_audit.changes (table_name, operation, row_count, changed_fields, context_status)
         VALUES ('public.users', 'update', 1, '{email}', 'unset') RETURNING seq`,
      )).rows[0].seq);
      // A dashboard record as the previous dashboard writes it; the insert scrub removes the number.
      heldLegacy = Number((await su.query<{ seq: string }>(
        `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
         VALUES ($1, 'admin_ops', 'reveal_contact', 'admin_case', $2, true, $3::jsonb) RETURNING seq`,
        [EMAIL, syntheticUuid(), JSON.stringify({ justification: 'Called +15555550123 back.' })],
      )).rows[0].seq);
      // Holds carry the number of the batch that held them; no batch row is needed for the listing.
      await su.query(
        `INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq)
         VALUES ('events', $1, 'hold', 1), ('events', $2, 'hold', 1), ('changes', $3, 'hold', 1),
                ('admin_actions_legacy', $4, 'hold', 1)`,
        [held, released, heldChange, heldLegacy],
      );
      await su.query('SET LOCAL ROLE jale_admin');
      await su.query("SELECT jale_audit.release_hold('events', $1)", [released]);
      await su.query('RESET ROLE');
      const result = await asMaster(() => su.query('SELECT * FROM jale_audit.list_holds()'));
      columns = result.fields.map((f) => f.name);
      listed = result.rows;
    });

    afterAll(async () => {
      await su.query('ROLLBACK');
    });

    it('returns stream, seq, occurred_at, surface, held_at and pattern_kind, and nothing else', () => {
      expect(columns).toEqual(['stream', 'seq', 'occurred_at', 'surface', 'held_at', 'pattern_kind']);
    });

    it('lists a held row with its codes, times and the kind of value its reason holds', () => {
      const event = listed.filter((r) => r.stream === 'events' && Number(r.seq) === held);
      expect(event).toHaveLength(1);
      expect(event[0]).toMatchObject({ surface: 'admin.case_detail.reveal', pattern_kind: 'email' });
      expect(event[0].occurred_at).toBeInstanceOf(Date);
      expect(event[0].held_at).toBeInstanceOf(Date);
      const change = listed.filter((r) => r.stream === 'changes' && Number(r.seq) === heldChange);
      expect(change).toHaveLength(1);
      expect(change[0]).toMatchObject({ surface: null, pattern_kind: 'none' });
      const legacy = listed.filter((r) => r.stream === 'admin_actions_legacy' && Number(r.seq) === heldLegacy);
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ surface: null, pattern_kind: 'none' });
      expect(legacy[0].occurred_at).toBeInstanceOf(Date);
    });

    it('does not list a released row', () => {
      expect(listed.filter((r) => r.stream === 'events' && Number(r.seq) === released)).toEqual([]);
    });

    it('returns no value: only code-shaped text, nothing the held reason holds', async () => {
      const strings = stringsIn(listed);
      expect(strings.filter((x) => x.includes(EMAIL) || x.includes('example.com') || x.includes('+1555'))).toEqual([]);
      expect(strings.filter((x) => !CODE_SHAPED.test(x))).toEqual([]);
      const { rows } = await su.query(
        `SELECT s FROM unnest($1::text[]) s WHERE jale_audit.redact_value_spans(s) IS DISTINCT FROM s`, [strings],
      );
      expect(rows).toEqual([]);
    });
  });

  it('refuses every runtime login and a personal operator login with 42501', async () => {
    const operator = `jale_person_${uniqueHandle('holds')}`;
    const password = throwawayPassword();
    await withLoginClient(MASTER, (m) => createOperatorLoginByHand(m, operator, scramVerifier(password)));
    try {
      const codes: Record<string, string | undefined> = {};
      for (const login of Object.keys(manifest.logins).sort()) {
        codes[login] = await withLoginClient(login, async (c) => (await failure(() => c.query('SELECT * FROM jale_audit.list_holds()')))?.code);
      }
      const c = await connectAs(personUrl(databaseUrl as string, operator, password));
      try {
        codes.operator = (await failure(() => c.query('SELECT * FROM jale_audit.list_holds()')))?.code;
      } finally {
        await c.end();
      }
      expect(codes).toEqual(Object.fromEntries([...Object.keys(manifest.logins).sort(), 'operator'].map((l) => [l, '42501'])));
      expect(Object.keys(codes).length).toBeGreaterThan(5);
    } finally {
      await su.query(`DROP ROLE IF EXISTS ${operator}`);
    }
  });
});

maybeDescribe('personal operator login procedures (separable unit)', () => {
  const manifest = loadManifest();
  let su: Client;
  const created = new Set<string>();

  beforeAll(async () => {
    su = await connectAs(databaseUrl as string);
  });

  afterAll(async () => {
    try {
      for (const role of created) await su.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await su.end();
    }
  });

  /** Runs one CALL as the master, collecting its notices. */
  async function callAsMaster(sql: string, params: unknown[]): Promise<{ notices: string[]; error: { code?: string; message: string } | null }> {
    return withLoginClient(MASTER, async (m) => {
      const notices: string[] = [];
      m.on('notice', (n) => notices.push(n.message ?? ''));
      const error = await failure(() => m.query(sql, params));
      return { notices, error };
    });
  }

  it('are invoker procedures owned by jale_ops_owner, search_path pinned, closed to PUBLIC, executable by the master alone', async () => {
    const { rows } = await su.query<{ signature: string; owner: string; definer: boolean; kind: string; config: string[]; execute: string[] }>(
      `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
              pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.prokind::text AS kind, p.proconfig AS config,
              ${EXECUTE_HOLDERS} AS execute
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'jale_ops' AND p.prokind = 'p'
        ORDER BY 1`,
    );
    expect(rows).toEqual(PERSON_PROCEDURES.map((signature) => ({
      signature, owner: 'jale_ops_owner', definer: false, kind: 'p', config: ['search_path=pg_catalog, pg_temp'], execute: ['jale_admin'],
    })));
    for (const signature of PERSON_PROCEDURES) {
      expect(manifest.functions[signature]).toMatchObject({ kind: 'procedure', returns: null, security: 'invoker', execute: ['jale_admin'] });
    }
  });

  it('provision_person creates exactly the accepted shape, signs in with the person\'s own password, and keeps posture and coverage clean', async () => {
    const handle = uniqueHandle('prov');
    const role = `jale_person_${handle}`;
    const password = throwawayPassword();
    const verifier = scramVerifier(password);
    created.add(role);

    const { notices, error } = await callAsMaster('CALL jale_ops.provision_person($1, $2, $3)', [handle, verifier, 30]);
    expect(error).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(new RegExp(`^provision_person: ${role} can sign in until \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`));
    const [, saltAndIter, keys] = verifier.split('$');
    for (const part of [verifier, saltAndIter.split(':')[1], ...keys.split(':')]) {
      expect(notices.join('\n')).not.toContain(part);
    }

    expect(await loginShape(su, role)).toEqual({ ...acceptedOperatorShape(MASTER), settings: [...OPERATOR_SETTINGS] });
    const stored = await su.query<{ verifier_kept: boolean; days: number }>(
      `SELECT rolpassword = $2 AS verifier_kept,
              round(extract(epoch FROM rolvaliduntil - now()) / 86400)::int AS days
         FROM pg_catalog.pg_authid WHERE rolname = $1`,
      [role, verifier],
    );
    expect(stored.rows).toEqual([{ verifier_kept: true, days: 30 }]);

    const c = await connectAs(personUrl(databaseUrl as string, role, password));
    try {
      expect((await c.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on');
      expect((await c.query('SELECT count(*)::int AS n FROM jale_ops.migration_ledger()')).rows[0].n).toBeGreaterThan(0);
    } finally {
      await c.end();
    }

    const posture = await withLoginClient('jale_posture', (p) => checkPosture(p, manifest, [auditPosture]));
    expect(posture.violations).toEqual([]);
    expect(posture.complete).toBe(true);
    expect(coverageViolations(await readCatalog(su), manifest)).toEqual([]);
  });

  it('renew_person replaces the verifier and the expiry and keeps the shape; remove_person drops the login', async () => {
    const handle = uniqueHandle('renew');
    const role = `jale_person_${handle}`;
    const oldPassword = throwawayPassword();
    const newPassword = throwawayPassword();
    created.add(role);
    expect((await callAsMaster('CALL jale_ops.provision_person($1, $2, $3)', [handle, scramVerifier(oldPassword), 7])).error).toBeNull();

    const newVerifier = scramVerifier(newPassword, 8192);
    const renewed = await callAsMaster('CALL jale_ops.renew_person($1, $2, $3)', [handle, newVerifier, 60]);
    expect(renewed.error).toBeNull();
    expect(renewed.notices.join('\n')).not.toContain(newVerifier.split('$')[2]);
    expect(await loginShape(su, role)).toEqual({ ...acceptedOperatorShape(MASTER), settings: [...OPERATOR_SETTINGS] });
    const stored = await su.query(
      `SELECT rolpassword = $2 AS verifier_kept, round(extract(epoch FROM rolvaliduntil - now()) / 86400)::int AS days
         FROM pg_catalog.pg_authid WHERE rolname = $1`,
      [role, newVerifier],
    );
    expect(stored.rows).toEqual([{ verifier_kept: true, days: 60 }]);

    expect((await failure(async () => {
      const c = await connectAs(personUrl(databaseUrl as string, role, oldPassword));
      await c.end();
    }))?.code).toBe('28P01');
    const c = await connectAs(personUrl(databaseUrl as string, role, newPassword));
    await c.end();

    const removed = await callAsMaster('CALL jale_ops.remove_person($1)', [handle]);
    expect(removed.error).toBeNull();
    expect(removed.notices).toEqual([`remove_person: ${role} removed; 0 open sessions`]);
    expect(await loginShape(su, role)).toBeNull();
  });

  it('refuses a duplicate, a missing login and a login that lost the operator shape', async () => {
    const handle = uniqueHandle('dup');
    const role = `jale_person_${handle}`;
    created.add(role);
    const verifier = scramVerifier(throwawayPassword());
    expect((await callAsMaster('CALL jale_ops.provision_person($1, $2, $3)', [handle, verifier, 1])).error).toBeNull();
    expect((await callAsMaster('CALL jale_ops.provision_person($1, $2, $3)', [handle, verifier, 1])).error?.code).toBe('42710');

    const missing = uniqueHandle('none');
    expect((await callAsMaster('CALL jale_ops.renew_person($1, $2, $3)', [missing, verifier, 1])).error?.code).toBe('42704');
    expect((await callAsMaster('CALL jale_ops.remove_person($1)', [missing])).error?.code).toBe('42704');

    await withLoginClient(MASTER, (m) => m.query(`REVOKE jale_ops_readonly FROM ${role}`));
    expect((await callAsMaster('CALL jale_ops.renew_person($1, $2, $3)', [handle, verifier, 1])).error?.code).toBe('22023');
    expect((await callAsMaster('CALL jale_ops.remove_person($1)', [handle])).error).toBeNull();
    expect(await loginShape(su, role)).toBeNull();
  });

  it('rejects every malformed input with 22023, echoing none of it and creating nothing', async () => {
    const good = scramVerifier(throwawayPassword());
    const [, iterSalt, keys] = good.split('$');
    const [storedKey, serverKey] = keys.split(':');
    const salt = iterSalt.split(':')[1];
    const handle = uniqueHandle('bad');
    const cases: Array<[string, unknown, unknown, unknown]> = [
      ['handle upper case', 'Ab1', good, 10],
      ['handle one character', 'a', good, 10],
      ['handle starts with a digit', '1abc', good, 10],
      ['handle 17 characters', `a${'b'.repeat(16)}`, good, 10],
      ['handle with a hyphen', 'ab-c', good, 10],
      ['handle with an underscore', 'ab_c', good, 10],
      ['handle with a quote', "ab'c", good, 10],
      ['handle null', null, good, 10],
      ['verifier is a password', handle, 'correct horse battery staple', 10],
      ['verifier is md5', handle, `md5${'0123456789abcdef'.repeat(2)}`, 10],
      ['verifier with 1000 iterations', handle, `SCRAM-SHA-256$1000:${salt}$${storedKey}:${serverKey}`, 10],
      ['verifier with a short key', handle, `SCRAM-SHA-256$4096:${salt}$${storedKey.slice(1)}:${serverKey}`, 10],
      ['verifier without a server key', handle, `SCRAM-SHA-256$4096:${salt}$${storedKey}`, 10],
      ['verifier with a suffix', handle, `${good}x`, 10],
      ['verifier with a bad salt', handle, `SCRAM-SHA-256$4096:${salt}!$${storedKey}:${serverKey}`, 10],
      ['verifier with a quote', handle, `${good}'`, 10],
      ['verifier null', handle, null, 10],
      ['zero days', handle, good, 0],
      ['91 days', handle, good, 91],
      ['negative days', handle, good, -1],
      ['days null', handle, good, null],
    ];
    const results: Record<string, { code?: string; echoed: boolean } | null> = {};
    for (const [label, h, v, d] of cases) {
      for (const procedure of ['provision_person', 'renew_person']) {
        const { notices, error } = await callAsMaster(`CALL jale_ops.${procedure}($1, $2, $3)`, [h, v, d]);
        const text = [error?.message ?? '', ...notices].join('\n');
        results[`${procedure}: ${label}`] = error && {
          code: error.code,
          echoed: [h, v].some((x) => typeof x === 'string' && x.length > 1 && text.includes(x)),
        };
      }
    }
    expect(results).toEqual(Object.fromEntries(cases.flatMap(([label]) => [
      [`provision_person: ${label}`, { code: '22023', echoed: false }],
      [`renew_person: ${label}`, { code: '22023', echoed: false }],
    ])));
    for (const h of ['Ab1', handle]) expect(await loginShape(su, `jale_person_${h}`)).toBeNull();
    expect((await callAsMaster('CALL jale_ops.remove_person($1)', ['Ab-1'])).error?.code).toBe('22023');
  });

  it('only the master may run them', async () => {
    const operator = `jale_person_${uniqueHandle('nocall')}`;
    const password = throwawayPassword();
    created.add(operator);
    await withLoginClient(MASTER, (m) => createOperatorLoginByHand(m, operator, scramVerifier(password)));
    const verifier = scramVerifier(throwawayPassword());
    const codes: Record<string, string | undefined> = {};
    const c = await connectAs(personUrl(databaseUrl as string, operator, password));
    try {
      codes.operator = (await failure(() => c.query('CALL jale_ops.provision_person($1, $2, $3)', [uniqueHandle('x'), verifier, 1])))?.code;
    } finally {
      await c.end();
    }
    for (const login of ['jale_api', 'jale_admin_console', 'jale_job_audit_export']) {
      codes[login] = await withLoginClient(login, async (l) =>
        (await failure(() => l.query('CALL jale_ops.remove_person($1)', [operator.slice('jale_person_'.length)])))?.code);
    }
    expect(codes).toEqual({ operator: '42501', jale_api: '42501', jale_admin_console: '42501', jale_job_audit_export: '42501' });
    expect(await loginShape(su, operator)).not.toBeNull();
    // The master's own call goes through.
    expect((await callAsMaster('CALL jale_ops.remove_person($1)', [operator.slice('jale_person_'.length)])).error).toBeNull();
    expect(await loginShape(su, operator)).toBeNull();
  });
});
