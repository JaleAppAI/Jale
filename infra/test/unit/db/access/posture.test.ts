/**
 * posture.test.ts -- the posture check's evaluation, without a database.
 *
 * A clean catalog, built here from the manifest itself, gives a complete run
 * with no violation; each fault the check exists for gives exactly one named
 * violation; a missing or failed read gives an incomplete run, which the
 * deploy gate treats as not clean. Extensions registered by other modules
 * add their own reads and checks.
 *
 * The catalog queries themselves are proven on a real bed, as the posture
 * login, by least-privilege-posture.integration.test.ts.
 */
import { Client } from 'pg';
import { loadManifest, manifestDigest, parseManifest, type AccessManifest } from '../../../../db/access/access-manifest';
import type { CatalogSnapshot } from '../../../../db/access/snapshot';
import {
  checkPosture, evaluatePosture, readPostureRows, POSTURE_EXTENSIONS,
  type PostureExtension, type PostureQueryable, type PostureResult, type PostureRoleRow, type PostureRows,
} from '../../../../db/access/posture';

const manifest = loadManifest();

function role(name: string, overrides: Partial<PostureRoleRow> = {}): PostureRoleRow {
  return {
    name,
    bootstrap: false,
    can_login: false,
    superuser: false,
    inherit: false,
    createrole: false,
    createdb: false,
    replication: false,
    bypassrls: false,
    connection_limit: -1,
    time_limited: false,
    owned_objects: 0,
    relation_privileges: 0,
    database_temp: false,
    ...overrides,
  };
}

/** The catalog a correct database shows: built from the manifest. */
function cleanRows(m: AccessManifest = manifest): PostureRows {
  const roles: PostureRoleRow[] = [
    role('postgres', {
      bootstrap: true, can_login: true, superuser: true, inherit: true, createrole: true, createdb: true, replication: true,
      bypassrls: true, database_temp: true,
    }),
    role(m.master, { can_login: true, inherit: true, createrole: true, createdb: true, owned_objects: 500, database_temp: true }),
    ...Object.entries(m.logins).map(([name, entry]) => role(name, {
      can_login: true, connection_limit: entry.connection_limit, inherit: entry.kind === 'service',
    })),
    ...Object.keys(m.capability_owners).map((name) => role(name, { owned_objects: 3 })),
    ...Object.keys(m.groups).map((name) => role(name)),
    ...Object.keys(m.helper_roles).map((name) => role(name, { owned_objects: 1 })),
  ];
  const memberships = Object.keys(m.logins).map((login) => ({
    granted: login, member: m.master, admin_option: true, inherit_option: false, set_option: false,
  }));
  const tables = Object.entries(m.tables)
    .filter(([, entry]) => entry.runner_managed !== true)
    .map(([name, entry]) => ({ name, enabled: entry.rls.enabled, forced: entry.rls.forced }));
  const definers = Object.entries(m.functions)
    .filter(([, entry]) => entry.security === 'definer')
    .map(([name, entry]) => ({ name, search_path: entry.search_path, public_execute: false }));
  // The master may own large objects; nothing else may.
  const largeObjects = [{ owner: m.master, objects: 2 }];
  const roleSettings = Object.entries(m.logins).flatMap(([login, entry]) =>
    Object.entries(entry.settings ?? {}).map(([name, value]) => ({ role: login, scoped: false, name, value })));
  return {
    serverVersion: '16.4', roles, memberships, rdsSuperuserMembers: [], tables, nonTableRelations: [], definers, largeObjects,
    databaseCreate: [m.master], publicSchemaCreate: [m.master, 'pg_database_owner'],
    functionDefaults: [{ role: m.master, schema: null, public_execute: false }],
    grantOptions: [],
    roleSettings,
    extensions: {},
  };
}

function withRole(rows: PostureRows, name: string, overrides: Partial<PostureRoleRow>): PostureRows {
  return { ...rows, roles: rows.roles.map((r) => (r.name === name ? { ...r, ...overrides } : r)) };
}

const OPERATOR_GRANT = { granted: 'jale_ops_readonly', admin_option: false, inherit_option: true, set_option: false };

