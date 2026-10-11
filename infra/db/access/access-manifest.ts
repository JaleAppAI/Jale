/**
 * The access manifest: the reviewed, human-edited source of truth for which
 * database login may reach which object (infra/db/access/manifest.json, plus
 * every infra/db/access/manifest.d/*.json fragment).
 *
 * Consumers:
 *   - generate.ts writes migration 106's grants and policies from it;
 *   - the coverage guard (test/unit/db/least-privilege-coverage) fails when
 *     the catalog and the manifest disagree;
 *   - posture.ts evaluates a catalog-only snapshot against it, in the test
 *     suites and in the scheduled posture check.
 *
 * FRAGMENTS. A change that adds objects puts them in its own fragment,
 * manifest.d/<name>.json, instead of editing manifest.json. A fragment has the
 * same top-level sections and only adds entries; a key that already exists, in
 * manifest.json or in an earlier fragment, is a hard error. Fragments merge in
 * filename order, and their `exceptions` are appended. A fragment's own
 * `policies` are on tables it defines itself.
 *
 * To add rights to an object another file defines, a fragment uses an
 * additions section, each entry with its own `reason`:
 *   - table_additions.<schema.table>: new grantees in `access`, new policy
 *     names in `policies`, and at most one `owner` for a master-owned table;
 *   - function_additions.<signature>: new `execute` grantees;
 *   - schema_additions.<schema>: new `usage` and `create` grantees;
 *   - sequence_additions.<schema.sequence>: new `usage`, `select` and
 *     `update` grantees.
 * An existing grantee or policy name, any other field (rls flags,
 * classification, the entry's own reason), runtime-login access to an
 * excluded table, or a target that manifest.json and the earlier fragments do
 * not define is a hard error. The merged manifest has every addition folded
 * into its target, so consumers never see an additions section.
 *
 * This module only reads, merges and validates the files. It has no database
 * or network dependency. A bundle that cannot ship the directory passes the
 * merged result instead: `parseManifest(<JSON.stringify(loadManifest())>)`.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';


/** Who a login serves. Every kind is a runtime login. */
export type LoginKind =
  | 'request' // the authenticated worker and employer request paths
  | 'public' // the unauthenticated tokenized endpoints
  | 'job' // one scheduled or event-driven background job
  | 'posture' // the catalog-only posture check
  | 'service'; // a service login that predates the dedicated logins (migration 104)

export interface LoginEntry {
  kind: LoginKind;
  /** The migration that creates the login, e.g. "104", or "pre-104". */
  created_by: string;
  /** `rolconnlimit`; -1 means no limit. */
  connection_limit: number;
  /**
   * Present, and true, on every login a least-privilege migration creates:
   * credential preparation (scripts/run-migrations.sh --prepare-logins)
   * prepares a secret for exactly these logins, and the ops host's secret
   * access is derived from the same set. Absent on the service logins that
   * predate them, whose secrets are managed as before. Every kind except
   * `service` requires it; `service` forbids it.
   */
  prepare_secret?: true;
  /**
   * Role-level settings (`ALTER ROLE ... SET name = value`), exactly as
   * pg_db_role_setting stores them. The guard holds every login to exactly
   * these, none scoped to one database.
   */
  settings?: Record<string, string>;
  /** The workloads that connect as this login (prose, no identifiers). */
  workloads: string;
  reason: string;
}

/**
 * A role the database service itself creates and manages (never a migration),
 * accepted by the posture check and the guard only when present. The
 * bootstrap superuser (OID 10) is accepted without being listed.
 */
export interface PlatformRoleEntry {
  reason: string;
}

export interface CapabilityOwnerEntry {
  created_by: string;
  reason: string;
}

