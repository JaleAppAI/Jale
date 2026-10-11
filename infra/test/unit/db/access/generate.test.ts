/**
 * generate.test.ts -- the access-rights generator (infra/db/access/generate.ts).
 *
 * On a small fixture manifest and catalog snapshot it proves:
 *   - the golden output, and byte-identical output across runs and key orders;
 *   - copy fidelity: a copy keeps its source's command, mode, USING and WITH
 *     CHECK byte for byte, and is named `<source>__api` or `<source>__dg`;
 *   - every refusal: unknown objects, a name over 63 bytes or colliding,
 *     rights on an excluded table, a copy of a never-copied, flag-reading or
 *     unrestricted source, and more;
 *   - helper-owned grants inside an INHERIT-only window of GRANT statements,
 *     closed and audited before COMMIT, with no role switch;
 *   - self-audit constants that match the manifest.
 * On the shipped files it proves that 106 is generated from manifest.json
 * alone (a fragment never changes it), that the committed migration is
 * exactly what the generator writes, and that policyCopies -- the list the
 * DB suites read the reviewed copies from -- names exactly the copies 106
 * creates.
 *
 * UPDATE_GOLDEN=1 rewrites golden/access-rights-fixture.sql from the current
 * generator; review its diff before committing it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseManifest, type AccessManifest } from '../../../../db/access/access-manifest';
import {
  baseManifest, expectedCounts, generate106, generateAccessRights, policyCopies, validateForGeneration, MIGRATION_106,
  type GenerateInput,
} from '../../../../db/access/generate';
import type { CatalogSnapshot } from '../../../../db/access/snapshot';

const accessDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'access');
const migrationsDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'migrations');
const goldenFile = path.join(__dirname, 'golden', 'access-rights-fixture.sql');

const OWNER_CHECK = "(employer_id = (current_setting('app.current_user_id'::text, true))::uuid)";
const RELATIONSHIP = "jale_internal.employer_has_applicant_relationship(current_setting('app.current_user_id'::text, true), id)";

function fixtureRaw(): Record<string, any> {
  return {
    version: 1,
    master: 'jale_admin',
    logins: {
      jale_api: { kind: 'request', created_by: '104', connection_limit: -1, prepare_secret: true, workloads: 'Requests.', reason: 'Fixture.' },
      jale_job_digest: { kind: 'job', created_by: '104', connection_limit: 5, prepare_secret: true, workloads: 'Digest.', reason: 'Fixture.' },
      jale_whatsapp: { kind: 'service', created_by: 'pre-104', connection_limit: -1, workloads: 'Engine.', reason: 'Fixture.' },
    },
    capability_owners: { jale_cap_fixture: { created_by: '104', reason: 'Fixture.' } },
    groups: {},
    helper_roles: { jale_rls_relationship_reader: { reason: 'Fixture.' } },
    platform_roles: {},
    schemas: {
      public: { owner: 'jale_admin', usage: ['PUBLIC', 'jale_api', 'jale_job_digest'], create: [], reason: 'Fixture.' },
      jale_internal: { owner: 'jale_rls_relationship_reader', usage: ['jale_api'], create: [], reason: 'Fixture.' },
      jale_cap: { owner: 'jale_admin', usage: ['jale_api'], create: ['jale_cap_fixture'], reason: 'Fixture.' },
    },
    tables: {
      'public.jobs': {
        classification: 'access', rls: { enabled: true, forced: true }, reason: 'Fixture.',
        access: {
          jale_api: { select: '*', insert: '*', update: ['title', 'status'], delete: true },
          jale_job_digest: { select: ['id', 'title'] },
          jale_whatsapp: { select: '*' },
        },
      },
      'public.billing_plans': {
        classification: 'access', rls: { enabled: true, forced: true }, reason: 'Fixture.', access: { jale_api: { select: '*' } },
      },
      'public.notes': { classification: 'excluded', rls: { enabled: true, forced: true }, reason: 'Fixture.', access: {} },
    },
    sequences: {
      'public.jobs_number_seq': { owner: 'jale_admin', usage: ['jale_api'], select: [], update: [], reason: 'Fixture.' },
    },
    policies: {
      'public.jobs.jobs_employer_all': {
        command: 'ALL', permissive: true, to: ['jale_admin'], origin: 'existing', using: OWNER_CHECK, with_check: OWNER_CHECK, reason: 'Fixture.',
      },
      'public.jobs.jobs_employer_all__api': {
        command: 'ALL', permissive: true, to: ['jale_api'], origin: 'copy', copy_of: 'jobs_employer_all', reason: 'Fixture.',
      },
      'public.jobs.jobs_applicant_guard': {
        command: 'SELECT', permissive: false, to: ['jale_admin'], origin: 'existing', using: RELATIONSHIP, with_check: null, reason: 'Fixture.',
      },
      'public.jobs.jobs_applicant_guard__dg': {
        command: 'SELECT', permissive: false, to: ['jale_job_digest'], origin: 'copy', copy_of: 'jobs_applicant_guard', reason: 'Fixture.',
      },
      'public.jobs.jobs_digest_open': {
        command: 'SELECT', permissive: true, to: ['jale_job_digest'], origin: 'new',
        using: "(status = 'open'::text)", with_check: null, reason: 'Fixture.',
      },
      'public.billing_plans.billing_plans_read_all': {
        command: 'SELECT', permissive: true, to: ['jale_admin'], origin: 'existing', using: 'true', with_check: null, reason: 'Fixture.',
      },
      'public.billing_plans.billing_plans_read_all__api': {
        command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'copy', copy_of: 'billing_plans_read_all', open: true, reason: 'Fixture.',
      },
    },
    functions: {
      'jale_internal.employer_has_applicant_relationship(text, uuid)': {
        owner: 'jale_rls_relationship_reader', security: 'definer', search_path: 'pg_catalog, pg_temp',
        arguments: 'p_sub text, p_worker uuid', returns: 'boolean', execute: ['jale_admin', 'jale_api', 'jale_job_digest'], reason: 'Fixture.',
      },
      'public.employer_display_name(uuid)': {
        owner: 'jale_admin', security: 'definer', search_path: 'pg_catalog, public, pg_temp',
        arguments: 'p_id uuid', returns: 'text', execute: ['jale_api', 'jale_whatsapp'], reason: 'Fixture.',
      },
      'jale_cap.fixture_capability()': {
        owner: 'jale_cap_fixture', security: 'definer', search_path: 'pg_catalog, pg_temp', arguments: '', returns: 'void',
        execute: ['jale_api'], created_by: '105', reason: 'Fixture.',
      },
    },
    exceptions: [],
  };
}

function fixtureManifest(raw: Record<string, any> = fixtureRaw()): AccessManifest {
  return parseManifest(raw);
}

function fixtureSnapshot(): CatalogSnapshot {
  const table = (columns: string[]) => ({
    kind: 'table' as const, owner: 'jale_admin', rls: { enabled: true, forced: true }, columns, acl: {}, column_acl: {},
  });
  const fn = (owner: string, args: string, returns: string) => ({
    owner, security: 'definer' as const, search_path: 'pg_catalog, pg_temp', language: 'plpgsql', kind: 'function' as const,
    arguments: args, returns, acl: {},
  });
  return {
    version: 1,
    schemas: {
      public: { owner: 'jale_admin', acl: { PUBLIC: ['USAGE'] } },
      jale_internal: { owner: 'jale_rls_relationship_reader', acl: {} },
      jale_cap: { owner: 'jale_admin', acl: {} },
    },
    tables: {
      'public.jobs': table(['id', 'employer_id', 'title', 'status']),
      'public.billing_plans': table(['id', 'name']),
      'public.notes': table(['id', 'body']),
    },
    sequences: { 'public.jobs_number_seq': { owner: 'jale_admin', acl: {} } },
    policies: {
      'public.jobs.jobs_employer_all': {
        table: 'public.jobs', name: 'jobs_employer_all', command: 'ALL', permissive: true, roles: ['jale_admin'],
        using: OWNER_CHECK, with_check: OWNER_CHECK, functions: [],
      },
      'public.jobs.jobs_applicant_guard': {
        table: 'public.jobs', name: 'jobs_applicant_guard', command: 'SELECT', permissive: false, roles: ['jale_admin'],
        using: RELATIONSHIP, with_check: null, functions: ['jale_internal.employer_has_applicant_relationship(text, uuid)'],
      },
      'public.billing_plans.billing_plans_read_all': {
        table: 'public.billing_plans', name: 'billing_plans_read_all', command: 'SELECT', permissive: true, roles: ['jale_admin'],
        using: 'true', with_check: null, functions: [],
      },
    },
    functions: {
      'jale_internal.employer_has_applicant_relationship(text, uuid)': fn('jale_rls_relationship_reader', 'p_sub text, p_worker uuid', 'boolean'),
      'public.employer_display_name(uuid)': fn('jale_admin', 'p_id uuid', 'text'),
      'jale_cap.fixture_capability()': fn('jale_cap_fixture', '', 'void'),
    },
    guc_refs: ['app.current_user_id'],
  };
}

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return {
    manifest: fixtureManifest(),
    snapshot: fixtureSnapshot(),
    logins: ['jale_api', 'jale_job_digest'],
    migration: { number: '999', file: '999_fixture_access_rights.sql', previous: '998_fixture.sql' },
    ...overrides,
  };
}

/** Problems for a manifest object built without parseManifest, so the generator's own checks are what runs. */
function problemsWith(mutate: (raw: Record<string, any>, snapshot: CatalogSnapshot) => void): string[] {
  const raw = fixtureRaw();
  const snapshot = fixtureSnapshot();
  mutate(raw, snapshot);
  return validateForGeneration({ ...input(), manifest: raw as AccessManifest, snapshot });
}

