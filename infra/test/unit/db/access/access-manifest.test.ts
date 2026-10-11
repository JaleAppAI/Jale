/**
 * access-manifest.test.ts -- the manifest's structural rules, on the shipped
 * file and on small broken copies of it.
 *
 * Two consumers outside the database tooling read the `logins` section: the
 * credential preparation step, which prepares a secret for exactly the logins
 * that carry `prepare_secret: true`, and the ops host's secret wiring. So the
 * key is required on every dedicated login and forbidden on the service
 * logins that predate them.
 */
import * as path from 'path';
import {
  dedicatedLogins, loadManifest, parseManifest, readManifestFiles,
} from '../../../../db/access/access-manifest';

const shippedDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'access');

function shippedCopy(): Record<string, any> {
  return JSON.parse(JSON.stringify(loadManifest()));
}

/**
 * manifest.json alone. Assertions about this change's own logins, settings
 * and roles read it, so a later change's fragment (which only adds) never
 * breaks them; structural rules still run on the merged manifest.
 */
function baseManifest() {
  return parseManifest(readManifestFiles(shippedDir).base);
}

function problemsOf(raw: unknown): string {
  try {
    parseManifest(raw);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('access manifest logins', () => {
  it('flags exactly the dedicated logins of manifest.json for secret preparation', () => {
    const manifest = baseManifest();
    const flagged = Object.entries(manifest.logins)
      .filter(([, entry]) => entry.prepare_secret === true)
      .map(([name]) => name)
      .sort();
    expect(flagged).toEqual([
      'jale_api',
      'jale_api_public',
      'jale_job_digest',
      'jale_job_email_sender',
      'jale_job_retention',
      'jale_job_ses_feedback',
      'jale_job_visibility_drain',
      'jale_posture',
    ]);
    expect(dedicatedLogins(manifest)).toEqual(flagged);
  });

  it('flags every non-service login of the merged manifest, fragments included', () => {
    const manifest = loadManifest();
    const unflagged = Object.entries(manifest.logins)
      .filter(([, entry]) => entry.kind !== 'service' && entry.prepare_secret !== true)
      .map(([name]) => name);
    expect(unflagged).toEqual([]);
    expect(dedicatedLogins(manifest)).toEqual(
      Object.keys(manifest.logins).filter((name) => manifest.logins[name].kind !== 'service').sort(),
    );
  });

  it('leaves the key off every pre-existing service login, jale_ai included', () => {
    const manifest = baseManifest();
    const service = Object.entries(manifest.logins)
      .filter(([, entry]) => entry.kind === 'service')
      .map(([name, entry]) => [name, 'prepare_secret' in entry]);
    expect(service.sort()).toEqual([
      ['jale_admin_console', false],
      ['jale_ai', false],
      ['jale_billing', false],
      ['jale_matching', false],
      ['jale_public_jobs', false],
      ['jale_whatsapp', false],
    ]);
  });

  it('requires prepare_secret: true on every dedicated login', () => {
    const missing = shippedCopy();
    delete missing.logins.jale_api.prepare_secret;
    expect(problemsOf(missing)).toContain('logins.jale_api.prepare_secret must be true for a request login');

    const stringy = shippedCopy();
    stringy.logins.jale_posture.prepare_secret = 'true';
    expect(problemsOf(stringy)).toContain('logins.jale_posture.prepare_secret must be true for a posture login');

    const off = shippedCopy();
    off.logins.jale_job_digest.prepare_secret = false;
    expect(problemsOf(off)).toContain('logins.jale_job_digest.prepare_secret must be true for a job login');
  });

  it('forbids the key on a service login, whatever its value', () => {
    for (const value of [true, false]) {
      const service = shippedCopy();
      service.logins.jale_ai.prepare_secret = value;
      expect(problemsOf(service)).toContain('logins.jale_ai.prepare_secret must be absent for a service login');
    }
  });
});

describe('access manifest login settings', () => {
  const SEVEN = [
    'jale_api', 'jale_api_public', 'jale_job_digest', 'jale_job_email_sender',
    'jale_job_retention', 'jale_job_ses_feedback', 'jale_job_visibility_drain',
  ];

  it('ends idle-in-transaction sessions after 60s on the seven runtime logins 104 creates, and sets nothing else', () => {
    const manifest = baseManifest();
    const withSettings = Object.entries(manifest.logins)
      .filter(([, entry]) => entry.settings !== undefined)
      .map(([name, entry]) => [name, entry.settings])
      .sort();
    expect(withSettings).toEqual(SEVEN.map((name) => [name, { idle_in_transaction_session_timeout: '60s' }]));
    expect(manifest.logins.jale_posture.settings).toBeUndefined();
  });

  it('rejects malformed settings', () => {
    const notObject = shippedCopy();
    notObject.logins.jale_api.settings = ['idle_in_transaction_session_timeout=60s'];
    expect(problemsOf(notObject)).toContain('logins.jale_api.settings must map setting names to values');

    const badName = shippedCopy();
    badName.logins.jale_api.settings = { 'Bad-Name': '1' };
    expect(problemsOf(badName)).toContain('logins.jale_api.settings: Bad-Name is not a setting name');

    const empty = shippedCopy();
    empty.logins.jale_api.settings = { idle_in_transaction_session_timeout: '' };
    expect(problemsOf(empty)).toContain('logins.jale_api.settings.idle_in_transaction_session_timeout must be a non-empty string');
  });
});

describe('access manifest platform roles', () => {
  it('lists the database service\'s own roles, each with a reason', () => {
    const roles = baseManifest().platform_roles;
    expect(Object.keys(roles).sort()).toEqual(['rdsadmin', 'rdsrepladmin', 'rdstopmgr']);
    for (const entry of Object.values(roles)) expect(entry.reason).toMatch(/\S/);
  });

  it('rejects a platform role that is also a role the manifest manages, or the master', () => {
    const copy = shippedCopy();
    copy.platform_roles.jale_api = { reason: 'x' };
    copy.platform_roles.jale_admin = { reason: 'x' };
    copy.platform_roles.rdsadmin = {};
    const problems = problemsOf(copy);
    expect(problems).toContain('platform_roles.jale_api is also listed as a login');
    expect(problems).toContain('platform_roles.jale_admin is the master');
    expect(problems).toContain('platform_roles.rdsadmin.reason is missing');
  });
});

describe('access manifest operator group', () => {
  it('pins the one accepted member grant: INHERIT TRUE, SET FALSE, no ADMIN', () => {
    expect(loadManifest().groups.jale_ops_readonly.member_rules.grant_options)
      .toEqual({ admin: false, inherit: true, set: false });
  });

  it('rejects any other member grant shape', () => {
    for (const shape of [
      { admin: false, inherit: true, set: true },
      { admin: false, inherit: false, set: false },
      { admin: true, inherit: true, set: false },
    ]) {
      const copy = shippedCopy();
      copy.groups.jale_ops_readonly.member_rules.grant_options = shape;
      expect(problemsOf(copy)).toContain(
        'groups.jale_ops_readonly.member_rules.grant_options must be { admin: false, inherit: true, set: false }',
      );
    }
    const missing = shippedCopy();
    delete missing.groups.jale_ops_readonly.member_rules.grant_options;
    expect(problemsOf(missing)).toContain(
      'groups.jale_ops_readonly.member_rules.grant_options must be { admin: false, inherit: true, set: false }',
    );
  });

  it('accepts the shipped manifest', () => {
    expect(problemsOf(shippedCopy())).toBe('');
  });
});

describe('access manifest object sections', () => {
  const manifest = () => loadManifest();

  it('has the schemas, sequences and policies sections', () => {
    const m = manifest();
    expect(Object.keys(m.schemas).length).toBeGreaterThan(0);
    expect(Object.keys(m.sequences).length).toBeGreaterThan(0);
    expect(Object.keys(m.policies).length).toBeGreaterThan(0);
  });

  it('keys every policy schema.table.policy, on a classified table', () => {
    const m = manifest();
    for (const key of Object.keys(m.policies)) {
      const [schema, table] = key.split('.');
      expect(m.tables[`${schema}.${table}`]).toBeDefined();
    }
  });

  it('rejects a policy on a table the manifest does not classify', () => {
    const copy = shippedCopy();
    copy.policies['public.nowhere.p'] = {
      command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'existing', reason: 'x',
    };
    expect(problemsOf(copy)).toContain('policies.public.nowhere.p: table public.nowhere is not classified');
  });

  it('rejects a copy without a source, or whose source is not an existing policy on the same table', () => {
    const noSource = shippedCopy();
    noSource.policies['public.jobs.x__api'] = {
      command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'copy', reason: 'x',
    };
    expect(problemsOf(noSource)).toContain('policies.public.jobs.x__api: a copy needs copy_of');

    const badSource = shippedCopy();
    badSource.policies['public.jobs.nothing_here__api'] = {
      command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'copy', copy_of: 'nothing_here', reason: 'x',
    };
    expect(problemsOf(badSource)).toContain('policies.public.jobs.nothing_here__api: copy_of names no existing policy public.jobs.nothing_here');
  });

  it('requires a new policy to state its expressions, and an open one to say so', () => {
    const empty = shippedCopy();
    empty.policies['public.jobs.fresh'] = {
      command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'new', reason: 'x',
    };
    expect(problemsOf(empty)).toContain('policies.public.jobs.fresh: a new policy needs using or with_check');

    const open = shippedCopy();
    open.policies['public.jobs.fresh'] = {
      command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'new', using: 'true', with_check: null, reason: 'x',
    };
    expect(problemsOf(open)).toContain('policies.public.jobs.fresh: an unrestricted policy must carry open: true');
  });

  it('rejects unknown roles in policies, schemas, sequences, function grants and table access', () => {
    const copy = shippedCopy();
    const policyKey = Object.keys(copy.policies)[0];
    copy.policies[policyKey].to = ['jale_nobody'];
    const schemaKey = Object.keys(copy.schemas)[0];
    copy.schemas[schemaKey].usage = ['jale_nobody'];
    const sequenceKey = Object.keys(copy.sequences)[0];
    copy.sequences[sequenceKey].usage = ['jale_nobody'];
    const fnKey = Object.keys(copy.functions)[0];
    copy.functions[fnKey].execute = ['jale_nobody'];
    copy.tables['public.jobs'].access = { jale_nobody: { select: '*' } };
    const problems = problemsOf(copy);
    expect(problems).toContain(`policies.${policyKey}.to names unknown role jale_nobody`);
    expect(problems).toContain(`schemas.${schemaKey}.usage names unknown role jale_nobody`);
    expect(problems).toContain(`sequences.${sequenceKey}.usage names unknown role jale_nobody`);
    expect(problems).toContain(`functions.${fnKey}.execute names unknown role jale_nobody`);
    expect(problems).toContain('tables.public.jobs.access names unknown role jale_nobody');
  });

  it('accepts PUBLIC as a grantee of a function, schema or policy', () => {
    const copy = shippedCopy();
    const fnKey = Object.keys(copy.functions)[0];
    copy.functions[fnKey].execute = ['PUBLIC'];
    expect(problemsOf(copy)).toBe('');
  });
});

describe('access manifest policy expressions', () => {
  const base = parseManifest(readManifestFiles(shippedDir).base);
  const owners = new Set(Object.keys(base.capability_owners));
  const created = Object.entries(base.policies)
    .filter(([, p]) => p.origin === 'new' || (p.origin === 'existing' && p.to.every((role) => owners.has(role))));

  it('records the USING and WITH CHECK of every policy the least-privilege migrations create, for the guard and posture to compare', () => {
    const missing = created.filter(([, p]) => p.using === undefined || p.with_check === undefined).map(([key]) => key);
    expect(missing).toEqual([]);
    // 36 capability-owner policies (105) and 7 new policies (106).
    expect(created.filter(([, p]) => p.origin === 'existing')).toHaveLength(36);
    expect(created.filter(([, p]) => p.origin === 'new')).toHaveLength(7);
  });

  it('refuses a recorded expression that is neither text nor null', () => {
    const raw = JSON.parse(JSON.stringify(readManifestFiles(shippedDir).base)) as Record<string, any>;
    const [key] = created.find(([, p]) => p.origin === 'existing')!;
    raw.policies[key].using = 42;
    expect(() => parseManifest(raw)).toThrow(/a recorded using and with_check must both be text or null/);
  });
});

describe('access manifest reviewed expressions', () => {
  const merged = loadManifest(shippedDir);
  const owners = new Set(Object.keys(merged.capability_owners));
  const tableOf = (key: string) => key.split('.').slice(0, 2).join('.');
  const sources = new Set(Object.entries(merged.policies)
    .filter(([, p]) => p.origin === 'copy')
    .map(([key, p]) => `${tableOf(key)}.${p.copy_of}`));
  const reviewed = Object.entries(merged.policies)
    .filter(([key, p]) => p.origin === 'existing' && (sources.has(key) || p.to.some((role) => owners.has(role))));

  it('records the USING and WITH CHECK of every copy source and every capability owner\'s policy, fragments included', () => {
    expect(reviewed.filter(([, p]) => p.using === undefined || p.with_check === undefined).map(([key]) => key)).toEqual([]);
    // 38 copy sources; 36 capability-owner policies in manifest.json and 28 in the report fragment.
    expect(reviewed.filter(([key]) => sources.has(key))).toHaveLength(38);
    expect(reviewed.filter(([, p]) => p.to.some((role) => owners.has(role)))).toHaveLength(64);
  });

  it('refuses a copy source that does not record its expressions', () => {
    const raw = JSON.parse(JSON.stringify(readManifestFiles(shippedDir).base)) as Record<string, any>;
    const [copyKey, copy] = Object.entries(raw.policies as Record<string, any>).find(([, p]) => p.origin === 'copy')!;
    const source = `${tableOf(copyKey)}.${copy.copy_of}`;
    delete raw.policies[source].using;
    delete raw.policies[source].with_check;
    expect(problemsOf(raw)).toContain(`policies.${source}: a copy source must record its using and with_check`);
  });

  it('refuses a capability owner\'s policy that does not record its expressions', () => {
    const raw = JSON.parse(JSON.stringify(readManifestFiles(shippedDir).base)) as Record<string, any>;
    const baseOwners = new Set(Object.keys(raw.capability_owners));
    const [key] = Object.entries(raw.policies as Record<string, any>)
      .find(([, p]) => p.origin === 'existing' && p.to.some((role: string) => baseOwners.has(role)))!;
    delete raw.policies[key].with_check;
    expect(problemsOf(raw)).toContain(`policies.${key}: a capability owner's policy must record its using and with_check`);
  });
});
