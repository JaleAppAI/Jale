/**
 * coverage.test.ts -- the coverage guard's catalog-versus-manifest checks
 * (infra/db/access/coverage.ts), without a database.
 *
 * A catalog snapshot that matches its manifest gives no violation; each way
 * the two can disagree gives exactly one named violation:
 *   1. an unclassified table, policy, function, procedure or sequence, an
 *      entry naming something that does not exist, or a classified object
 *      whose owner, kind or definition differs;
 *   2. a runtime login holding a grant, policy or EXECUTE the manifest does
 *      not list, or lacking one it does;
 *   3. a runtime login holding any right on an excluded table;
 *   4. a policy that applies to a login calling a function that login cannot
 *      execute;
 *   6. a PUBLIC policy without a reviewed `keep` verdict;
 *   9. a capability owner holding CREATE on public, or a right the manifest
 *      does not list.
 * Checks 5, 7, 8 and 10 come from the posture check, which the guard also
 * runs; the DB suite proves every check on a real bed.
 */
import { parseManifest, type AccessManifest } from '../../../../db/access/access-manifest';
import { coverageViolations, type CoverageViolation } from '../../../../db/access/coverage';
import type { CatalogSnapshot } from '../../../../db/access/snapshot';

const OWNER_CHECK = "(employer_id = (current_setting('app.current_user_id'::text, true))::uuid)";
const HELPER = 'jale_internal.employer_has_applicant_relationship(text, uuid)';

function manifestRaw(): Record<string, any> {
  return {
    version: 1,
    master: 'jale_admin',
    logins: {
      jale_api: { kind: 'request', created_by: '104', connection_limit: -1, prepare_secret: true, workloads: 'x', reason: 'x' },
      jale_whatsapp: { kind: 'service', created_by: 'pre-104', connection_limit: -1, workloads: 'x', reason: 'x' },
    },
    capability_owners: { jale_cap_fixture: { created_by: '104', reason: 'x' } },
    groups: {},
    helper_roles: { jale_rls_relationship_reader: { reason: 'x' } },
    platform_roles: {},
    schemas: {
      public: { owner: 'jale_admin', usage: ['PUBLIC', 'jale_api'], create: [], reason: 'x' },
      jale_internal: { owner: 'jale_rls_relationship_reader', usage: ['jale_api'], create: [], reason: 'x' },
      jale_cap: { owner: 'jale_admin', usage: ['jale_api'], create: ['jale_cap_fixture'], reason: 'x' },
    },
    tables: {
      'public.jobs': {
        classification: 'access', rls: { enabled: true, forced: true }, reason: 'x',
        access: {
          jale_api: { select: '*', update: ['title'] },
          jale_whatsapp: { select: ['id', 'title'] },
          jale_cap_fixture: { select: ['id'] },
        },
      },
      'public.notes': { classification: 'excluded', rls: { enabled: true, forced: true }, reason: 'x', access: {} },
      'public.schema_migrations': {
        classification: 'excluded', rls: { enabled: false, forced: false }, reason: 'x', access: {}, runner_managed: true,
      },
    },
    sequences: { 'public.jobs_number_seq': { owner: 'jale_admin', usage: ['jale_api'], select: [], update: [], reason: 'x' } },
    policies: {
      'public.jobs.jobs_employer_all': {
        command: 'ALL', permissive: true, to: ['jale_admin'], origin: 'existing', using: OWNER_CHECK, with_check: OWNER_CHECK, reason: 'x',
      },
      'public.jobs.jobs_employer_all__api': {
        command: 'ALL', permissive: true, to: ['jale_api'], origin: 'copy', copy_of: 'jobs_employer_all', reason: 'x',
      },
      'public.jobs.jobs_relationship_read': {
        command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'existing', reason: 'x',
      },
      'public.jobs.jobs_public_read': {
        command: 'SELECT', permissive: true, to: ['PUBLIC'], origin: 'existing', verdict: 'keep', reason: 'x',
      },
      'public.jobs.jobs_cap_fixture_select': {
        command: 'SELECT', permissive: true, to: ['jale_cap_fixture'], origin: 'existing',
        using: OWNER_CHECK, with_check: null, reason: 'x',
      },
      'public.jobs.jobs_open_read__new': {
        command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'new', using: "(status = 'open'::text)", with_check: null, reason: 'x',
      },
    },
    functions: {
      [HELPER]: {
        owner: 'jale_rls_relationship_reader', security: 'definer', search_path: 'pg_catalog, pg_temp',
        arguments: 'p_sub text, p_worker uuid', returns: 'boolean', execute: ['jale_api'], reason: 'x',
      },
      'public.fixture_proc(text)': {
        owner: 'jale_admin', security: 'invoker', search_path: null, arguments: 'p_handle text',
        kind: 'procedure', returns: null, execute: [], reason: 'x',
      },
    },
    exceptions: [],
  };
}