export interface GrantOptions {
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

/** The only member grant the operator group accepts. */
export const OPERATOR_GRANT_OPTIONS: Readonly<GrantOptions> = Object.freeze({ admin: false, inherit: true, set: false });

export interface GroupEntry {
  created_by: string;
  reason: string;
  /** Rules every member of the group must satisfy. */
  member_rules: {
    only_this_group: boolean;
    valid_until_required: boolean;
    write_grants_allowed: boolean;
    /**
     * The one accepted membership shape:
     * `GRANT <group> TO <member> WITH INHERIT TRUE, SET FALSE` (no ADMIN).
     */
    grant_options: GrantOptions;
  };
}

/** A pre-existing NOLOGIN role that owns an internal schema or helper. */
export interface HelperRoleEntry {
  reason: string;
}

export interface TableRls {
  enabled: boolean;
  forced: boolean;
}

export type TableClassification = 'access' | 'excluded';

/** `"*"` is the whole table; a list is a column-scoped grant. */
export type ColumnSet = '*' | string[];

/** Table privileges of one role. Rows are still filtered by the policies section. */
export interface TableLoginAccess {
  select?: ColumnSet;
  insert?: ColumnSet;
  update?: ColumnSet;
  delete?: boolean;
  /** Held only by service logins that predate the dedicated ones; the guard forbids them on any other role. */
  truncate?: boolean;
  references?: boolean;
  trigger?: boolean;
  reason?: string;
}

export interface TableEntry {
  classification: TableClassification;
  rls: TableRls;
  reason: string;
  /**
   * Privileges per runtime login or capability owner. An excluded table lists
   * no runtime login; a capability owner may still hold rights on it.
   */
  access: Record<string, TableLoginAccess>;
  /** The owning role when it is not the master: a capability owner or a helper role. */
  owner?: string;
  /**
   * Present, and true, on a table the migration runner creates on the
   * databases it manages (its ledger). Test beds never have it, so its
   * absence from a catalog is expected; when present it is checked like any
   * other table.
   */
  runner_managed?: true;
}

/** A role name, or `PUBLIC`. */
export type Grantee = string;

export interface SchemaEntry {
  owner: string;
  /** Grantees of USAGE and CREATE, besides the owner. */
  usage: Grantee[];
  create: Grantee[];
  reason: string;
}

export interface SequenceEntry {
  owner: string;
  usage: Grantee[];
  select: Grantee[];
  update: Grantee[];
  reason: string;
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
/** existing: created by a migration as written; copy: generated from another policy; new: generated from this entry. */
export type PolicyOrigin = 'existing' | 'copy' | 'new';

export interface PolicyEntry {
  command: PolicyCommand;
  permissive: boolean;
  /** Role names, or `PUBLIC` for a policy with no TO clause. */
  to: Grantee[];
  origin: PolicyOrigin;
  /** origin copy: the source policy's name, on the same table. */
  copy_of?: string;
  /**
   * The expressions, exactly as pg_get_expr() shows them with
   * `search_path = public` on PostgreSQL 16. Required for origin new, for
   * every copy source and for every capability owner's policy, fragments
   * included: the coverage guard and the posture check compare a recorded
   * expression byte for byte, and a copy with its source.
   */
  using?: string | null;
  with_check?: string | null;
  /** True for an unrestricted policy (USING or WITH CHECK `true`), which must be reviewed as such. */
  open?: boolean;
  /** The reviewed verdict on a PUBLIC policy. */
  verdict?: 'keep';
  reason: string;
}

export type FunctionSecurity = 'definer' | 'invoker';
export type FunctionKind = 'function' | 'procedure';

export interface FunctionEntry {
  owner: string;
  security: FunctionSecurity;
  /** The pinned search_path, exactly as proconfig stores it, or null. */
  search_path: string | null;
  /** `pg_get_function_identity_arguments` output. */
  arguments: string;
  /** Absent for a function. */
  kind?: FunctionKind;
  /** `pg_get_function_result` output; null for a procedure, which has none. */
  returns: string | null;
  /** Logins and roles that hold EXECUTE, besides the owner. */
  execute: string[];
  /** The migration that creates the function, when a least-privilege migration does. */
  created_by?: string;
  reason: string;
}

export interface LoginException {
  workload: string;
  login: string;
  reason: string;
}

export interface AccessManifest {
  version: 1;
  /** The migration and ownership role. Never a runtime login. */
  master: string;
  logins: Record<string, LoginEntry>;
  capability_owners: Record<string, CapabilityOwnerEntry>;
  groups: Record<string, GroupEntry>;
  helper_roles: Record<string, HelperRoleEntry>;
  /** Roles the database service manages; see PlatformRoleEntry. */
  platform_roles: Record<string, PlatformRoleEntry>;
  /** Keyed `schema.table`. */
  tables: Record<string, TableEntry>;
  /** Keyed `schema.name(argtype, ...)` with `format_type` names. */
  functions: Record<string, FunctionEntry>;
  /** Keyed `schema.table.policy`. */
  policies: Record<string, PolicyEntry>;
  /** Keyed `schema.sequence`. */
  sequences: Record<string, SequenceEntry>;
  /** Keyed by schema name. */
  schemas: Record<string, SchemaEntry>;
  exceptions: LoginException[];
}

/** Every top-level section manifest.json may carry. */
const BASE_SECTIONS = [
  'version', 'master', 'logins', 'capability_owners', 'groups', 'helper_roles', 'platform_roles', 'tables',
  'functions', 'policies', 'sequences', 'schemas', 'exceptions',
] as const;
/** Sections a fragment uses to add to an entry another file defines. */
const ADDITION_SECTIONS = ['table_additions', 'function_additions', 'schema_additions', 'sequence_additions'] as const;

const LOGIN_KINDS: readonly LoginKind[] = ['request', 'public', 'job', 'posture', 'service'];
const CLASSIFICATIONS: readonly TableClassification[] = ['access', 'excluded'];
const POLICY_COMMANDS: readonly PolicyCommand[] = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const POLICY_ORIGINS: readonly PolicyOrigin[] = ['existing', 'copy', 'new'];
const IDENT = '[a-z_][a-z0-9_]*';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Structural validation. Throws one error listing every problem, so a broken
 * manifest is reported in full rather than one field at a time.
 */
export function parseManifest(raw: unknown): AccessManifest {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new Error('access manifest: not a JSON object');
  if (raw.version !== 1) problems.push('version must be 1');
  if (!nonEmptyString(raw.master)) problems.push('master must name the ownership role');

  for (const key of ['logins', 'capability_owners', 'groups', 'helper_roles', 'platform_roles', 'tables', 'functions', 'policies', 'sequences', 'schemas'] as const) {
    if (!isRecord(raw[key])) problems.push(`${key} must be an object`);
  }
  if (!Array.isArray(raw.exceptions)) problems.push('exceptions must be an array');
  for (const key of Object.keys(raw)) {
    if ((ADDITION_SECTIONS as readonly string[]).includes(key)) {
      problems.push(`${key} is a fragment section; manifest.json lists rights in the entries themselves`);
    } else if (!(BASE_SECTIONS as readonly string[]).includes(key)) {
      problems.push(`unknown section ${key}`);
    }
  }
  if (problems.length > 0) throw new Error(`access manifest: ${problems.join('; ')}`);

  const logins = raw.logins as Record<string, unknown>;
  for (const [name, entry] of Object.entries(logins)) {
    if (!isRecord(entry)) { problems.push(`logins.${name} must be an object`); continue; }
    if (!LOGIN_KINDS.includes(entry.kind as LoginKind)) problems.push(`logins.${name}.kind is invalid`);
    if (!nonEmptyString(entry.created_by)) problems.push(`logins.${name}.created_by is missing`);
    if (!Number.isInteger(entry.connection_limit) || (entry.connection_limit as number) < -1) {
      problems.push(`logins.${name}.connection_limit must be an integer >= -1`);
    }
    if (entry.kind === 'service') {
      if ('prepare_secret' in entry) problems.push(`logins.${name}.prepare_secret must be absent for a service login`);
    } else if (LOGIN_KINDS.includes(entry.kind as LoginKind) && entry.prepare_secret !== true) {
      problems.push(`logins.${name}.prepare_secret must be true for a ${String(entry.kind)} login`);
    }
    if ('settings' in entry) {
      if (!isRecord(entry.settings)) {
        problems.push(`logins.${name}.settings must map setting names to values`);
      } else {
        for (const [setting, value] of Object.entries(entry.settings)) {
          if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(setting)) {
            problems.push(`logins.${name}.settings: ${setting} is not a setting name`);
          } else if (!nonEmptyString(value)) {
            problems.push(`logins.${name}.settings.${setting} must be a non-empty string`);
          }
        }
      }
    }
    if (!nonEmptyString(entry.workloads)) problems.push(`logins.${name}.workloads is missing`);
    if (!nonEmptyString(entry.reason)) problems.push(`logins.${name}.reason is missing`);
    if (name === raw.master) problems.push(`logins.${name}: the master is never a runtime login`);
  }

