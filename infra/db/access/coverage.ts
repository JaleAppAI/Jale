/**
 * coverage.ts -- the coverage guard's catalog-versus-manifest checks, as a
 * pure function of a catalog snapshot (snapshot.ts readCatalog) and the
 * merged access manifest.
 *
 * Numbered as the guard's ten checks:
 *   1. every table, policy, function (procedures included), sequence and
 *      schema is classified, the manifest names nothing that does not exist
 *      (a runner-managed table may be absent), and every classified object
 *      has the owner and definition the manifest records; a copied policy is
 *      byte-equal to its source, and a policy whose expressions the manifest
 *      records is byte-equal to them (named under check 2 when it applies to
 *      a login, check 9 when it applies to a capability owner);
 *   2. no runtime login holds a grant, policy or EXECUTE the manifest does
 *      not list, or lacks one it does; PUBLIC holds no table right;
 *   3. no runtime login holds any right on an excluded table;
 *   4. a function called by a policy that applies to a login is executable
 *      by that login;
 *   6. every PUBLIC policy carries the reviewed `keep` verdict;
 *   9. no capability owner holds CREATE on public, or a right the manifest
 *      does not list.
 * Checks 5, 7, 8 and 10 (definers, login attributes and memberships,
 * capability-owner memberships, row-security flags) are the posture check's,
 * which the guard runs as well.
 *
 * Violations name objects and roles only.
 */
import type { AccessManifest, ColumnSet, PolicyEntry, TableLoginAccess } from './access-manifest';
import type { Acl, CatalogSnapshot } from './snapshot';

export interface CoverageViolation {
  check: 1 | 2 | 3 | 4 | 6 | 9;
  object: string;
  detail: string;
}