function snapshot(): CatalogSnapshot {
  const table = (columns: string[], extra: Partial<CatalogSnapshot['tables'][string]> = {}) => ({
    kind: 'table' as const, owner: 'jale_admin', rls: { enabled: true, forced: true }, columns, acl: {}, column_acl: {}, ...extra,
  });
  const policy = (name: string, command: 'ALL' | 'SELECT', roles: string[], using: string | null, functions: string[] = []) => ({
    table: 'public.jobs', name, command, permissive: true, roles, using, with_check: command === 'ALL' ? using : null, functions,
  });
  return {
    version: 1,
    schemas: {
      public: { owner: 'jale_admin', acl: { PUBLIC: ['USAGE'], jale_api: ['USAGE'] } },
      jale_internal: { owner: 'jale_rls_relationship_reader', acl: { jale_api: ['USAGE'] } },
      jale_cap: { owner: 'jale_admin', acl: { jale_api: ['USAGE'], jale_cap_fixture: ['CREATE'] } },
    },
    tables: {
      'public.jobs': table(['id', 'employer_id', 'title'], {
        acl: { jale_api: ['SELECT'] },
        column_acl: {
          id: { jale_whatsapp: ['SELECT'], jale_cap_fixture: ['SELECT'] },
          title: { jale_api: ['UPDATE'], jale_whatsapp: ['SELECT'] },
        },
      }),
      'public.notes': table(['id', 'body']),
    },
    sequences: { 'public.jobs_number_seq': { owner: 'jale_admin', acl: { jale_api: ['USAGE'] } } },
    policies: {
      'public.jobs.jobs_employer_all': policy('jobs_employer_all', 'ALL', ['jale_admin'], OWNER_CHECK),
      'public.jobs.jobs_employer_all__api': policy('jobs_employer_all__api', 'ALL', ['jale_api'], OWNER_CHECK),
      'public.jobs.jobs_relationship_read': policy('jobs_relationship_read', 'SELECT', ['jale_api'],
        `${HELPER.split('(')[0]}(current_setting('app.current_user_id'::text, true), id)`, [HELPER]),
      'public.jobs.jobs_public_read': policy('jobs_public_read', 'SELECT', ['PUBLIC'], "(status = 'open'::text)"),
      'public.jobs.jobs_cap_fixture_select': policy('jobs_cap_fixture_select', 'SELECT', ['jale_cap_fixture'], OWNER_CHECK),
      'public.jobs.jobs_open_read__new': policy('jobs_open_read__new', 'SELECT', ['jale_api'], "(status = 'open'::text)"),
    },
    functions: {
      [HELPER]: {
        owner: 'jale_rls_relationship_reader', security: 'definer', search_path: 'pg_catalog, pg_temp', language: 'plpgsql',
        kind: 'function', arguments: 'p_sub text, p_worker uuid', returns: 'boolean', acl: { jale_api: ['EXECUTE'] },
      },
      'public.fixture_proc(text)': {
        owner: 'jale_admin', security: 'invoker', search_path: null, language: 'plpgsql', kind: 'procedure',
        arguments: 'p_handle text', returns: null, acl: {},
      },
    },
    guc_refs: [],
  };
}

function check(mutate: (raw: Record<string, any>, snap: CatalogSnapshot) => void): CoverageViolation[] {
  const raw = manifestRaw();
  const snap = snapshot();
  mutate(raw, snap);
  return coverageViolations(snap, parseManifest(raw) as AccessManifest);
}