  for (const section of ['capability_owners', 'groups', 'helper_roles'] as const) {
    for (const [name, entry] of Object.entries(raw[section] as Record<string, unknown>)) {
      if (!isRecord(entry) || !nonEmptyString(entry.reason)) problems.push(`${section}.${name}.reason is missing`);
      if (name in logins) problems.push(`${section}.${name} is also listed as a login`);
    }
  }

  const managed: Array<[string, string]> = [
    ['logins', 'a login'], ['capability_owners', 'a capability owner'], ['groups', 'a group'], ['helper_roles', 'a helper role'],
  ];
  for (const [name, entry] of Object.entries(raw.platform_roles as Record<string, unknown>)) {
    if (!isRecord(entry) || !nonEmptyString(entry.reason)) problems.push(`platform_roles.${name}.reason is missing`);
    if (name === raw.master) problems.push(`platform_roles.${name} is the master`);
    for (const [section, noun] of managed) {
      if (name in (raw[section] as Record<string, unknown>)) problems.push(`platform_roles.${name} is also listed as ${noun}`);
    }
  }

  for (const [name, entry] of Object.entries(raw.groups as Record<string, unknown>)) {
    const rules = isRecord(entry) ? entry.member_rules : undefined;
    if (!isRecord(rules)) { problems.push(`groups.${name}.member_rules must be an object`); continue; }
    for (const rule of ['only_this_group', 'valid_until_required', 'write_grants_allowed'] as const) {
      if (typeof rules[rule] !== 'boolean') problems.push(`groups.${name}.member_rules.${rule} must be a boolean`);
    }
    const grant = rules.grant_options;
    if (!isRecord(grant) || Object.keys(grant).length !== 3
        || grant.admin !== OPERATOR_GRANT_OPTIONS.admin
        || grant.inherit !== OPERATOR_GRANT_OPTIONS.inherit
        || grant.set !== OPERATOR_GRANT_OPTIONS.set) {
      problems.push(`groups.${name}.member_rules.grant_options must be { admin: false, inherit: true, set: false }`);
    }
  }

