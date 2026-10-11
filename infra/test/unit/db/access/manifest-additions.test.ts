/**
 * manifest-additions.test.ts -- how a fragment adds rights to an object that
 * manifest.json, or an earlier fragment, defines.
 *
 * A fragment never edits another file's entry. It adds to one through an
 * explicit additions section:
 *   - table_additions.<schema.table>: new grantees in `access`, new policy
 *     names in `policies`, and at most one change of `owner` away from the
 *     master;
 *   - function_additions.<signature>: new `execute` grantees;
 *   - schema_additions.<schema>: new `usage` and `create` grantees;
 *   - sequence_additions.<schema.sequence>: new `usage`, `select` and
 *     `update` grantees.
 * Each carries its own `reason`. Anything else is a conflict and fails the
 * load: an existing grantee or policy name, a base field (rls flags,
 * classification, the table's own reason), runtime-login access to an
 * excluded table, or a target nobody defines. The merged manifest has the
 * additions folded into the entries, so every consumer sees one manifest.
 *
 * Also here: procedures, table owners and runner-managed tables, and what an
 * excluded table may still grant.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadManifest, parseManifest, readManifestFiles } from '../../../../db/access/access-manifest';

const shippedDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'access');
const shippedBase = () => JSON.parse(fs.readFileSync(path.join(shippedDir, 'manifest.json'), 'utf8'));

const owner = { created_by: '107', reason: 'Fixture capability owner added by a fragment.' };
const ownerPolicy = {
  command: 'SELECT', permissive: true, to: ['jale_cap_fixture_owner'], origin: 'existing',
  using: '(id IS NOT NULL)', with_check: null, reason: 'Fixture owner policy.',
};
const fragmentTable = {
  classification: 'access',
  rls: { enabled: true, forced: true },
  reason: 'Fixture table added by a fragment.',
  access: {},
};

let tmp: string;

function writeDir(fragments: Record<string, unknown> | null, base: unknown = shippedBase()): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'access-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(base));
  if (fragments) {
    fs.mkdirSync(path.join(dir, 'manifest.d'));
    for (const [name, body] of Object.entries(fragments)) {
      fs.writeFileSync(path.join(dir, 'manifest.d', name), JSON.stringify(body));
    }
  }
  return dir;
}

function loadError(dir: string): string {
  try {
    loadManifest(dir);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

function problemsOf(raw: unknown): string {
  try {
    parseManifest(raw);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-manifest-additions-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('table_additions', () => {
  it('adds new grantees and new policies to a table manifest.json defines, leaving its own fields alone', () => {
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        table_additions: {
          'public.users': {
            reason: 'The fixture owner reads two columns of users.',
            access: { jale_cap_fixture_owner: { select: ['id', 'user_type'], reason: 'Fixture read.' } },
            policies: { users_fixture_owner_read: ownerPolicy },
          },
        },
      },
    });
    const base = loadManifest(writeDir(null));
    const merged = loadManifest(dir);
    const users = merged.tables['public.users'];
    expect(users.access.jale_cap_fixture_owner).toEqual({ select: ['id', 'user_type'], reason: 'Fixture read.' });
    expect(merged.policies['public.users.users_fixture_owner_read']).toEqual(ownerPolicy);
    expect({ ...users, access: { ...users.access, jale_cap_fixture_owner: undefined } })
      .toEqual({ ...base.tables['public.users'], access: { ...base.tables['public.users'].access, jale_cap_fixture_owner: undefined } });
    expect(Object.keys(merged)).not.toContain('table_additions');
  });

  it('adds to a table an earlier fragment defines, and lets two fragments add different grantees', () => {
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner, jale_cap_fixture_other: owner },
        tables: { 'public.fragment_a': fragmentTable },
      },
      'b.json': {
        table_additions: {
          'public.fragment_a': {
            reason: 'Fixture.', access: { jale_cap_fixture_owner: { select: '*' } },
          },
        },
      },
      'c.json': {
        table_additions: {
          'public.fragment_a': {
            reason: 'Fixture.', access: { jale_cap_fixture_other: { insert: ['id'] } },
            policies: { fragment_a_other_insert: { ...ownerPolicy, command: 'INSERT', to: ['jale_cap_fixture_other'] } },
          },
        },
      },
    });
    const merged = loadManifest(dir);
    expect(Object.keys(merged.tables['public.fragment_a'].access).sort()).toEqual(['jale_cap_fixture_other', 'jale_cap_fixture_owner']);
    expect(Object.keys(merged.policies)).toContain('public.fragment_a.fragment_a_other_insert');
  });

  it('rejects a grantee the table already lists', () => {
    const dir = writeDir({
      'a.json': {
        table_additions: { 'public.users': { reason: 'Fixture.', access: { jale_api: { select: ['id'] } } } },
      },
    });
    expect(loadError(dir)).toContain('manifest.d/a.json: table_additions.public.users.access.jale_api already exists');
  });

  it('rejects a policy name the table already has', () => {
    const existing = Object.keys(shippedBase().policies).find((key) => key.startsWith('public.users.'))!;
    const name = existing.split('.')[2];
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        table_additions: { 'public.users': { reason: 'Fixture.', policies: { [name]: ownerPolicy } } },
      },
    });
    expect(loadError(dir)).toContain(`manifest.d/a.json: table_additions.public.users.policies.${name} already exists`);
  });

  it('rejects a change to a base field', () => {
    for (const [field, value] of [
      ['rls', { enabled: false, forced: false }],
      ['classification', 'excluded'],
      ['runner_managed', true],
    ] as const) {
      const dir = writeDir({ 'a.json': { table_additions: { 'public.users': { reason: 'Fixture.', [field]: value } } } });
      expect(loadError(dir)).toContain(
        `manifest.d/a.json: table_additions.public.users.${field}: only access, policies and owner can be added`,
      );
    }
  });

  it('rejects runtime-login access to an excluded table, but accepts a capability owner', () => {
    const login = writeDir({
      'a.json': {
        table_additions: { 'public.organizations': { reason: 'Fixture.', access: { jale_api: { select: ['id'] } } } },
      },
    });
    expect(loadError(login)).toContain(
      'manifest.d/a.json: table_additions.public.organizations.access.jale_api: public.organizations is excluded; no runtime login may be granted access to it',
    );
    const capability = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        table_additions: {
          'public.organizations': { reason: 'Fixture.', access: { jale_cap_fixture_owner: { select: ['id'] } } },
        },
      },
    });
    expect(loadManifest(capability).tables['public.organizations'].access.jale_cap_fixture_owner).toEqual({ select: ['id'] });
  });

  it('rejects an addition to a table nobody defines, or to a table the same fragment defines', () => {
    expect(loadError(writeDir({
      'a.json': { table_additions: { 'public.nowhere': { reason: 'Fixture.', access: {} } } },
    }))).toContain('manifest.d/a.json: table_additions.public.nowhere: no table public.nowhere in manifest.json or an earlier fragment');
    expect(loadError(writeDir({
      'a.json': {
        tables: { 'public.fragment_a': fragmentTable },
        table_additions: { 'public.fragment_a': { reason: 'Fixture.', access: {} } },
      },
    }))).toContain('manifest.d/a.json: table_additions.public.fragment_a: public.fragment_a is defined in this fragment; list the rights in its own entry');
  });

  it('rejects a later fragment adding to a table only a later fragment defines', () => {
    const dir = writeDir({
      'a.json': { table_additions: { 'public.fragment_b': { reason: 'Fixture.', access: {} } } },
      'b.json': { tables: { 'public.fragment_b': fragmentTable } },
    });
    expect(loadError(dir)).toContain('manifest.d/a.json: table_additions.public.fragment_b: no table public.fragment_b in manifest.json or an earlier fragment');
  });

  it("rejects a fragment policy on another file's table outside table_additions", () => {
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        policies: { 'public.users.users_fixture_owner_read': ownerPolicy },
      },
    });
    expect(loadError(dir)).toContain(
      'manifest.d/a.json: policies.public.users.users_fixture_owner_read: public.users is defined outside this fragment; add the policy through table_additions',
    );
  });

  it('requires a reason, and an object entry', () => {
    expect(loadError(writeDir({ 'a.json': { table_additions: { 'public.users': { access: {} } } } })))
      .toContain('manifest.d/a.json: table_additions.public.users.reason is missing');
    expect(loadError(writeDir({ 'a.json': { table_additions: { 'public.users': [] } } })))
      .toContain('manifest.d/a.json: table_additions.public.users must be an object');
  });

  it('validates what it adds like any other entry', () => {
    const dir = writeDir({
      'a.json': {
        table_additions: {
          'public.users': {
            reason: 'Fixture.',
            access: { jale_nobody: { select: ['id'] } },
            policies: { users_nobody_read: { ...ownerPolicy, to: ['jale_nobody'] } },
          },
        },
      },
    });
    const message = loadError(dir);
    expect(message).toContain('tables.public.users.access names unknown role jale_nobody');
    expect(message).toContain('policies.public.users.users_nobody_read.to names unknown role jale_nobody');
  });

  it('refuses a capability owner\'s policy added without its expressions, so a later change to it is caught', () => {
    const unrecorded = {
      command: 'SELECT', permissive: true, to: ['jale_cap_fixture_owner'], origin: 'existing', reason: 'Fixture owner policy.',
    };
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        table_additions: { 'public.users': { reason: 'Fixture.', policies: { users_fixture_owner_read: unrecorded } } },
      },
    });
    expect(loadError(dir))
      .toContain("policies.public.users.users_fixture_owner_read: a capability owner's policy must record its using and with_check");
  });

  it('re-owns a table once, from the master to a capability owner or helper role', () => {
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        table_additions: { 'public.organizations': { reason: 'Fixture re-own.', owner: 'jale_cap_fixture_owner' } },
      },
    });
    expect(loadManifest(dir).tables['public.organizations'].owner).toBe('jale_cap_fixture_owner');

    const twice = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner, jale_cap_fixture_other: owner },
        table_additions: { 'public.organizations': { reason: 'Fixture re-own.', owner: 'jale_cap_fixture_owner' } },
      },
      'b.json': {
        table_additions: { 'public.organizations': { reason: 'Fixture re-own.', owner: 'jale_cap_fixture_other' } },
      },
    });
    expect(loadError(twice)).toContain(
      'manifest.d/b.json: table_additions.public.organizations.owner: public.organizations is already owned by jale_cap_fixture_owner',
    );

    const toLogin = writeDir({
      'a.json': { table_additions: { 'public.organizations': { reason: 'Fixture re-own.', owner: 'jale_api' } } },
    });
    expect(loadError(toLogin)).toContain(
      'tables.public.organizations.owner must be the master, a capability owner or a helper role',
    );
  });
});

describe('function, schema and sequence additions', () => {
  const fn = 'public.admin_mask_phone(text)';

  it('adds new grantees to a function, a schema and a sequence that manifest.json defines', () => {
    const base = shippedBase();
    const sequence = Object.keys(base.sequences)[0];
    const dir = writeDir({
      'a.json': {
        capability_owners: { jale_cap_fixture_owner: owner },
        function_additions: { [fn]: { reason: 'The fixture owner masks phone numbers.', execute: ['jale_cap_fixture_owner'] } },
        schema_additions: { jale_cap: { reason: 'Fixture.', usage: ['jale_admin_console'], create: ['jale_cap_fixture_owner'] } },
        sequence_additions: { [sequence]: { reason: 'Fixture.', usage: ['jale_cap_fixture_owner'] } },
      },
    });
    const merged = loadManifest(dir);
    expect(merged.functions[fn].execute).toEqual([...base.functions[fn].execute, 'jale_cap_fixture_owner']);
    expect(merged.schemas.jale_cap.usage).toEqual([...base.schemas.jale_cap.usage, 'jale_admin_console']);
    expect(merged.schemas.jale_cap.create).toEqual([...base.schemas.jale_cap.create, 'jale_cap_fixture_owner']);
    expect(merged.sequences[sequence].usage).toEqual([...base.sequences[sequence].usage, 'jale_cap_fixture_owner']);
    for (const section of ['function_additions', 'schema_additions', 'sequence_additions']) {
      expect(Object.keys(merged)).not.toContain(section);
    }
  });

  it('rejects a grantee the entry already lists', () => {
    const dir = writeDir({
      'a.json': { schema_additions: { jale_cap: { reason: 'Fixture.', usage: ['jale_api'] } } },
    });
    expect(loadError(dir)).toContain('manifest.d/a.json: schema_additions.jale_cap.usage: jale_api is already listed');
  });

  it('rejects any other field, an object nobody defines, and a missing reason', () => {
    expect(loadError(writeDir({
      'a.json': { function_additions: { [fn]: { reason: 'Fixture.', owner: 'jale_api' } } },
    }))).toContain(`manifest.d/a.json: function_additions.${fn}.owner: only execute can be added`);
    expect(loadError(writeDir({
      'a.json': { function_additions: { 'public.nowhere(text)': { reason: 'Fixture.', execute: ['jale_api'] } } },
    }))).toContain('manifest.d/a.json: function_additions.public.nowhere(text): no function public.nowhere(text) in manifest.json or an earlier fragment');
    expect(loadError(writeDir({
      'a.json': { sequence_additions: { 'public.nowhere_seq': { reason: 'Fixture.', usage: [] } } },
    }))).toContain('manifest.d/a.json: sequence_additions.public.nowhere_seq: no sequence public.nowhere_seq in manifest.json or an earlier fragment');
    expect(loadError(writeDir({
      'a.json': { schema_additions: { jale_cap: { usage: ['jale_admin_console'] } } },
    }))).toContain('manifest.d/a.json: schema_additions.jale_cap.reason is missing');
  });

  it('is a fragment-only section: manifest.json lists rights in the entries themselves', () => {
    for (const section of ['table_additions', 'function_additions', 'schema_additions', 'sequence_additions']) {
      expect(problemsOf({ ...shippedBase(), [section]: {} }))
        .toContain(`${section} is a fragment section; manifest.json lists rights in the entries themselves`);
    }
  });

  it('rejects an unknown top-level section in manifest.json', () => {
    expect(problemsOf({ ...shippedBase(), surprises: {} })).toContain('unknown section surprises');
    expect(loadError(writeDir({ 'a.json': { change_log: {} } }))).toContain('manifest.d/a.json: unknown section change_log');
  });
});

describe('procedures', () => {
  const procedure = {
    owner: 'jale_admin', security: 'invoker', search_path: 'pg_catalog, pg_temp', arguments: 'p_handle text',
    kind: 'procedure', returns: null, execute: [], reason: 'Fixture procedure.',
  };

  it('accepts a procedure, whose result is null', () => {
    const merged = loadManifest(writeDir({ 'a.json': { functions: { 'public.fixture_proc(text)': procedure } } }));
    expect(merged.functions['public.fixture_proc(text)'].kind).toBe('procedure');
  });

  it('rejects a function without a result, a procedure with one, and an unknown kind', () => {
    const problems = problemsOf({
      ...shippedBase(),
      functions: {
        ...shippedBase().functions,
        'public.fixture_a(text)': { ...procedure, kind: undefined },
        'public.fixture_b(text)': { ...procedure, returns: 'void' },
        'public.fixture_c(text)': { ...procedure, kind: 'aggregate' },
      },
    });
    expect(problems).toContain('functions.public.fixture_a(text).returns is missing');
    expect(problems).toContain('functions.public.fixture_b(text).returns must be null for a procedure');
    expect(problems).toContain('functions.public.fixture_c(text).kind must be function or procedure');
  });
});

describe('table owners, runner-managed tables and excluded tables', () => {
  it('defaults the owner to the master; an explicit owner must be the master, a capability owner or a helper role', () => {
    const base = shippedBase();
    const helper = Object.keys(base.helper_roles)[0];
    const capability = Object.keys(base.capability_owners)[0];
    const ok = { ...base, tables: { ...base.tables } };
    ok.tables['public.organizations'] = { ...ok.tables['public.organizations'], owner: helper };
    ok.tables['public.users'] = { ...ok.tables['public.users'], owner: capability };
    expect(problemsOf(ok)).toBe('');
    const bad = { ...base, tables: { ...base.tables, 'public.organizations': { ...base.tables['public.organizations'], owner: 'jale_api' } } };
    expect(problemsOf(bad)).toContain('tables.public.organizations.owner must be the master, a capability owner or a helper role');
  });

  it('classifies the migration runner ledger as runner-managed and closed to every runtime login', () => {
    // manifest.json's own entry; a later fragment may add an owner's grant to it.
    const ledger = parseManifest(readManifestFiles(shippedDir).base).tables['public.schema_migrations'];
    expect(ledger).toMatchObject({ classification: 'excluded', runner_managed: true, rls: { enabled: false, forced: false }, access: {} });
    const bad = shippedBase();
    bad.tables['public.schema_migrations'].runner_managed = 'yes';
    expect(problemsOf(bad)).toContain('tables.public.schema_migrations.runner_managed must be true when present');
  });

  it('an excluded table may grant a capability owner, never a runtime login', () => {
    const base = shippedBase();
    const capability = Object.keys(base.capability_owners)[0];
    const ok = shippedBase();
    ok.tables['public.organizations'].access = { [capability]: { select: ['id'] } };
    expect(problemsOf(ok)).toBe('');
    const bad = shippedBase();
    bad.tables['public.organizations'].access = { jale_api: { select: ['id'] } };
    expect(problemsOf(bad)).toContain('tables.public.organizations is excluded but grants runtime login jale_api');
  });
});