describe('coverageViolations', () => {
  it('a catalog that matches its manifest has no violation; a runner-managed table may be absent', () => {
    expect(check(() => undefined)).toEqual([]);
  });

  const cases: Array<[string, (raw: Record<string, any>, snap: CatalogSnapshot) => void, CoverageViolation]> = [
    // Check 1.
    ['an unclassified table', (_raw, snap) => { snap.tables['public.surprise'] = { ...snap.tables['public.notes'] }; },
      { check: 1, object: 'public.surprise', detail: 'table not classified in the manifest' }],
    ['a classified table that does not exist', (_raw, snap) => { delete snap.tables['public.notes']; },
      { check: 1, object: 'public.notes', detail: 'table classified in the manifest but absent' }],
    ['a table owned by the wrong role', (_raw, snap) => { snap.tables['public.notes'].owner = 'jale_whatsapp'; },
      { check: 1, object: 'public.notes', detail: 'owner jale_whatsapp; the manifest says jale_admin' }],
    ['an unclassified policy', (_raw, snap) => {
      snap.policies['public.jobs.jobs_extra'] = { ...snap.policies['public.jobs.jobs_employer_all'], name: 'jobs_extra' };
    }, { check: 1, object: 'public.jobs.jobs_extra', detail: 'policy not classified in the manifest' }],
    ['a policy whose command differs', (_raw, snap) => { snap.policies['public.jobs.jobs_relationship_read'].command = 'ALL'; },
      { check: 1, object: 'public.jobs.jobs_relationship_read', detail: 'policy is ALL PERMISSIVE TO jale_api; the manifest says SELECT PERMISSIVE TO jale_api' }],
    ['a copy that differs from its source', (_raw, snap) => { snap.policies['public.jobs.jobs_employer_all__api'].using = 'true'; },
      { check: 1, object: 'public.jobs.jobs_employer_all__api', detail: 'copy differs from its source jobs_employer_all' }],
    ['a copy source widened together with its copy', (_raw, snap) => {
      for (const key of ['public.jobs.jobs_employer_all', 'public.jobs.jobs_employer_all__api']) snap.policies[key].using = 'true';
    }, { check: 1, object: 'public.jobs.jobs_employer_all', detail: 'USING differs from the manifest' }],
    ['an unclassified function', (_raw, snap) => {
      snap.functions['public.surprise()'] = { ...snap.functions['public.fixture_proc(text)'], kind: 'function', returns: 'void', arguments: '' };
    }, { check: 1, object: 'public.surprise()', detail: 'function not classified in the manifest' }],
    ['an unclassified procedure', (_raw, snap) => {
      snap.functions['public.other_proc()'] = { ...snap.functions['public.fixture_proc(text)'], arguments: '' };
    }, { check: 1, object: 'public.other_proc()', detail: 'procedure not classified in the manifest' }],
    ['a procedure classified as a function', (raw) => {
      delete raw.functions['public.fixture_proc(text)'].kind;
      raw.functions['public.fixture_proc(text)'].returns = 'void';
    }, { check: 1, object: 'public.fixture_proc(text)', detail: 'definition differs from the manifest: kind, returns' }],
    ['a function whose owner or security differs', (_raw, snap) => {
      snap.functions[HELPER].owner = 'jale_admin';
      snap.functions[HELPER].security = 'invoker';
    }, { check: 1, object: HELPER, detail: 'definition differs from the manifest: owner, security' }],
    ['an unclassified sequence', (_raw, snap) => { snap.sequences['public.surprise_seq'] = { owner: 'jale_admin', acl: {} }; },
      { check: 1, object: 'public.surprise_seq', detail: 'sequence not classified in the manifest' }],
    ['an unclassified schema', (_raw, snap) => { snap.schemas.surprise = { owner: 'jale_admin', acl: {} }; },
      { check: 1, object: 'surprise', detail: 'schema not classified in the manifest' }],
    ['a capability owner\'s policy widened', (_raw, snap) => { snap.policies['public.jobs.jobs_cap_fixture_select'].using = 'true'; },
      { check: 9, object: 'public.jobs.jobs_cap_fixture_select', detail: 'USING differs from the manifest' }],
    ['a new policy widened', (_raw, snap) => { snap.policies['public.jobs.jobs_open_read__new'].using = 'true'; },
      { check: 2, object: 'public.jobs.jobs_open_read__new', detail: 'USING differs from the manifest' }],
    ['a WITH CHECK added to a recorded policy', (_raw, snap) => { snap.policies['public.jobs.jobs_open_read__new'].with_check = 'true'; },
      { check: 2, object: 'public.jobs.jobs_open_read__new', detail: 'WITH CHECK differs from the manifest' }],
    // Check 2.
    ['an extra table grant to a runtime login', (_raw, snap) => { snap.tables['public.jobs'].acl.jale_api.push('DELETE'); },
      { check: 2, object: 'public.jobs', detail: 'jale_api holds DELETE; the manifest does not list it' }],
    ['a missing table grant', (_raw, snap) => { snap.tables['public.jobs'].acl = {}; },
      { check: 2, object: 'public.jobs', detail: 'jale_api lacks SELECT, which the manifest lists' }],
    ['an extra column grant', (_raw, snap) => { snap.tables['public.jobs'].column_acl.employer_id = { jale_whatsapp: ['SELECT'] }; },
      { check: 2, object: 'public.jobs', detail: 'jale_whatsapp holds SELECT (employer_id); the manifest does not list it' }],
    ['a table grant to PUBLIC', (_raw, snap) => { snap.tables['public.jobs'].acl.PUBLIC = ['SELECT']; },
      { check: 2, object: 'public.jobs', detail: 'PUBLIC holds SELECT' }],
    ['an extra EXECUTE', (_raw, snap) => { snap.functions['public.fixture_proc(text)'].acl.jale_api = ['EXECUTE']; },
      { check: 2, object: 'public.fixture_proc(text)', detail: 'EXECUTE held by jale_api; the manifest lists nobody' }],
    ['an extra sequence grant', (_raw, snap) => { snap.sequences['public.jobs_number_seq'].acl.jale_whatsapp = ['USAGE']; },
      { check: 2, object: 'public.jobs_number_seq', detail: 'USAGE held by jale_api, jale_whatsapp; the manifest lists jale_api' }],
    ['an extra schema grant', (_raw, snap) => { snap.schemas.jale_internal.acl.jale_whatsapp = ['USAGE']; },
      { check: 2, object: 'jale_internal', detail: 'USAGE held by jale_api, jale_whatsapp; the manifest lists jale_api' }],
    // Check 3.
    ['a runtime login with a right on an excluded table', (_raw, snap) => { snap.tables['public.notes'].acl = { jale_whatsapp: ['SELECT'] }; },
      { check: 3, object: 'public.notes', detail: 'excluded, but jale_whatsapp holds SELECT' }],
    // Check 4.
    ['a policy that calls a function its login cannot execute', (raw, snap) => {
      // Manifest and catalog agree that nobody holds EXECUTE: only check 4 is left.
      raw.functions[HELPER].execute = [];
      snap.functions[HELPER].acl = {};
    },
      { check: 4, object: 'public.jobs.jobs_relationship_read', detail: `applies to jale_api, which cannot execute ${HELPER}` }],
    // Check 6.
    ['a new PUBLIC policy', (raw, snap) => {
      snap.policies['public.jobs.jobs_open_read'] = { ...snap.policies['public.jobs.jobs_public_read'], name: 'jobs_open_read' };
      raw.policies['public.jobs.jobs_open_read'] = { ...raw.policies['public.jobs.jobs_public_read'] };
      delete raw.policies['public.jobs.jobs_open_read'].verdict;
    }, { check: 6, object: 'public.jobs.jobs_open_read', detail: 'PUBLIC policy without a reviewed keep verdict' }],
    // Check 9.
    ['a capability owner with CREATE on public', (_raw, snap) => { snap.schemas.public.acl.jale_cap_fixture = ['CREATE']; },
      { check: 9, object: 'public', detail: 'capability owner jale_cap_fixture holds CREATE on public' }],
    ['a capability owner with a right the manifest does not list', (_raw, snap) => {
      snap.tables['public.jobs'].column_acl.title.jale_cap_fixture = ['SELECT'];
    }, { check: 9, object: 'public.jobs', detail: 'jale_cap_fixture holds SELECT (title); the manifest does not list it' }],
  ];

  it.each(cases)('names %s', (_label, mutate, violation) => {
    expect(check(mutate)).toEqual([violation]);
  });

  it('names a policy for a login the manifest does not list, and the function that login cannot execute', () => {
    expect(check((_raw, snap) => {
      snap.policies['public.jobs.jobs_relationship_read'].roles = ['jale_api', 'jale_whatsapp'];
    })).toEqual([
      {
        check: 2, object: 'public.jobs.jobs_relationship_read',
        detail: 'policy is SELECT PERMISSIVE TO jale_api, jale_whatsapp; the manifest says SELECT PERMISSIVE TO jale_api',
      },
      { check: 4, object: 'public.jobs.jobs_relationship_read', detail: `applies to jale_whatsapp, which cannot execute ${HELPER}` },
    ]);
  });

  it('returns violations in a stable order', () => {
    const result = check((_raw, snap) => {
      snap.tables['public.zz_late'] = { ...snap.tables['public.notes'] };
      snap.tables['public.aa_early'] = { ...snap.tables['public.notes'] };
    });
    expect(result.map((v) => v.object)).toEqual(['public.aa_early', 'public.zz_late']);
  });
});