  for (const [name, entry] of Object.entries(raw.tables as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name)) problems.push(`tables.${name}: key must be schema.table`);
    if (!isRecord(entry)) { problems.push(`tables.${name} must be an object`); continue; }
    if (!CLASSIFICATIONS.includes(entry.classification as TableClassification)) {
      problems.push(`tables.${name}.classification must be access or excluded`);
    }
    if (!nonEmptyString(entry.reason)) problems.push(`tables.${name}.reason is missing`);
    const rls = entry.rls;
    if (!isRecord(rls) || typeof rls.enabled !== 'boolean' || typeof rls.forced !== 'boolean') {
      problems.push(`tables.${name}.rls must carry boolean enabled and forced`);
    }
    if (!isRecord(entry.access)) {
      problems.push(`tables.${name}.access must be an object`);
    } else {
      for (const role of Object.keys(entry.access)) {
        if (!(role in logins) && !(role in (raw.capability_owners as Record<string, unknown>))) {
          problems.push(`tables.${name}.access names unknown role ${role}`);
        }
        if (entry.classification === 'excluded' && role in logins) {
          problems.push(`tables.${name} is excluded but grants runtime login ${role}`);
        }
      }
    }
    if ('owner' in entry && !(entry.owner === raw.master
        || (typeof entry.owner === 'string' && (entry.owner in (raw.capability_owners as Record<string, unknown>)
          || entry.owner in (raw.helper_roles as Record<string, unknown>))))) {
      problems.push(`tables.${name}.owner must be the master, a capability owner or a helper role`);
    }
    if ('runner_managed' in entry && entry.runner_managed !== true) {
      problems.push(`tables.${name}.runner_managed must be true when present`);
    }
  }

