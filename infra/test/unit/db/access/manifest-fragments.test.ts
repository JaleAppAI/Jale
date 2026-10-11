/**
 * manifest-fragments.test.ts -- manifest.json plus manifest.d/*.json.
 *
 * A later change adds its own objects in a fragment instead of editing
 * manifest.json, so independent changes never edit the same file. A fragment
 * has the same top-level sections and only adds entries: a key that already
 * exists, in manifest.json or in an earlier fragment, is a hard error.
 * Fragments merge in filename order. With no manifest.d, or an empty one, the
 * loader behaves exactly as before.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  canonicalJson, dedicatedLogins, loadManifest, manifestDigest, mergeManifest, parseManifest, runtimeLogins,
} from '../../../../db/access/access-manifest';

const shippedDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'access');
const shippedBase = () => JSON.parse(fs.readFileSync(path.join(shippedDir, 'manifest.json'), 'utf8'));

const jobLogin = {
  kind: 'job',
  created_by: '107',
  connection_limit: 5,
  prepare_secret: true,
  workloads: 'A fragment-defined export job.',
  reason: 'Fixture login added by a fragment.',
};
const fragmentTable = {
  classification: 'excluded',
  rls: { enabled: true, forced: true },
  reason: 'Fixture table added by a fragment.',
  access: {},
};

let tmp: string;

function writeDir(fragments: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'access-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(shippedBase()));
  if (fragments) {
    fs.mkdirSync(path.join(dir, 'manifest.d'));
    for (const [name, body] of Object.entries(fragments)) {
      fs.writeFileSync(path.join(dir, 'manifest.d', name), typeof body === 'string' ? body : JSON.stringify(body));
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

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-manifest-fragments-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('manifest fragments', () => {
  it('loads the shipped directory', () => {
    expect(loadManifest()).toEqual(loadManifest(shippedDir));
  });

  it('behaves exactly as before with no manifest.d, or an empty one', () => {
    const expected = parseManifest(shippedBase());
    expect(loadManifest(writeDir(null))).toEqual(expected);
    expect(loadManifest(writeDir({}))).toEqual(expected);
  });

  it('merges two fragments in filename order, adding their entries', () => {
    const dir = writeDir({
      'b-second.json': { tables: { 'public.fragment_b': fragmentTable } },
      'a-first.json': {
        logins: { jale_job_fragment_export: jobLogin },
        tables: { 'public.fragment_a': fragmentTable },
        exceptions: [{ workload: 'A fragment job', login: 'jale_job_fragment_export', reason: 'Fixture.' }],
      },
    });
    const merged = loadManifest(dir);
    expect(Object.keys(merged.tables).slice(-2)).toEqual(['public.fragment_a', 'public.fragment_b']);
    expect(merged.logins.jale_job_fragment_export).toEqual(jobLogin);
    expect(runtimeLogins(merged)).toContain('jale_job_fragment_export');
    expect(dedicatedLogins(merged)).toContain('jale_job_fragment_export');
    expect(merged.exceptions.at(-1)).toEqual({ workload: 'A fragment job', login: 'jale_job_fragment_export', reason: 'Fixture.' });
  });

  it('ignores files that are not .json', () => {
    const dir = writeDir({ 'README.md': 'not a fragment' });
    expect(loadManifest(dir)).toEqual(parseManifest(shippedBase()));
  });

  it('refuses a dot-named file, which shell globs skip, so every reader of manifest.d sees the same fragments', () => {
    const hiddenFragment = writeDir({ '.zz-hidden.json': { tables: { 'public.fragment_hidden': fragmentTable } } });
    expect(loadError(hiddenFragment)).toBe(
      'access manifest: manifest.d holds dot-named files (.zz-hidden.json); shell globs skip them, so rename or remove them',
    );
    const twoHidden = writeDir({ '.gitkeep': '', '.a.json.swp': 'x', 'b-second.json': { tables: { 'public.fragment_b': fragmentTable } } });
    expect(loadError(twoHidden)).toBe(
      'access manifest: manifest.d holds dot-named files (.a.json.swp, .gitkeep); shell globs skip them, so rename or remove them',
    );
  });

  it('rejects a key that already exists in manifest.json', () => {
    const dir = writeDir({ 'dup.json': { tables: { 'public.users': fragmentTable } } });
    expect(loadError(dir)).toContain('manifest.d/dup.json: tables.public.users already exists');
  });

  it('rejects a key that an earlier fragment already added', () => {
    const dir = writeDir({
      'a.json': { logins: { jale_job_fragment_export: jobLogin } },
      'b.json': { logins: { jale_job_fragment_export: jobLogin } },
    });
    expect(loadError(dir)).toContain('manifest.d/b.json: logins.jale_job_fragment_export already exists');
  });

  it('rejects the same key in every section: function, login, group, owner, helper role', () => {
    const base = shippedBase();
    const someKey = (section: string) => Object.keys(base[section])[0];
    for (const section of ['functions', 'logins', 'groups', 'capability_owners', 'helper_roles', 'policies', 'sequences', 'schemas']) {
      const key = someKey(section);
      const dir = writeDir({ 'dup.json': { [section]: { [key]: base[section][key] } } });
      expect(loadError(dir)).toContain(`manifest.d/dup.json: ${section}.${key} already exists`);
    }
  });

  it('rejects a policy name that manifest.json already uses on the same table', () => {
    const base = shippedBase();
    const [key, entry] = Object.entries(base.policies as Record<string, unknown>)[0];
    const dir = writeDir({ 'dup.json': { policies: { [key]: entry } } });
    expect(loadError(dir)).toContain(`manifest.d/dup.json: policies.${key} already exists`);
  });

  it('accepts a fragment policy with a new name on a table the fragment adds', () => {
    const dir = writeDir({
      'a.json': {
        tables: { 'public.fragment_a': { ...fragmentTable, classification: 'access' } },
        policies: {
          'public.fragment_a.fragment_a_read': {
            command: 'SELECT', permissive: true, to: ['jale_api'], origin: 'existing', reason: 'Fixture policy.',
          },
        },
      },
    });
    expect(Object.keys(loadManifest(dir).policies)).toContain('public.fragment_a.fragment_a_read');
  });

  it('rejects a fragment that redefines the version or the master, or adds an unknown section', () => {
    expect(loadError(writeDir({ 'v.json': { version: 1 } }))).toContain('manifest.d/v.json: version belongs to manifest.json only');
    expect(loadError(writeDir({ 'm.json': { master: 'jale_admin' } }))).toContain('manifest.d/m.json: master belongs to manifest.json only');
    expect(loadError(writeDir({ 'x.json': { surprises: {} } }))).toContain('manifest.d/x.json: unknown section surprises');
  });

  it('rejects a fragment that is not a JSON object', () => {
    expect(loadError(writeDir({ 'bad.json': '{ not json' }))).toContain('manifest.d/bad.json: not valid JSON');
    expect(loadError(writeDir({ 'arr.json': [] }))).toContain('manifest.d/arr.json: not a JSON object');
  });

  it('validates the merged result as a whole', () => {
    const orphan = { workload: 'x', login: 'jale_nobody', reason: 'x' };
    expect(loadError(writeDir({ 'e.json': { exceptions: [orphan] } }))).toContain('names unknown login jale_nobody');
  });

  it('mergeManifest is pure: it never changes its inputs', () => {
    const base = shippedBase();
    const before = JSON.stringify(base);
    const fragment = { name: 'f.json', raw: { tables: { 'public.fragment_a': fragmentTable } } };
    mergeManifest(base, [fragment]);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('manifestDigest', () => {
  /** A deep copy with every object's keys in reverse order. */
  function reversedKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reversedKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversedKeys(v)]));
    }
    return value;
  }

  it('canonical JSON sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], e: null, f: 'x' }))
      .toBe('{"a":[2,{"c":2,"d":1}],"b":1,"e":null,"f":"x"}');
  });

  it('is the sha256 of the canonical JSON of the merged manifest', () => {
    const manifest = loadManifest();
    expect(manifestDigest(manifest)).toBe(createHash('sha256').update(canonicalJson(manifest)).digest('hex'));
    expect(manifestDigest(manifest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const manifest = loadManifest();
    expect(manifestDigest(parseManifest(reversedKeys(manifest)))).toBe(manifestDigest(manifest));
  });

  it('changes when a fragment adds an entry', () => {
    const plain = loadManifest(writeDir(null));
    const withFragment = loadManifest(writeDir({ 'a.json': { tables: { 'public.fragment_a': fragmentTable } } }));
    expect(manifestDigest(withFragment)).not.toBe(manifestDigest(plain));
  });
});