/** Every key of every object, recursively, in reverse order. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversedKeys(v)])) as T;
  }
  return value;
}

/** The CREATE POLICY statement for `name`, up to its semicolon. */
function createPolicy(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE POLICY ${name} ON`);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(';\n', start) + 1);
}

describe('generateAccessRights on a fixture', () => {
  it('writes the golden output', () => {
    const sql = generateAccessRights(input());
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
      fs.writeFileSync(goldenFile, sql);
    }
    expect(sql).toBe(fs.readFileSync(goldenFile, 'utf8'));
  });

  it('is deterministic: two runs, and any key order, give byte-identical SQL', () => {
    const first = generateAccessRights(input());
    expect(generateAccessRights(input())).toBe(first);
    expect(generateAccessRights(input({
      manifest: fixtureManifest(reversedKeys(fixtureRaw())),
      snapshot: reversedKeys(fixtureSnapshot()),
      logins: ['jale_job_digest', 'jale_api'],
    }))).toBe(first);
  });

  it('copies keep the source command, mode, USING and WITH CHECK byte for byte', () => {
    const sql = generateAccessRights(input());
    expect(createPolicy(sql, 'jobs_employer_all__api')).toBe(
      `CREATE POLICY jobs_employer_all__api ON public.jobs\n  AS PERMISSIVE FOR ALL TO jale_api\n  USING (${OWNER_CHECK})\n  WITH CHECK (${OWNER_CHECK});`,
    );
    expect(createPolicy(sql, 'jobs_applicant_guard__dg')).toBe(
      `CREATE POLICY jobs_applicant_guard__dg ON public.jobs\n  AS RESTRICTIVE FOR SELECT TO jale_job_digest\n  USING (${RELATIONSHIP});`,
    );
    expect(createPolicy(sql, 'jobs_digest_open')).toBe(
      "CREATE POLICY jobs_digest_open ON public.jobs\n  AS PERMISSIVE FOR SELECT TO jale_job_digest\n  USING ((status = 'open'::text));",
    );
    expect(sql).toContain('DROP POLICY IF EXISTS jobs_employer_all__api ON public.jobs;');
  });

  it('grants exactly the table, column and sequence rights of the target logins', () => {
    const sql = generateAccessRights(input());
    const grants = sql.split('\n').filter((line) => /^GRANT (SELECT|INSERT|UPDATE|DELETE|USAGE ON SEQUENCE)/.test(line));
    expect(grants).toEqual([
      'GRANT SELECT ON public.billing_plans TO jale_api;',
      'GRANT SELECT ON public.jobs TO jale_api;',
      'GRANT INSERT ON public.jobs TO jale_api;',
      'GRANT UPDATE (title, status) ON public.jobs TO jale_api;',
      'GRANT DELETE ON public.jobs TO jale_api;',
      'GRANT SELECT (id, title) ON public.jobs TO jale_job_digest;',
      'GRANT USAGE ON SEQUENCE public.jobs_number_seq TO jale_api;',
    ]);
    expect(sql).not.toContain('jale_whatsapp');
  });

  it('grants helper-owned objects inside an INHERIT-only window of GRANT statements, closed and audited, with no role switch', () => {
    const sql = generateAccessRights(input());
    const open = sql.indexOf("EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', 'jale_rls_relationship_reader', current_user);");
    const close = sql.indexOf("EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);");
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    const window = sql.slice(sql.indexOf('$$;\n', open) + 4, sql.lastIndexOf('DO $$', close)).trim().split('\n');
    expect(window).toEqual([
      'GRANT USAGE ON SCHEMA jale_internal TO jale_api;',
      'GRANT EXECUTE ON FUNCTION jale_internal.employer_has_applicant_relationship(text, uuid) TO jale_api, jale_job_digest;',
    ]);
    expect(sql).toContain("RAISE EXCEPTION 'migration 999: a membership window on a helper owner is still open';");
    expect(sql.indexOf('a membership window on a helper owner is still open')).toBeLessThan(sql.lastIndexOf('\nCOMMIT;'));
    expect(sql).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
    expect(sql).not.toMatch(/\bRESET\s+ROLE\b/i);
  });

  it('grants master-owned EXECUTE and USAGE directly, and skips the functions 105 creates', () => {
    const sql = generateAccessRights(input());
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.employer_display_name(uuid) TO jale_api;');
    expect(sql).toContain('GRANT USAGE ON SCHEMA public TO jale_api, jale_job_digest;');
    expect(sql).toContain('GRANT USAGE ON SCHEMA jale_cap TO jale_api;');
    expect(sql).not.toContain('fixture_capability');
  });

  it('pins the search_path so copied expressions parse as they were read', () => {
    const sql = generateAccessRights(input());
    expect(sql.indexOf('SET LOCAL search_path = public;')).toBeGreaterThan(sql.indexOf('BEGIN;'));
    expect(sql.indexOf('SET LOCAL search_path = public;')).toBeLessThan(sql.indexOf('CREATE POLICY'));
  });

  it('writes self-audit constants that match the manifest', () => {
    const manifest = fixtureManifest();
    expect(expectedCounts(manifest, 'jale_api')).toEqual({
      policies: 2, tablePrivileges: 4, columnPrivileges: 2, sequencePrivileges: 1, executes: 3, schemaPrivileges: 3,
    });
    expect(expectedCounts(manifest, 'jale_job_digest')).toEqual({
      policies: 2, tablePrivileges: 0, columnPrivileges: 2, sequencePrivileges: 0, executes: 1, schemaPrivileges: 1,
    });
    const sql = generateAccessRights(input());
    expect(sql).toContain("('jale_api', 2, 4, 2, 1, 3, 3)");
    expect(sql).toContain("('jale_job_digest', 2, 0, 2, 0, 1, 1)");
    expect(sql).toContain("'migration 999: source policy % on % changed since the catalog snapshot; regenerate'");
  });
});

describe('the generator refuses', () => {
  const cases: Array<[string, (raw: Record<string, any>, snapshot: CatalogSnapshot) => void, string]> = [
    ['an unknown table', (raw) => { raw.tables['public.ghost'] = { ...raw.tables['public.notes'], classification: 'access', access: { jale_api: { select: '*' } } }; },
      'tables.public.ghost: unknown table'],
    ['an unknown column', (raw) => { raw.tables['public.jobs'].access.jale_job_digest.select = ['id', 'salary']; },
      'tables.public.jobs.access.jale_job_digest.select: unknown column salary'],
    ['rights on an excluded table', (raw) => { raw.tables['public.notes'].access = { jale_api: { select: '*' } }; },
      'tables.public.notes: excluded but grants to jale_api'],
    ['TRUNCATE, REFERENCES or TRIGGER for a dedicated login', (raw) => { raw.tables['public.jobs'].access.jale_api.truncate = true; },
      'tables.public.jobs.access.jale_api: TRUNCATE, REFERENCES and TRIGGER are never granted to a dedicated login'],
    ['a copy of an unknown source', (raw) => { raw.policies['public.jobs.ghost__api'] = { ...raw.policies['public.jobs.jobs_employer_all__api'], copy_of: 'ghost' }; },
      'policies.public.jobs.ghost__api: unknown source public.jobs.ghost'],
    ['a copy with the wrong name', (raw) => {
      raw.policies['public.jobs.jobs_employer_all_api'] = raw.policies['public.jobs.jobs_employer_all__api'];
      delete raw.policies['public.jobs.jobs_employer_all__api'];
    }, 'policies.public.jobs.jobs_employer_all_api: a copy of jobs_employer_all for jale_api must be named jobs_employer_all__api'],
    ['a copy for a login without a copy code', (raw) => {
      raw.policies['public.jobs.jobs_employer_all__api'].to = ['jale_api', 'jale_job_digest'];
    }, 'policies.public.jobs.jobs_employer_all__api: a copy applies to exactly one login with a copy code'],
    ['a copy whose command or mode differs from its source', (raw) => {
      raw.policies['public.jobs.jobs_applicant_guard__dg'].permissive = true;
    }, 'policies.public.jobs.jobs_applicant_guard__dg: command and mode must match the source public.jobs.jobs_applicant_guard'],
    ['a name over 63 bytes', (raw) => {
      raw.policies[`public.jobs.${'x'.repeat(64)}`] = { ...raw.policies['public.jobs.jobs_digest_open'] };
    }, `policies.public.jobs.${'x'.repeat(64)}: name longer than 63 bytes`],
    ['a name that collides with an existing policy', (raw, snapshot) => {
      snapshot.policies['public.jobs.jobs_digest_open'] = { ...snapshot.policies['public.jobs.jobs_employer_all'], name: 'jobs_digest_open' };
    }, 'policies.public.jobs.jobs_digest_open: collides with an existing policy'],
    ['a copy of a never-copied source', (raw, snapshot) => {
      snapshot.policies['public.jobs.jobs_geo_definer'] = { ...snapshot.policies['public.jobs.jobs_employer_all'], name: 'jobs_geo_definer' };
      raw.policies['public.jobs.jobs_geo_definer__api'] = { ...raw.policies['public.jobs.jobs_employer_all__api'], copy_of: 'jobs_geo_definer' };
    }, 'policies.public.jobs.jobs_geo_definer__api: jobs_geo_definer is never copied to a runtime login'],
    ['a copy whose source reads a capability flag', (raw, snapshot) => {
      snapshot.policies['public.jobs.jobs_lookup'] = {
        ...snapshot.policies['public.jobs.jobs_employer_all'], name: 'jobs_lookup',
        using: "(current_setting('jale.job_company_lookup'::text, true) = 'on'::text)", with_check: null,
      };
      raw.policies['public.jobs.jobs_lookup__api'] = { ...raw.policies['public.jobs.jobs_employer_all__api'], copy_of: 'jobs_lookup' };
    }, 'policies.public.jobs.jobs_lookup__api: the source reads capability setting jale.job_company_lookup'],
    ['an unrestricted copy outside the reference-data allow-list', (raw, snapshot) => {
      snapshot.policies['public.jobs.jobs_read_all'] = { ...snapshot.policies['public.billing_plans.billing_plans_read_all'], table: 'public.jobs', name: 'jobs_read_all' };
      raw.policies['public.jobs.jobs_read_all__api'] = { ...raw.policies['public.billing_plans.billing_plans_read_all__api'], copy_of: 'jobs_read_all' };
    }, 'policies.public.jobs.jobs_read_all__api: jobs_read_all is unrestricted and not on the reference-data allow-list'],
    ['a copy whose source names no caller identity, however it is written', (raw, snapshot) => {
      snapshot.policies['public.jobs.jobs_unrevoked'] = {
        ...snapshot.policies['public.jobs.jobs_employer_all'], name: 'jobs_unrevoked', command: 'SELECT',
        using: '(employer_id IS NOT NULL)', with_check: null,
      };
      raw.policies['public.jobs.jobs_unrevoked__api'] = {
        ...raw.policies['public.jobs.jobs_employer_all__api'], command: 'SELECT', copy_of: 'jobs_unrevoked',
      };
      raw.policies['public.jobs.jobs_unrevoked'] = { ...raw.policies['public.jobs.jobs_employer_all'], command: 'SELECT' };
    }, 'policies.public.jobs.jobs_unrevoked__api: jobs_unrevoked names no caller identity setting and is not on the reference-data allow-list'],
    ['a copy whose open flag does not match its source', (raw) => {
      delete raw.policies['public.billing_plans.billing_plans_read_all__api'].open;
    }, 'policies.public.billing_plans.billing_plans_read_all__api: open must be true to match its source'],
    ['an unrestricted new policy for a request login', (raw) => {
      raw.policies['public.jobs.jobs_everything'] = { ...raw.policies['public.jobs.jobs_digest_open'], to: ['jale_api'], using: 'true', open: true };
    }, 'policies.public.jobs.jobs_everything: an unrestricted new policy is allowed for job logins only'],
    ['a generated policy for a role 106 does not grant to', (raw) => {
      raw.policies['public.jobs.jobs_digest_open'].to = ['jale_whatsapp'];
    }, 'policies.public.jobs.jobs_digest_open: a generated policy may only apply to jale_api, jale_job_digest'],
    ['an unknown function', (raw) => {
      raw.functions['public.ghost(uuid)'] = { ...raw.functions['public.employer_display_name(uuid)'] };
    }, 'functions.public.ghost(uuid): unknown function'],
    ['an unknown schema, or CREATE for a dedicated login', (raw) => {
      raw.schemas.ghost = { owner: 'jale_admin', usage: ['jale_api'], create: [], reason: 'x' };
      raw.schemas.public.create = ['jale_api'];
    }, 'schemas.ghost: unknown schema'],
    ['an unknown sequence', (raw) => {
      raw.sequences['public.ghost_seq'] = { ...raw.sequences['public.jobs_number_seq'] };
    }, 'sequences.public.ghost_seq: unknown sequence'],
  ];

  it.each(cases)('%s', (_label, mutate, problem) => {
    expect(problemsWith(mutate)).toContain(problem);
  });

  it('CREATE on a schema for a dedicated login', () => {
    expect(problemsWith((raw) => { raw.schemas.public.create = ['jale_api']; }))
      .toContain('schemas.public: CREATE is never granted to a dedicated login');
  });

  it('checks only what the migration touches: an existing policy the snapshot lacks is not its concern', () => {
    expect(problemsWith((raw) => {
      raw.policies['public.notes.notes_owner_read'] = { command: 'SELECT', permissive: true, to: ['jale_admin'], origin: 'existing', reason: 'x' };
    })).toEqual([]);
  });

  it('throws every problem at once', () => {
    const raw = fixtureRaw();
    raw.tables['public.jobs'].access.jale_job_digest.select = ['salary'];
    raw.sequences['public.ghost_seq'] = { ...raw.sequences['public.jobs_number_seq'] };
    expect(() => generateAccessRights({ ...input(), manifest: raw as AccessManifest }))
      .toThrow(/unknown column salary.*sequences\.public\.ghost_seq: unknown sequence/);
  });
});

describe('migration 106', () => {
  it('is generated from manifest.json alone: a fragment never changes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-generate-'));
    try {
      fs.copyFileSync(path.join(accessDir, 'manifest.json'), path.join(dir, 'manifest.json'));
      fs.copyFileSync(path.join(accessDir, 'catalog-snapshot.json'), path.join(dir, 'catalog-snapshot.json'));
      fs.mkdirSync(path.join(dir, 'manifest.d'));
      fs.writeFileSync(path.join(dir, 'manifest.d', 'zz-fixture.json'), JSON.stringify({
        logins: {
          jale_job_fixture: { kind: 'job', created_by: '104', connection_limit: 5, prepare_secret: true, workloads: 'x', reason: 'x' },
        },
        function_additions: { 'public.admin_mask_phone(text)': { reason: 'x', execute: ['jale_api'] } },
        table_additions: {
          'public.users': {
            reason: 'x',
            policies: { users_fixture_read: { command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'existing', reason: 'x' } },
          },
        },
      }));
      expect(generate106({ dir })).toBe(generate106());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed migration is exactly what the generator writes', () => {
    expect(fs.readFileSync(path.join(migrationsDir, MIGRATION_106.file), 'utf8')).toBe(generate106());
  });

  it('creates exactly the copies policyCopies lists, plus the new policies manifest.json records', () => {
    const manifest = baseManifest();
    const created = [...generate106().matchAll(/^CREATE POLICY (\S+) ON (\S+)$/gm)].map(([, name, table]) => `${table}.${name}`);
    const copies = policyCopies(manifest).map((copy) => `${copy.table}.${copy.name}`);
    const added = Object.entries(manifest.policies).filter(([, p]) => p.origin === 'new').map(([key]) => key);
    expect(copies.length).toBeGreaterThan(0);
    expect([...created].sort()).toEqual([...copies, ...added].sort());
  });
});

describe('policyCopies', () => {
  it('lists every reviewed copy with its table, source, command and login, in key order', () => {
    expect(policyCopies(fixtureManifest())).toEqual([
      { table: 'public.billing_plans', name: 'billing_plans_read_all__api', copyOf: 'billing_plans_read_all', command: 'SELECT', to: ['jale_api'] },
      { table: 'public.jobs', name: 'jobs_applicant_guard__dg', copyOf: 'jobs_applicant_guard', command: 'SELECT', to: ['jale_job_digest'] },
      { table: 'public.jobs', name: 'jobs_employer_all__api', copyOf: 'jobs_employer_all', command: 'ALL', to: ['jale_api'] },
    ]);
  });

  it('lists nothing for a manifest without copies', () => {
    const raw = fixtureRaw();
    for (const [key, policy] of Object.entries(raw.policies as Record<string, { origin: string }>)) {
      if (policy.origin === 'copy') delete raw.policies[key];
    }
    expect(policyCopies(fixtureManifest(raw))).toEqual([]);
  });
});