  const grantees = new Set([
    ...Object.keys(logins),
    ...Object.keys(raw.capability_owners as Record<string, unknown>),
    ...Object.keys(raw.groups as Record<string, unknown>),
    ...Object.keys(raw.helper_roles as Record<string, unknown>),
    raw.master as string,
    'PUBLIC',
  ]);
  const checkGrantees = (where: string, list: unknown) => {
    if (!Array.isArray(list)) { problems.push(`${where} must be an array`); return; }
    for (const grantee of list) {
      if (!grantees.has(grantee as string)) problems.push(`${where} names unknown role ${String(grantee)}`);
    }
  };
  for (const [signature, entry] of Object.entries(raw.functions as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\(.*\)$/.test(signature)) {
      problems.push(`functions.${signature}: key must be schema.name(argtypes)`);
    }
    if (!isRecord(entry)) { problems.push(`functions.${signature} must be an object`); continue; }
    if (!nonEmptyString(entry.owner)) problems.push(`functions.${signature}.owner is missing`);
    if (entry.security !== 'definer' && entry.security !== 'invoker') {
      problems.push(`functions.${signature}.security must be definer or invoker`);
    }
    if (!(entry.search_path === null || nonEmptyString(entry.search_path))) {
      problems.push(`functions.${signature}.search_path must be a string or null`);
    }
    if (typeof entry.arguments !== 'string') problems.push(`functions.${signature}.arguments is missing`);
    if ('kind' in entry && entry.kind !== undefined && entry.kind !== 'function' && entry.kind !== 'procedure') {
      problems.push(`functions.${signature}.kind must be function or procedure`);
    } else if (entry.kind === 'procedure') {
      if (entry.returns !== null) problems.push(`functions.${signature}.returns must be null for a procedure`);
    } else if (!nonEmptyString(entry.returns)) {
      problems.push(`functions.${signature}.returns is missing`);
    }
    checkGrantees(`functions.${signature}.execute`, entry.execute);
    if (!nonEmptyString(entry.reason)) problems.push(`functions.${signature}.reason is missing`);
  }

  for (const [name, entry] of Object.entries(raw.schemas as Record<string, unknown>)) {
    if (!new RegExp(`^${IDENT}$`).test(name)) problems.push(`schemas.${name}: key must be a schema name`);
    if (!isRecord(entry)) { problems.push(`schemas.${name} must be an object`); continue; }
    if (!nonEmptyString(entry.owner)) problems.push(`schemas.${name}.owner is missing`);
    checkGrantees(`schemas.${name}.usage`, entry.usage);
    checkGrantees(`schemas.${name}.create`, entry.create);
    if (!nonEmptyString(entry.reason)) problems.push(`schemas.${name}.reason is missing`);
  }

  for (const [name, entry] of Object.entries(raw.sequences as Record<string, unknown>)) {
    if (!new RegExp(`^${IDENT}\\.${IDENT}$`).test(name)) problems.push(`sequences.${name}: key must be schema.sequence`);
    if (!isRecord(entry)) { problems.push(`sequences.${name} must be an object`); continue; }
    if (!nonEmptyString(entry.owner)) problems.push(`sequences.${name}.owner is missing`);
    for (const privilege of ['usage', 'select', 'update'] as const) checkGrantees(`sequences.${name}.${privilege}`, entry[privilege]);
    if (!nonEmptyString(entry.reason)) problems.push(`sequences.${name}.reason is missing`);
  }