/** Rows with one runtime person login in the accepted operator shape. */
function withPerson(rows: PostureRows, overrides: Partial<PostureRoleRow> = {}): PostureRows {
  return {
    ...rows,
    roles: [...rows.roles, role('jale_person_fixture', { can_login: true, inherit: true, time_limited: true, ...overrides })],
    memberships: [
      ...rows.memberships,
      { ...OPERATOR_GRANT, member: 'jale_person_fixture' },
      { granted: 'jale_person_fixture', member: manifest.master, admin_option: true, inherit_option: false, set_option: false },
    ],
  };
}

describe('evaluatePosture', () => {
  it('a correct catalog is complete and clean, and the result names the manifest it ran against', () => {
    const result = evaluatePosture(cleanRows(), manifest, []);
    expect(result).toEqual({
      complete: true, violations: [], serverVersion: '16.4', manifestDigest: manifestDigest(manifest),
    });
  });

  it('names a runtime login with a forbidden attribute', () => {
    for (const [attr, word] of [
      ['bypassrls', 'BYPASSRLS'], ['superuser', 'SUPERUSER'], ['createrole', 'CREATEROLE'],
      ['createdb', 'CREATEDB'], ['replication', 'REPLICATION'],
    ] as const) {
      const result = evaluatePosture(withRole(cleanRows(), 'jale_api', { [attr]: true }), manifest, []);
      expect(result.violations).toEqual([{ check: 'login_attributes', object: 'jale_api', detail: `carries ${word}` }]);
    }
  });

  it('names a dedicated login that inherits, has the wrong connection limit, cannot log in, or is missing', () => {
    const rows = withRole(withRole(cleanRows(), 'jale_job_digest', { inherit: true, connection_limit: 50 }), 'jale_posture', { can_login: false });
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'login_attributes', object: 'jale_job_digest', detail: 'carries INHERIT' },
      { check: 'login_attributes', object: 'jale_job_digest', detail: 'connection limit 50; the manifest says 5' },
      { check: 'login_attributes', object: 'jale_posture', detail: 'cannot log in' },
    ]);
    const missing = { ...cleanRows(), roles: cleanRows().roles.filter((r) => r.name !== 'jale_job_retention') };
    expect(evaluatePosture(missing, manifest, []).violations).toEqual([
      { check: 'login_attributes', object: 'jale_job_retention', detail: 'missing from the catalog' },
    ]);
  });

  it('names a runtime login that is a member of any role, rds_superuser included', () => {
    const rows = cleanRows();
    rows.memberships.push({ granted: manifest.master, member: 'jale_api', admin_option: false, inherit_option: true, set_option: true });
    rows.rdsSuperuserMembers.push('jale_whatsapp', manifest.master);
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'login_memberships', object: 'jale_api', detail: `member of ${manifest.master}` },
      { check: 'login_memberships', object: 'jale_whatsapp', detail: 'member of rds_superuser' },
    ]);
  });

  it('names a runtime login that owns objects', () => {
    const result = evaluatePosture(withRole(cleanRows(), 'jale_api_public', { owned_objects: 2 }), manifest, []);
    expect(result.violations).toEqual([{ check: 'login_ownership', object: 'jale_api_public', detail: 'owns 2 objects' }]);
  });

  it('names a runtime login, and a personal operator login, that holds TEMPORARY on the database', () => {
    expect(evaluatePosture(withRole(cleanRows(), 'jale_api', { database_temp: true }), manifest, []).violations).toEqual([
      { check: 'login_temp', object: 'jale_api', detail: 'holds TEMPORARY on the database' },
    ]);
    expect(evaluatePosture(withPerson(cleanRows(), { database_temp: true }), manifest, []).violations).toEqual([
      { check: 'login_temp', object: 'jale_person_fixture', detail: 'holds TEMPORARY on the database' },
    ]);
  });

  it('names every role other than the master that owns large objects, apart from the ownership count', () => {
    const rows = cleanRows();
    rows.largeObjects = [...rows.largeObjects, { owner: 'jale_api', objects: 2 }, { owner: 'postgres', objects: 1 }];
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'large_object_owner', object: 'jale_api', detail: 'owns 2 large objects' },
      { check: 'large_object_owner', object: 'postgres', detail: 'owns 1 large object' },
    ]);
  });

  it('names a capability owner or helper role that can log in, carries an elevated attribute, inherits, or belongs to a role', () => {
    const owner = 'jale_cap_worker_lane';
    const helper = 'jale_rls_relationship_reader';
    for (const [attr, word] of [
      ['bypassrls', 'BYPASSRLS'], ['superuser', 'SUPERUSER'], ['createrole', 'CREATEROLE'], ['createdb', 'CREATEDB'],
      ['replication', 'REPLICATION'], ['inherit', 'INHERIT'],
    ] as const) {
      for (const role of [owner, helper]) {
        expect([role, evaluatePosture(withRole(cleanRows(), role, { [attr]: true }), manifest, []).violations])
          .toEqual([role, [{ check: 'owner_attributes', object: role, detail: `carries ${word}` }]]);
      }
    }
    expect(evaluatePosture(withRole(cleanRows(), owner, { can_login: true }), manifest, []).violations)
      .toContainEqual({ check: 'owner_attributes', object: owner, detail: 'carries LOGIN' });
    const member = cleanRows();
    member.memberships.push({ granted: 'pg_read_all_data', member: helper, admin_option: false, inherit_option: true, set_option: true });
    expect(evaluatePosture(member, manifest, []).violations)
      .toEqual([{ check: 'owner_memberships', object: helper, detail: 'member of pg_read_all_data' }]);
    const missing = { ...cleanRows(), roles: cleanRows().roles.filter((r) => r.name !== owner) };
    expect(evaluatePosture(missing, manifest, []).violations)
      .toEqual([{ check: 'owner_attributes', object: owner, detail: 'missing from the catalog' }]);
  });

  it('names an operator group that is missing, can log in, carries an elevated attribute, belongs to a role or holds a table privilege', () => {
    const group = 'jale_ops_readonly';
    expect(Object.keys(manifest.groups)).toContain(group);
    for (const [attr, word] of [
      ['bypassrls', 'BYPASSRLS'], ['superuser', 'SUPERUSER'], ['createrole', 'CREATEROLE'], ['createdb', 'CREATEDB'],
      ['replication', 'REPLICATION'],
    ] as const) {
      expect([attr, evaluatePosture(withRole(cleanRows(), group, { [attr]: true }), manifest, []).violations])
        .toEqual([attr, [{ check: 'group_attributes', object: group, detail: `carries ${word}` }]]);
    }
    expect(evaluatePosture(withRole(cleanRows(), group, { can_login: true }), manifest, []).violations)
      .toContainEqual({ check: 'group_attributes', object: group, detail: 'carries LOGIN' });
    const member = cleanRows();
    member.memberships.push({ granted: 'pg_read_all_data', member: group, admin_option: false, inherit_option: true, set_option: false });
    expect(evaluatePosture(member, manifest, []).violations)
      .toEqual([{ check: 'group_memberships', object: group, detail: 'member of pg_read_all_data' }]);
    expect(evaluatePosture(withRole(cleanRows(), group, { relation_privileges: 1 }), manifest, []).violations)
      .toEqual([{ check: 'group_privileges', object: group, detail: 'holds 1 table, column or sequence privilege' }]);
    const missing = { ...cleanRows(), roles: cleanRows().roles.filter((r) => r.name !== group) };
    expect(evaluatePosture(missing, manifest, []).violations)
      .toEqual([{ check: 'group_attributes', object: group, detail: 'missing from the catalog' }]);
  });

  it('accepts the operator group\'s members: a personal login in the accepted shape is not a group violation', () => {
    expect(evaluatePosture(withPerson(cleanRows()), manifest, []).violations).toEqual([]);
  });

  it('names a runtime login\'s missing, differing, unexpected or database-scoped role setting by its name, never its value', () => {
    const value = 'a-value-no-report-may-carry';
    const rows = cleanRows();
    rows.roleSettings = rows.roleSettings
      .filter((s) => !(s.role === 'jale_api' && s.name === 'idle_in_transaction_session_timeout'))
      .map((s) => (s.role === 'jale_job_digest' ? { ...s, value: '10min' } : s));
    rows.roleSettings.push(
      { role: 'jale_job_retention', scoped: false, name: 'app.current_internal_user_id', value },
      { role: 'jale_api_public', scoped: true, name: 'app.current_user_id', value },
    );
    const result = evaluatePosture(rows, manifest, []);
    expect(result.violations).toEqual([
      { check: 'login_settings', object: 'jale_api', detail: 'setting idle_in_transaction_session_timeout is missing' },
      { check: 'login_settings', object: 'jale_api_public', detail: 'database-scoped setting app.current_user_id' },
      { check: 'login_settings', object: 'jale_job_digest', detail: 'setting idle_in_transaction_session_timeout differs from the manifest' },
      { check: 'login_settings', object: 'jale_job_retention', detail: 'unexpected setting app.current_internal_user_id' },
    ]);
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain('10min');
  });

  it('holds a service login to the manifest\'s settings too: it lists none', () => {
    const rows = cleanRows();
    rows.roleSettings.push({ role: 'jale_whatsapp', scoped: false, name: 'statement_timeout', value: '5s' });
    expect(evaluatePosture(rows, manifest, []).violations)
      .toEqual([{ check: 'login_settings', object: 'jale_whatsapp', detail: 'unexpected setting statement_timeout' }]);
  });

  it('leaves the settings of roles that are not runtime logins alone: personal operator logins and the master', () => {
    const rows = withPerson(cleanRows());
    rows.roleSettings.push(
      { role: 'jale_person_fixture', scoped: false, name: 'default_transaction_read_only', value: 'on' },
      { role: 'jale_person_fixture', scoped: false, name: 'statement_timeout', value: '30s' },
      { role: manifest.master, scoped: false, name: 'pgaudit.log', value: 'all' },
    );
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([]);
  });

  it('names CREATE on the database or on schema public held by anyone but the master', () => {
    const rows = { ...cleanRows(), databaseCreate: [manifest.master, 'jale_api', 'PUBLIC'], publicSchemaCreate: [manifest.master, 'PUBLIC'] };
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'database_create', object: 'PUBLIC', detail: 'holds CREATE on the database' },
      { check: 'database_create', object: 'jale_api', detail: 'holds CREATE on the database' },
      { check: 'public_schema_create', object: 'PUBLIC', detail: 'holds CREATE on schema public' },
    ]);
  });

  it('names default privileges that make new functions executable by PUBLIC, the master\'s missing revoke included', () => {
    const reopened = { ...cleanRows(), functionDefaults: [{ role: 'jale_whatsapp', schema: 'public', public_execute: true }] };
    expect(evaluatePosture(reopened, manifest, []).violations).toEqual([
      { check: 'default_public_execute', object: manifest.master, detail: 'functions it creates are executable by PUBLIC' },
      { check: 'default_public_execute', object: 'jale_whatsapp', detail: 'functions it creates in schema public are executable by PUBLIC' },
    ]);
  });

  it('names every difference between the catalog\'s rights and policies and the manifest', () => {
    const small = parseManifest({
      version: 1, master: 'jale_admin',
      logins: { jale_api: { kind: 'request', created_by: '104', connection_limit: -1, prepare_secret: true, workloads: 'x', reason: 'x' } },
      capability_owners: {}, groups: {}, helper_roles: {}, platform_roles: {},
      schemas: { public: { owner: 'jale_admin', usage: ['PUBLIC'], create: [], reason: 'x' } },
      tables: { 'public.jobs': { classification: 'access', rls: { enabled: true, forced: true }, reason: 'x', access: { jale_api: { select: ['id'] } } } },
      sequences: {},
      policies: {
        'public.jobs.jobs_read__new': {
          command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'new', using: '(id IS NOT NULL)', with_check: null, reason: 'x',
        },
      },
      functions: {}, exceptions: [],
    }) as AccessManifest;
    const catalog = (): CatalogSnapshot => ({
      version: 1,
      schemas: { public: { owner: 'jale_admin', acl: { PUBLIC: ['USAGE'] } } },
      tables: {
        'public.jobs': {
          kind: 'table', owner: 'jale_admin', rls: { enabled: true, forced: true }, columns: ['id', 'title'], acl: {},
          column_acl: { id: { jale_api: ['SELECT'] } },
        },
      },
      sequences: {},
      policies: {
        'public.jobs.jobs_read__new': {
          table: 'public.jobs', name: 'jobs_read__new', command: 'SELECT', permissive: true, roles: ['jale_api'],
          using: '(id IS NOT NULL)', with_check: null, functions: [],
        },
      },
      functions: {},
      guc_refs: [],
    });
    const rows = (snap: CatalogSnapshot): PostureRows => ({ ...cleanRows(small), catalog: snap });
    expect(evaluatePosture(rows(catalog()), small, []).violations).toEqual([]);
    const drifted = catalog();
    drifted.tables['public.jobs'].acl = { PUBLIC: ['SELECT'] };
    drifted.policies['public.jobs.jobs_read__new'].using = 'true';
    expect(evaluatePosture(rows(drifted), small, []).violations).toEqual([
      { check: 'manifest_drift', object: 'public.jobs', detail: 'check 2: PUBLIC holds SELECT' },
      { check: 'manifest_drift', object: 'public.jobs.jobs_read__new', detail: 'check 2: USING differs from the manifest' },
    ]);
  });

  it('names a privilege held WITH GRANT OPTION by any role other than the master', () => {
    const rows: PostureRows = {
      ...cleanRows(),
      grantOptions: [
        { object: 'public.users', grantee: 'jale_api', privilege: 'SELECT' },
        { object: 'public.users.email', grantee: 'jale_cap_worker_lane', privilege: 'SELECT' },
        { object: 'public.jobs', grantee: 'jale_ops_readonly', privilege: 'SELECT' },
        { object: 'jale_internal.employer_has_applicant_relationship(text, uuid)', grantee: 'jale_whatsapp', privilege: 'EXECUTE' },
        { object: 'jale_cap', grantee: 'jale_rls_relationship_reader', privilege: 'USAGE' },
        { object: 'public.jobs', grantee: manifest.master, privilege: 'SELECT' },
        // A second grantor of the same right is named once.
        { object: 'public.users', grantee: 'jale_api', privilege: 'SELECT' },
      ],
    };
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'grant_option', object: 'jale_cap', detail: 'jale_rls_relationship_reader holds USAGE WITH GRANT OPTION' },
      {
        check: 'grant_option', object: 'jale_internal.employer_has_applicant_relationship(text, uuid)',
        detail: 'jale_whatsapp holds EXECUTE WITH GRANT OPTION',
      },
      { check: 'grant_option', object: 'public.jobs', detail: 'jale_ops_readonly holds SELECT WITH GRANT OPTION' },
      { check: 'grant_option', object: 'public.users', detail: 'jale_api holds SELECT WITH GRANT OPTION' },
      { check: 'grant_option', object: 'public.users.email', detail: 'jale_cap_worker_lane holds SELECT WITH GRANT OPTION' },
    ]);
  });

  it('names a table whose row-security flags differ from the manifest, an unclassified table and a missing one', () => {
    const rows = cleanRows();
    rows.tables = rows.tables
      .map((t) => (t.name === 'public.users' ? { ...t, forced: false } : t))
      .filter((t) => t.name !== 'public.jobs');
    rows.tables.push({ name: 'public.surprise', enabled: false, forced: false });
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'table_rls', object: 'public.jobs', detail: 'missing from the catalog' },
      { check: 'table_rls', object: 'public.users', detail: 'FORCE ROW LEVEL SECURITY is off; the manifest says on' },
      { check: 'unclassified_table', object: 'public.surprise', detail: 'not classified in the manifest' },
    ]);
  });

  it('names every view, materialized view and foreign table: the manifest classifies tables only', () => {
    const rows: PostureRows = {
      ...cleanRows(),
      nonTableRelations: [
        { name: 'public.lp_view', kind: 'view' },
        { name: 'jale_internal.lp_cache', kind: 'materialized view' },
        { name: 'public.lp_remote', kind: 'foreign table' },
      ],
    };
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'unclassified_relation', object: 'jale_internal.lp_cache', detail: 'materialized view not classified in the manifest' },
      { check: 'unclassified_relation', object: 'public.lp_remote', detail: 'foreign table not classified in the manifest' },
      { check: 'unclassified_relation', object: 'public.lp_view', detail: 'view not classified in the manifest' },
    ]);
  });

  it('accepts a runner-managed table whether or not the catalog has it, and checks its flags when present', () => {
    const present = cleanRows();
    present.tables.push({ name: 'public.schema_migrations', enabled: false, forced: false });
    expect(evaluatePosture(present, manifest, []).violations).toEqual([]);
    present.tables[present.tables.length - 1] = { name: 'public.schema_migrations', enabled: true, forced: false };
    expect(evaluatePosture(present, manifest, []).violations).toEqual([
      { check: 'table_rls', object: 'public.schema_migrations', detail: 'ROW LEVEL SECURITY is on; the manifest says off' },
    ]);
  });

  it('names a definer executable by PUBLIC, and one whose search_path is unpinned, lacks pg_temp last, or differs', () => {
    const rows = cleanRows();
    const [first, second, third, fourth] = rows.definers.map((d) => d.name);
    rows.definers = rows.definers.map((d) => {
      if (d.name === first) return { ...d, public_execute: true };
      if (d.name === second) return { ...d, search_path: null };
      if (d.name === third) return { ...d, search_path: 'pg_temp, pg_catalog' };
      if (d.name === fourth) return { ...d, search_path: 'pg_catalog, public, extra, pg_temp' };
      return d;
    });
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'definer_public_execute', object: first, detail: 'executable by PUBLIC' },
      { check: 'definer_search_path', object: second, detail: 'search_path is not pinned' },
      { check: 'definer_search_path', object: third, detail: 'search_path does not end in pg_temp' },
      { check: 'definer_search_path', object: fourth, detail: 'search_path differs from the manifest' },
    ].sort((a, b) => {
      const ka = `${a.check}\u0000${a.object}`;
      const kb = `${b.check}\u0000${b.object}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }));
  });

  it('holds a definer the manifest does not list to the pg_temp rule only', () => {
    const rows = cleanRows();
    rows.definers.push({ name: 'public.unlisted_definer()', search_path: 'pg_catalog, pg_temp', public_execute: false });
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([]);
  });

  it('names a SET or INHERIT membership in a capability owner', () => {
    const owner = Object.keys(manifest.capability_owners)[0];
    const rows = cleanRows();
    rows.memberships.push({ granted: owner, member: manifest.master, admin_option: true, inherit_option: false, set_option: true });
    rows.memberships.push({ granted: owner, member: 'jale_ops_readonly', admin_option: false, inherit_option: true, set_option: false });
    expect(evaluatePosture(rows, manifest, []).violations).toEqual([
      { check: 'capability_owner_memberships', object: owner, detail: `${manifest.master} holds SET` },
      { check: 'capability_owner_memberships', object: owner, detail: 'jale_ops_readonly holds INHERIT' },
      { check: 'group_memberships', object: 'jale_ops_readonly', detail: `member of ${owner}` },
    ]);
  });

  describe('unlisted logins', () => {
    it('accepts a runtime person login in the one operator shape', () => {
      expect(evaluatePosture(withPerson(cleanRows()), manifest, [])).toMatchObject({ complete: true, violations: [] });
    });

    it('accepts the bootstrap superuser and listed platform roles, and ignores roles that cannot log in', () => {
      const rows = cleanRows();
      rows.roles.push(role('rdstopmgr', { can_login: true }), role('some_nologin_group'));
      expect(evaluatePosture(rows, manifest, []).violations).toEqual([]);
    });

    it('names an unlisted login in any other shape', () => {
      const cases: Array<[string, PostureRows, string]> = [
        ['not an operator member', { ...cleanRows(), roles: [...cleanRows().roles, role('stray_login', { can_login: true, time_limited: true })] },
          'not a member of the operator group'],
        ['no expiry', withPerson(cleanRows(), { time_limited: false }), 'VALID UNTIL is unset or infinity'],
        ['owns objects', withPerson(cleanRows(), { owned_objects: 1 }), 'owns 1 object'],
        ['table privileges', withPerson(cleanRows(), { relation_privileges: 3 }), 'holds 3 table, column or sequence privileges'],
        ['elevated', withPerson(cleanRows(), { createdb: true }), 'carries CREATEDB'],
      ];
      for (const [label, rows, detail] of cases) {
        const object = label === 'not an operator member' ? 'stray_login' : 'jale_person_fixture';
        expect([label, evaluatePosture(rows, manifest, []).violations]).toEqual([label, [{ check: 'unlisted_login', object, detail }]]);
      }
      const setShape = withPerson(cleanRows());
      setShape.memberships = setShape.memberships.map((m) => (m.member === 'jale_person_fixture' && m.granted === 'jale_ops_readonly'
        ? { ...m, set_option: true } : m));
      expect(evaluatePosture(setShape, manifest, []).violations).toEqual([
        { check: 'unlisted_login', object: 'jale_person_fixture', detail: 'operator membership is not exactly INHERIT TRUE, SET FALSE, no ADMIN' },
      ]);
      const twoRoles = withPerson(cleanRows());
      twoRoles.memberships.push({ granted: 'jale_cap_retention', member: 'jale_person_fixture', admin_option: false, inherit_option: false, set_option: false });
      expect(evaluatePosture(twoRoles, manifest, []).violations).toEqual([
        { check: 'unlisted_login', object: 'jale_person_fixture', detail: 'member of jale_cap_retention' },
      ]);
    });
  });

  it('is incomplete when a read is missing its inventory', () => {
    const noVersion = { ...cleanRows(), serverVersion: '' };
    const noMaster = { ...cleanRows(), roles: cleanRows().roles.filter((r) => r.name !== manifest.master) };
    const noTables = { ...cleanRows(), tables: [] };
    for (const rows of [noVersion, noMaster, noTables]) {
      expect(evaluatePosture(rows, manifest, []).complete).toBe(false);
    }
  });

  it('returns violations in a stable order', () => {
    const rows = withRole(withRole(cleanRows(), 'jale_whatsapp', { bypassrls: true }), 'jale_api', { superuser: true });
    const result = evaluatePosture(rows, manifest, []);
    expect(result.violations.map((v) => v.object)).toEqual(['jale_api', 'jale_whatsapp']);
  });
});

describe('posture extensions', () => {
  const ext: PostureExtension<{ count: number }> = {
    name: 'fixture',
    read: async () => ({ count: 2 }),
    evaluate: (rows) => (rows.count > 1
      ? [{ check: 'audit_table_grants', object: 'fixture.table', detail: `${rows.count} grants` }]
      : []),
  };

  it('registers the audit checks, and nothing else', () => {
    expect(POSTURE_EXTENSIONS.map((e) => e.name)).toEqual(['audit']);
  });

  it('appends an extension\'s violations after the core ones', () => {
    const rows = { ...withRole(cleanRows(), 'jale_api', { bypassrls: true }), extensions: { fixture: { count: 2 } } };
    expect(evaluatePosture(rows, manifest, [ext]).violations).toEqual([
      { check: 'login_attributes', object: 'jale_api', detail: 'carries BYPASSRLS' },
      { check: 'audit_table_grants', object: 'fixture.table', detail: '2 grants' },
    ]);
  });

  it('is incomplete when an extension has no rows', () => {
    expect(evaluatePosture(cleanRows(), manifest, [ext]).complete).toBe(false);
  });
});

describe('checkPosture', () => {
  it('accepts a pg client as its query surface', () => {
    // Type-level: the posture Lambda passes a connected pg Client.
    const client: PostureQueryable = new Client();
    expect(typeof client.query).toBe('function');
  });

  it('reports an incomplete check, without throwing, when the catalog read fails', async () => {
    const failing: PostureQueryable = {
      query: async () => { throw new Error('connection terminated unexpectedly'); },
    };
    const result: PostureResult = await checkPosture(failing, manifest);
    expect(result).toEqual({
      complete: false, violations: [], serverVersion: null, manifestDigest: manifestDigest(manifest),
    });
  });

  it('never passes a read error text through to the result', async () => {
    const failing: PostureQueryable = {
      query: async () => { throw new Error('permission denied for table users'); },
    };
    const result = await checkPosture(failing, manifest);
    expect(JSON.stringify(result)).not.toContain('permission denied');
  });

  it('is incomplete when an extension read fails, or two extensions share a name', async () => {
    const answering: PostureQueryable = { query: async () => ({ rows: [] }) };
    const throwing: PostureExtension = { name: 'broken', read: async () => { throw new Error('boom'); }, evaluate: () => [] };
    await expect(readPostureRows(answering, [throwing])).rejects.toThrow(/boom/);
    expect((await checkPosture(answering, manifest, [throwing])).complete).toBe(false);
    const twin: PostureExtension = { name: 'twin', read: async () => ({}), evaluate: () => [] };
    await expect(readPostureRows(answering, [twin, twin])).rejects.toThrow(/twin/);
  });
});