const TABLE_PRIVILEGES: ReadonlyArray<[keyof TableLoginAccess, string]> = [
  ['select', 'SELECT'], ['insert', 'INSERT'], ['update', 'UPDATE'], ['delete', 'DELETE'],
  ['truncate', 'TRUNCATE'], ['references', 'REFERENCES'], ['trigger', 'TRIGGER'],
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function holders(acl: Acl, privilege: string): string[] {
  return sorted(Object.entries(acl).filter(([, privileges]) => privileges.includes(privilege)).map(([grantee]) => grantee));
}

const list = (roles: readonly string[]) => (roles.length > 0 ? roles.join(', ') : 'nobody');

/** The table-level and column-level privileges a manifest access entry grants, as `PRIV` and `PRIV (col)`. */
function expectedTableRights(access: TableLoginAccess | undefined): Set<string> {
  const rights = new Set<string>();
  if (!access) return rights;
  for (const [field, privilege] of TABLE_PRIVILEGES) {
    const value = access[field] as ColumnSet | boolean | undefined;
    if (value === '*' || value === true) rights.add(privilege);
    else if (Array.isArray(value)) for (const column of value) rights.add(`${privilege} (${column})`);
  }
  return rights;
}

/** The rights `role` holds on a snapshot table, in the same notation. */
function actualTableRights(table: CatalogSnapshot['tables'][string], role: string): Set<string> {
  const rights = new Set<string>(table.acl[role] ?? []);
  for (const [column, acl] of Object.entries(table.column_acl)) {
    for (const privilege of acl[role] ?? []) rights.add(`${privilege} (${column})`);
  }
  return rights;
}

/** Whether a manifest policy records its expressions (every new policy, and an existing one that lists them). */
export function recordsExpressions(entry: PolicyEntry): boolean {
  return entry.origin === 'new' || entry.using !== undefined || entry.with_check !== undefined;
}

function policyShape(command: string, permissive: boolean, roles: readonly string[]): string {
  return `${command} ${permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} TO ${sorted(roles).join(', ')}`;
}

export function coverageViolations(catalog: CatalogSnapshot, manifest: AccessManifest): CoverageViolation[] {
  const out: CoverageViolation[] = [];
  const add = (check: CoverageViolation['check'], object: string, detail: string) => out.push({ check, object, detail });
  const logins = new Set(Object.keys(manifest.logins));
  const owners = new Set(Object.keys(manifest.capability_owners));
  /** The check a disagreement about these grantees belongs to. */
  const checkFor = (grantees: Iterable<string>): 1 | 2 | 9 => {
    const all = [...grantees];
    if (all.some((g) => logins.has(g) || g === 'PUBLIC')) return 2;
    if (all.some((g) => owners.has(g))) return 9;
    return 1;
  };

  // ── Schemas ──
  for (const name of sorted(Object.keys(catalog.schemas))) {
    const snap = catalog.schemas[name];
    const entry = manifest.schemas[name];
    if (!entry) { add(1, name, 'schema not classified in the manifest'); continue; }
    if (snap.owner !== entry.owner) add(1, name, `owner ${snap.owner}; the manifest says ${entry.owner}`);
    for (const [privilege, listed] of [['USAGE', entry.usage], ['CREATE', entry.create]] as const) {
      let held = holders(snap.acl, privilege);
      if (name === 'public' && privilege === 'CREATE') {
        for (const owner of held.filter((g) => owners.has(g))) {
          add(9, name, `capability owner ${owner} holds CREATE on public`);
        }
        held = held.filter((g) => !owners.has(g));
      }
      const expected = sorted(listed);
      if (held.join() !== expected.join()) {
        const differing = [...held.filter((g) => !expected.includes(g)), ...expected.filter((g) => !held.includes(g))];
        add(checkFor(differing), name, `${privilege} held by ${list(held)}; the manifest lists ${list(expected)}`);
      }
    }
  }
  for (const name of sorted(Object.keys(manifest.schemas))) {
    if (!catalog.schemas[name]) add(1, name, 'schema classified in the manifest but absent');
  }

  // ── Tables ──
  for (const name of sorted(Object.keys(catalog.tables))) {
    const snap = catalog.tables[name];
    const entry = manifest.tables[name];
    if (!entry) { add(1, name, 'table not classified in the manifest'); continue; }
    const owner = entry.owner ?? manifest.master;
    if (snap.owner !== owner) add(1, name, `owner ${snap.owner}; the manifest says ${owner}`);

    const grantees = new Set<string>([...Object.keys(snap.acl), ...Object.values(snap.column_acl).flatMap((acl) => Object.keys(acl))]);
    for (const privilege of snap.acl.PUBLIC ?? []) add(2, name, `PUBLIC holds ${privilege}`);
    for (const [column, acl] of Object.entries(snap.column_acl)) {
      for (const privilege of acl.PUBLIC ?? []) add(2, name, `PUBLIC holds ${privilege} (${column})`);
    }
    for (const role of sorted(new Set([...grantees, ...Object.keys(entry.access)]))) {
      if (!logins.has(role) && !owners.has(role)) continue;
      const actual = actualTableRights(snap, role);
      if (entry.classification === 'excluded' && logins.has(role)) {
        for (const right of sorted(actual)) add(3, name, `excluded, but ${role} holds ${right}`);
        continue;
      }
      const expected = expectedTableRights(entry.access[role]);
      const check = logins.has(role) ? 2 : 9;
      for (const right of sorted(actual)) {
        if (!expected.has(right)) add(check, name, `${role} holds ${right}; the manifest does not list it`);
      }
      for (const right of sorted(expected)) {
        if (!actual.has(right)) add(check, name, `${role} lacks ${right}, which the manifest lists`);
      }
    }
  }
  for (const name of sorted(Object.keys(manifest.tables))) {
    if (!catalog.tables[name] && manifest.tables[name].runner_managed !== true) {
      add(1, name, 'table classified in the manifest but absent');
    }
  }

  // ── Sequences ──
  for (const name of sorted(Object.keys(catalog.sequences))) {
    const snap = catalog.sequences[name];
    const entry = manifest.sequences[name];
    if (!entry) { add(1, name, 'sequence not classified in the manifest'); continue; }
    if (snap.owner !== entry.owner) add(1, name, `owner ${snap.owner}; the manifest says ${entry.owner}`);
    for (const [privilege, listed] of [['USAGE', entry.usage], ['SELECT', entry.select], ['UPDATE', entry.update]] as const) {
      const held = holders(snap.acl, privilege);
      const expected = sorted(listed);
      if (held.join() !== expected.join()) {
        const differing = [...held.filter((g) => !expected.includes(g)), ...expected.filter((g) => !held.includes(g))];
        add(checkFor(differing), name, `${privilege} held by ${list(held)}; the manifest lists ${list(expected)}`);
      }
    }
  }
  for (const name of sorted(Object.keys(manifest.sequences))) {
    if (!catalog.sequences[name]) add(1, name, 'sequence classified in the manifest but absent');
  }

  // ── Functions and procedures ──
  for (const name of sorted(Object.keys(catalog.functions))) {
    const snap = catalog.functions[name];
    const entry = manifest.functions[name];
    if (!entry) { add(1, name, `${snap.kind === 'procedure' ? 'procedure' : 'function'} not classified in the manifest`); continue; }
    const kind = entry.kind ?? 'function';
    const differs: string[] = [];
    if (snap.kind !== kind) differs.push('kind');
    if (snap.owner !== entry.owner) differs.push('owner');
    if (snap.security !== entry.security) differs.push('security');
    if (snap.search_path !== entry.search_path) differs.push('search_path');
    if (snap.arguments !== entry.arguments) differs.push('arguments');
    if ((snap.returns ?? null) !== (entry.returns ?? null)) differs.push('returns');
    if (differs.length > 0) add(1, name, `definition differs from the manifest: ${differs.join(', ')}`);
    const held = holders(snap.acl, 'EXECUTE');
    const expected = sorted(entry.execute);
    if (held.join() !== expected.join()) {
      const differing = [...held.filter((g) => !expected.includes(g)), ...expected.filter((g) => !held.includes(g))];
      add(checkFor(differing), name, `EXECUTE held by ${list(held)}; the manifest lists ${list(expected)}`);
    }
  }
  for (const name of sorted(Object.keys(manifest.functions))) {
    if (!catalog.functions[name]) add(1, name, 'function classified in the manifest but absent');
  }

  // ── Policies ──
  for (const key of sorted(Object.keys(catalog.policies))) {
    const snap = catalog.policies[key];
    const entry = manifest.policies[key];
    if (!entry) { add(1, key, 'policy not classified in the manifest'); continue; }
    const actualShape = policyShape(snap.command, snap.permissive, snap.roles);
    const expectedShape = policyShape(entry.command, entry.permissive, entry.to);
    if (actualShape !== expectedShape) {
      const differing = [...snap.roles.filter((r) => !entry.to.includes(r)), ...entry.to.filter((r) => !snap.roles.includes(r))];
      const check = differing.some((r) => logins.has(r) || r === 'PUBLIC') ? 2 : 1;
      add(check, key, `policy is ${actualShape}; the manifest says ${expectedShape}`);
    }
    if (entry.origin !== 'copy' && recordsExpressions(entry)) {
      // A recorded expression is compared byte for byte, as a copy is with its source.
      const check = snap.roles.some((r) => logins.has(r) || r === 'PUBLIC') ? 2
        : snap.roles.some((r) => owners.has(r)) ? 9 : 1;
      if (snap.using !== (entry.using ?? null)) add(check, key, 'USING differs from the manifest');
      if (snap.with_check !== (entry.with_check ?? null)) add(check, key, 'WITH CHECK differs from the manifest');
    }
    if (entry.origin === 'copy') {
      const source = catalog.policies[`${snap.table}.${entry.copy_of}`];
      if (!source || source.command !== snap.command || source.permissive !== snap.permissive
          || source.using !== snap.using || source.with_check !== snap.with_check) {
        add(1, key, `copy differs from its source ${entry.copy_of}`);
      }
    }
    if (snap.roles.includes('PUBLIC') && entry.verdict !== 'keep') add(6, key, 'PUBLIC policy without a reviewed keep verdict');

    // Check 4: a login the policy applies to can execute every function it calls.
    const applies = snap.roles.includes('PUBLIC') ? sorted(logins) : snap.roles.filter((r) => logins.has(r));
    for (const fn of snap.functions) {
      const acl = catalog.functions[fn]?.acl;
      if (!acl) continue;
      for (const login of applies) {
        if (snap.roles.includes('PUBLIC')) {
          // A PUBLIC policy matters only to a login that holds a right on the table.
          const table = catalog.tables[snap.table];
          if (!table || actualTableRights(table, login).size === 0) continue;
        }
        const executes = (acl[login] ?? []).includes('EXECUTE') || (acl.PUBLIC ?? []).includes('EXECUTE');
        if (!executes) add(4, key, `applies to ${login}, which cannot execute ${fn}`);
      }
    }
  }
  for (const key of sorted(Object.keys(manifest.policies))) {
    if (!catalog.policies[key]) add(1, key, 'policy classified in the manifest but absent');
  }

  return out.sort((a, b) => a.check - b.check
    || (a.object < b.object ? -1 : a.object > b.object ? 1 : 0)
    || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
}