  const policies = raw.policies as Record<string, unknown>;
  // A copy is compared with its source, so the source's own expressions are
  // the reviewed ones; a capability owner's policy is reviewed the same way.
  const copySources = new Set<string>();
  for (const [key, entry] of Object.entries(policies)) {
    if (isRecord(entry) && entry.origin === 'copy' && nonEmptyString(entry.copy_of)) {
      copySources.add(`${key.split('.').slice(0, 2).join('.')}.${entry.copy_of}`);
    }
  }
  const capabilityOwners = raw.capability_owners as Record<string, unknown>;
  for (const [key, entry] of Object.entries(policies)) {
    const where = `policies.${key}`;
    const match = new RegExp(`^(${IDENT})\\.(${IDENT})\\.(${IDENT})$`).exec(key);
    if (!match) { problems.push(`${where}: key must be schema.table.policy`); continue; }
    const table = `${match[1]}.${match[2]}`;
    if (!(table in (raw.tables as Record<string, unknown>))) problems.push(`${where}: table ${table} is not classified`);
    if (Buffer.byteLength(match[3], 'utf8') > 63) problems.push(`${where}: the policy name is longer than 63 bytes`);
    if (!isRecord(entry)) { problems.push(`${where} must be an object`); continue; }
    if (!POLICY_COMMANDS.includes(entry.command as PolicyCommand)) problems.push(`${where}.command is invalid`);
    if (typeof entry.permissive !== 'boolean') problems.push(`${where}.permissive must be a boolean`);
    checkGrantees(`${where}.to`, entry.to);
    if (!POLICY_ORIGINS.includes(entry.origin as PolicyOrigin)) problems.push(`${where}.origin must be existing, copy or new`);
    if (entry.origin === 'copy') {
      if (!nonEmptyString(entry.copy_of)) {
        problems.push(`${where}: a copy needs copy_of`);
      } else {
        const source = policies[`${table}.${entry.copy_of}`];
        if (!isRecord(source) || source.origin !== 'existing') {
          problems.push(`${where}: copy_of names no existing policy ${table}.${entry.copy_of}`);
        }
      }
    }
    if (entry.origin === 'existing' && (entry.using !== undefined || entry.with_check !== undefined)) {
      for (const e of [entry.using, entry.with_check]) {
        if (!(e === null || nonEmptyString(e))) problems.push(`${where}: a recorded using and with_check must both be text or null`);
      }
    }
    if (entry.origin === 'existing' && (entry.using === undefined || entry.with_check === undefined)) {
      if (copySources.has(key)) problems.push(`${where}: a copy source must record its using and with_check`);
      if (Array.isArray(entry.to)
          && entry.to.some((role) => typeof role === 'string' && Object.prototype.hasOwnProperty.call(capabilityOwners, role))) {
        problems.push(`${where}: a capability owner's policy must record its using and with_check`);
      }
    }
    if (entry.origin === 'new') {
      const exprs = [entry.using, entry.with_check];
      if (!exprs.some((e) => nonEmptyString(e))) problems.push(`${where}: a new policy needs using or with_check`);
      for (const e of exprs) {
        if (!(e === undefined || e === null || nonEmptyString(e))) problems.push(`${where}: using and with_check must be text or null`);
      }
      if (exprs.some((e) => typeof e === 'string' && e.trim() === 'true') && entry.open !== true) {
        problems.push(`${where}: an unrestricted policy must carry open: true`);
      }
    }
    if (!nonEmptyString(entry.reason)) problems.push(`${where}.reason is missing`);
  }

  for (const [index, entry] of (raw.exceptions as unknown[]).entries()) {
    if (!isRecord(entry) || !nonEmptyString(entry.workload) || !nonEmptyString(entry.login) || !nonEmptyString(entry.reason)) {
      problems.push(`exceptions[${index}] needs workload, login and reason`);
    } else if (!(entry.login in logins)) {
      problems.push(`exceptions[${index}] names unknown login ${entry.login}`);
    }
  }

  if (problems.length > 0) throw new Error(`access manifest: ${problems.join('; ')}`);
  return raw as unknown as AccessManifest;
}

/** The keyed sections a fragment may add entries to. */
const KEYED_SECTIONS = [
  'logins', 'capability_owners', 'groups', 'helper_roles', 'platform_roles', 'tables', 'functions', 'policies',
  'sequences', 'schemas',
] as const;
/** Sections only manifest.json may set. */
const BASE_ONLY = ['version', 'master'] as const;

/**
 * What each additions section may add to its target, by field: a map of new
 * entries (`access`, `policies`), lists of new grantees, or a single owner.
 */
const ADDITION_RULES: Record<(typeof ADDITION_SECTIONS)[number], {
  section: 'tables' | 'functions' | 'schemas' | 'sequences';
  noun: string;
  lists: readonly string[];
  maps: readonly string[];
  allowed: string;
}> = {
  table_additions: { section: 'tables', noun: 'table', lists: [], maps: ['access', 'policies'], allowed: 'access, policies and owner' },
  function_additions: { section: 'functions', noun: 'function', lists: ['execute'], maps: [], allowed: 'execute' },
  schema_additions: { section: 'schemas', noun: 'schema', lists: ['usage', 'create'], maps: [], allowed: 'usage and create' },
  sequence_additions: { section: 'sequences', noun: 'sequence', lists: ['usage', 'select', 'update'], maps: [], allowed: 'usage, select and update' },
};

