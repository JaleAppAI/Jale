/**
 * audit-ops.ts -- helpers for the operator-function suite
 * (audit-ops.integration.test.ts): the operator functions and procedures by
 * signature, a SCRAM-SHA-256 verifier computed the way a person computes
 * theirs, throwaway credentials, and the catalog shape of a personal
 * operator login.
 *
 * Throwaway passwords are random per run and never logged. Handles are random
 * per run, so a login one run leaves behind never collides with the next.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto';
import type { ClientBase } from 'pg';

/** The operator read functions and who may execute each, besides the owner. */
export const OPS_FUNCTIONS: ReadonlyArray<{ signature: string; execute: readonly string[] }> = Object.freeze([
  { signature: 'jale_ops.audit_event_counts(timestamp with time zone)', execute: ['jale_admin', 'jale_ops_readonly'] },
  { signature: 'jale_ops.audit_export_status()', execute: ['jale_admin', 'jale_ops_readonly'] },
  { signature: 'jale_ops.delivery_status(uuid)', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.find_user(text, text)', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.migration_ledger()', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.onboarding_status(uuid)', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.outbox_status(uuid)', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.trust_assessment_status(uuid)', execute: ['jale_ops_readonly'] },
  { signature: 'jale_ops.user_status(uuid)', execute: ['jale_ops_readonly'] },
]);

/** The count-only audit definers the two audit functions call. */
export const AUDIT_COUNT_FUNCTIONS: readonly string[] = Object.freeze([
  'jale_audit.event_counts(timestamp with time zone)',
  'jale_audit.export_status()',
]);

/** The personal-login procedures (the separable unit). */
export const PERSON_PROCEDURES: readonly string[] = Object.freeze([
  'jale_ops.provision_person(text, text, integer)',
  'jale_ops.remove_person(text)',
  'jale_ops.renew_person(text, text, integer)',
]);

/** A random throwaway password: 48 hex characters. Never log it. */
export function throwawayPassword(): string {
  return randomBytes(24).toString('hex');
}

/** A random handle of the accepted shape, unique to this run. */
export function uniqueHandle(prefix: string): string {
  if (!/^[a-z][a-z0-9]{0,7}$/.test(prefix)) throw new Error('uniqueHandle: bad prefix');
  const tail = randomBytes(8).toString('hex').replace(/[^a-z0-9]/g, '');
  return `${prefix}${tail}`.slice(0, 16);
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form PostgreSQL stores:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (RFC 5802,
 * RFC 7677). Passwords here are ASCII, so SASLprep leaves them unchanged.
 */
export function scramVerifier(password: string, iterations = 4096, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** A connection URL for `login` with `password`, on the same local bed as `baseUrl`. */
export function personUrl(baseUrl: string, login: string, password: string): string {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('audit-ops: refusing a database that is not a local test bed');
  }
  url.username = login;
  url.password = password;
  return url.toString();
}

/** What the catalog says about one login: everything the accepted operator shape fixes. */
export interface LoginShape {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  valid_until_set: boolean;
  member_of: Array<{ granted: string; admin: boolean; inherit: boolean; set: boolean }>;
  members: Array<{ member: string; admin: boolean; inherit: boolean; set: boolean }>;
  settings: string[];
  database_settings: number;
  owned: number;
  privileges: number;
}

/** Reads `login`'s shape as the superuser; null when the role does not exist. */
export async function loginShape(su: ClientBase, login: string): Promise<LoginShape | null> {
  const { rows } = await su.query<LoginShape>(
    `SELECT r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
            r.rolconnlimit,
            (r.rolvaliduntil IS NOT NULL AND r.rolvaliduntil <> 'infinity') AS valid_until_set,
            (SELECT COALESCE(json_agg(json_build_object('granted', g.rolname, 'admin', am.admin_option,
                                                        'inherit', am.inherit_option, 'set', am.set_option)
                                      ORDER BY g.rolname), '[]'::json)
               FROM pg_catalog.pg_auth_members am JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
              WHERE am.member = r.oid) AS member_of,
            (SELECT COALESCE(json_agg(json_build_object('member', m.rolname, 'admin', am.admin_option,
                                                        'inherit', am.inherit_option, 'set', am.set_option)
                                      ORDER BY m.rolname), '[]'::json)
               FROM pg_catalog.pg_auth_members am JOIN pg_catalog.pg_roles m ON m.oid = am.member
              WHERE am.roleid = r.oid) AS members,
            (SELECT COALESCE(array_agg(s ORDER BY s), '{}')
               FROM pg_catalog.pg_db_role_setting drs, unnest(drs.setconfig) s
              WHERE drs.setrole = r.oid AND drs.setdatabase = 0) AS settings,
            (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting drs
              WHERE drs.setrole = r.oid AND drs.setdatabase <> 0) AS database_settings,
            (SELECT count(*)::int FROM pg_catalog.pg_shdepend d
              WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o') AS owned,
            (SELECT count(*)::int FROM pg_catalog.pg_shdepend d
              WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'a') AS privileges
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = $1`,
    [login],
  );
  return rows[0] ?? null;
}

/** The accepted operator shape for a login the master created. */
export function acceptedOperatorShape(master: string): Omit<LoginShape, 'settings'> {
  return {
    rolcanlogin: true, rolsuper: false, rolinherit: true, rolcreaterole: false, rolcreatedb: false,
    rolreplication: false, rolbypassrls: false, rolconnlimit: 2, valid_until_set: true,
    member_of: [{ granted: 'jale_ops_readonly', admin: false, inherit: true, set: false }],
    // PostgreSQL 16 gives the creating CREATEROLE login an ADMIN-only row in
    // the new role; nothing else.
    members: [{ member: master, admin: true, inherit: false, set: false }],
    database_settings: 0,
    owned: 0,
    privileges: 0,
  };
}

/** The role settings every operator login carries on a bed without pgaudit. */
export const OPERATOR_SETTINGS: readonly string[] = Object.freeze([
  'default_transaction_read_only=on',
  'statement_timeout=30s',
]);

/**
 * Creates an operator login by hand, as the master, in the accepted shape the
 * person procedures also produce; used by the checks that must not depend on
 * those procedures.
 */
export async function createOperatorLoginByHand(master: ClientBase, login: string, verifier: string): Promise<void> {
  if (!/^jale_person_[a-z][a-z0-9]{1,15}$/.test(login)) throw new Error('audit-ops: not an operator login name');
  const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  // CREATE ROLE takes no bind parameters; both literals are validated shapes.
  await master.query(
    `CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
       CONNECTION LIMIT 2 VALID UNTIL '${until}' PASSWORD '${verifier}'`,
  );
  await master.query(`GRANT jale_ops_readonly TO ${login} WITH INHERIT TRUE, SET FALSE`);
  await master.query(`ALTER ROLE ${login} SET default_transaction_read_only = on`);
  await master.query(`ALTER ROLE ${login} SET statement_timeout = '30s'`);
}

/** Every string in `value`, depth first: the text an operator would see. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value instanceof Date) out.push(value.toISOString());
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}