export interface ManifestFragment {
  /** The fragment's file name, used in error messages. */
  name: string;
  raw: unknown;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Pure: merges fragments into a copy of `base`, in the order given. Every
 * problem is reported in one error; the result still needs parseManifest().
 *
 * A fragment's keyed sections add new entries. Its additions sections add to
 * entries manifest.json or an earlier fragment defines: new grantees, new
 * policy names, or one re-own of a master-owned table. The result has every
 * addition folded into its target, and no additions section.
 */
export function mergeManifest(base: unknown, fragments: readonly ManifestFragment[]): unknown {
  if (!isRecord(base)) throw new Error('access manifest: manifest.json is not a JSON object');
  const merged: Record<string, unknown> = clone(base);
  const problems: string[] = [];
  const sectionOf = (name: string): Record<string, unknown> => {
    if (!isRecord(merged[name])) merged[name] = {};
    return merged[name] as Record<string, unknown>;
  };

  for (const fragment of fragments) {
    const where = `manifest.d/${fragment.name}`;
    if (!isRecord(fragment.raw)) { problems.push(`${where}: not a JSON object`); continue; }
    const raw = fragment.raw;
    const definedHere = new Map<string, Set<string>>();

    // Pass 1: the fragment's own entries.
    for (const [section, value] of Object.entries(raw)) {
      if ((BASE_ONLY as readonly string[]).includes(section)) {
        problems.push(`${where}: ${section} belongs to manifest.json only`);
      } else if (section === 'exceptions') {
        if (!Array.isArray(value)) { problems.push(`${where}: exceptions must be an array`); continue; }
        const target = Array.isArray(merged.exceptions) ? merged.exceptions : [];
        merged.exceptions = [...target, ...clone(value)];
      } else if ((KEYED_SECTIONS as readonly string[]).includes(section)) {
        if (!isRecord(value)) { problems.push(`${where}: ${section} must be an object`); continue; }
        const target = sectionOf(section);
        const keys = new Set<string>();
        for (const [key, entry] of Object.entries(value)) {
          if (Object.prototype.hasOwnProperty.call(target, key)) {
            problems.push(`${where}: ${section}.${key} already exists`);
          } else {
            target[key] = clone(entry);
            keys.add(key);
          }
        }
        definedHere.set(section, keys);
      } else if (!(ADDITION_SECTIONS as readonly string[]).includes(section)) {
        problems.push(`${where}: unknown section ${section}`);
      }
    }

    // A fragment's own policies are on its own tables; policies on any other
    // table go through table_additions, so every addition is explicit.
    const ownTables = definedHere.get('tables') ?? new Set<string>();
    for (const key of definedHere.get('policies') ?? []) {
      const table = key.split('.').slice(0, 2).join('.');
      if (ownTables.has(table)) continue;
      if (Object.prototype.hasOwnProperty.call(sectionOf('tables'), table)) {
        problems.push(`${where}: policies.${key}: ${table} is defined outside this fragment; add the policy through table_additions`);
      } else {
        problems.push(`${where}: policies.${key}: ${table} is not a table of this fragment`);
      }
    }

    // Pass 2: additions to entries defined elsewhere.
    for (const section of ADDITION_SECTIONS) {
      if (!(section in raw)) continue;
      const value = raw[section];
      if (!isRecord(value)) { problems.push(`${where}: ${section} must be an object`); continue; }
      const rule = ADDITION_RULES[section];
      const targets = sectionOf(rule.section);
      for (const [key, addition] of Object.entries(value)) {
        const at = `${where}: ${section}.${key}`;
        if (!isRecord(addition)) { problems.push(`${at} must be an object`); continue; }
        if (!nonEmptyString(addition.reason)) problems.push(`${at}.reason is missing`);
        for (const field of Object.keys(addition)) {
          const known = field === 'reason' || rule.lists.includes(field) || rule.maps.includes(field)
            || (section === 'table_additions' && field === 'owner');
          if (!known) problems.push(`${at}.${field}: only ${rule.allowed} can be added`);
        }
        if (definedHere.get(rule.section)?.has(key)) {
          problems.push(`${at}: ${key} is defined in this fragment; list the rights in its own entry`);
          continue;
        }
        const target = targets[key];
        if (!isRecord(target)) {
          problems.push(`${at}: no ${rule.noun} ${key} in manifest.json or an earlier fragment`);
          continue;
        }

        for (const field of rule.lists) {
          if (!(field in addition)) continue;
          const list = addition[field];
          if (!Array.isArray(list)) { problems.push(`${at}.${field} must be an array`); continue; }
          const current = Array.isArray(target[field]) ? target[field] as unknown[] : [];
          for (const grantee of list) {
            if (current.includes(grantee)) {
              problems.push(`${at}.${field}: ${String(grantee)} is already listed`);
            } else {
              current.push(grantee);
            }
          }
          target[field] = current;
        }

        if (section === 'table_additions') {
          if ('access' in addition) {
            if (!isRecord(addition.access)) {
              problems.push(`${at}.access must be an object`);
            } else {
              const access = isRecord(target.access) ? target.access : (target.access = {}) as Record<string, unknown>;
              const logins = sectionOf('logins');
              for (const [role, rights] of Object.entries(addition.access)) {
                if (Object.prototype.hasOwnProperty.call(access, role)) {
                  problems.push(`${at}.access.${role} already exists`);
                } else if (target.classification === 'excluded' && Object.prototype.hasOwnProperty.call(logins, role)) {
                  problems.push(`${at}.access.${role}: ${key} is excluded; no runtime login may be granted access to it`);
                } else {
                  access[role] = clone(rights);
                }
              }
            }
          }
          if ('policies' in addition) {
            if (!isRecord(addition.policies)) {
              problems.push(`${at}.policies must be an object`);
            } else {
              const policies = sectionOf('policies');
              for (const [name, policy] of Object.entries(addition.policies)) {
                const policyKey = `${key}.${name}`;
                if (Object.prototype.hasOwnProperty.call(policies, policyKey)) {
                  problems.push(`${at}.policies.${name} already exists`);
                } else {
                  policies[policyKey] = clone(policy);
                }
              }
            }
          }
          if ('owner' in addition) {
            if (typeof target.owner === 'string') {
              problems.push(`${at}.owner: ${key} is already owned by ${target.owner}`);
            } else {
              target.owner = clone(addition.owner);
            }
          }
        }
      }
    }
  }
  if (problems.length > 0) throw new Error(`access manifest: ${problems.join('; ')}`);
  return merged;
}

/** Reads manifest.json and every manifest.d/*.json fragment in `dir`, in filename order. */
export function readManifestFiles(dir: string): { base: unknown; fragments: ManifestFragment[] } {
  const parse = (file: string, label: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`access manifest: ${label} is missing`);
      throw new Error(`access manifest: ${label}: not valid JSON`);
    }
  };
  const base = parse(path.join(dir, 'manifest.json'), 'manifest.json');
  const fragmentDir = path.join(dir, 'manifest.d');
  const entries = fs.existsSync(fragmentDir) ? fs.readdirSync(fragmentDir).sort() : [];
  // A dot-named file is skipped by shell globs (credential preparation reads
  // manifest.d/*.json), so loading it here would let the two disagree.
  const hidden = entries.filter((name) => name.startsWith('.'));
  if (hidden.length > 0) {
    throw new Error(`access manifest: manifest.d holds dot-named files (${hidden.join(', ')}); shell globs skip them, so rename or remove them`);
  }
  const names = entries.filter((name) => name.endsWith('.json'));
  const fragments = names.map((name) => ({ name, raw: parse(path.join(fragmentDir, name), `manifest.d/${name}`) }));
  return { base, fragments };
}

/**
 * Loads, merges and validates the manifest in `dir` (by default the
 * directory of this module).
 */
export function loadManifest(dir: string = __dirname): AccessManifest {
  const { base, fragments } = readManifestFiles(dir);
  return parseManifest(mergeManifest(base, fragments));
}

/** Every runtime login: all logins, never the master or a NOLOGIN role. */
export function runtimeLogins(manifest: AccessManifest): string[] {
  return Object.keys(manifest.logins).sort();
}

/**
 * The dedicated least-privilege logins: every login with `prepare_secret:
 * true`. Credential preparation and the ops host's secret access use exactly
 * this set.
 */
export function dedicatedLogins(manifest: AccessManifest): string[] {
  return Object.entries(manifest.logins)
    .filter(([, entry]) => entry.prepare_secret === true)
    .map(([name]) => name)
    .sort();
}

/**
 * JSON with every object's keys sorted, at every level, and no whitespace.
 * Arrays keep their order. Two manifests with the same content always give
 * the same text, whatever order their keys were written in.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A stable identifier for a merged manifest: the sha256, in hex, of its
 * canonical JSON. The posture report carries it, so a result always says
 * which manifest it was checked against.
 */
export function manifestDigest(manifest: AccessManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}
