import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalJson, loadManifest, manifestDigest, parseManifest } from '../../../db/access/access-manifest';
import { changeLogDigest, loadChangeLog, parseChangeLog, type ChangeLog } from '../../../db/access/posture-audit';
import { writePostureExpectation } from '../../../scripts/write-posture-expectation';

/**
 * The posture expectation writer (scripts/write-posture-expectation.ts).
 *
 * The deploy job runs it just before the database posture gate, which sends
 * what it writes to the posture function. These tests pin what the file
 * holds, that its digests are the ones the library computes, and that the
 * writer touches nothing but the one path it is given.
 */

const INFRA = path.join(__dirname, '../../..');
const SCRIPT = path.join(INFRA, 'scripts/write-posture-expectation.ts');
const TSX_CLI = path.join(INFRA, 'node_modules/tsx/dist/cli.mjs');
const ACCESS_DIR = path.join(INFRA, 'db/access');

/** A deep copy with every object's keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Every file under `dir`, relative to it, with its size and modification time. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe('write-posture-expectation', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posture-expectation-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function writeAndRead(): Record<string, unknown> {
    const file = path.join(workDir, 'posture-expected.json');
    writePostureExpectation(file);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  describe('what it writes', () => {
    it('writes the manifest, the change log and their two digests, and nothing else', () => {
      expect(Object.keys(writeAndRead()).sort()).toEqual(['change_log', 'change_log_sha256', 'manifest', 'manifest_sha256']);
    });

    it('writes the merged manifest, with the digest manifestDigest gives it', () => {
      const written = writeAndRead();
      const manifest = loadManifest();
      expect(written.manifest_sha256).toBe(manifestDigest(manifest));
      expect(manifestDigest(parseManifest(written.manifest))).toBe(manifestDigest(manifest));
      expect(written.manifest).toEqual(manifest);
    });

    it('writes the change log, which parses, with the digest changeLogDigest gives it', () => {
      const written = writeAndRead();
      const changeLog = loadChangeLog();
      expect(() => parseChangeLog(written.change_log)).not.toThrow();
      expect(written.change_log).toEqual(changeLog);
      expect(written.change_log_sha256).toBe(changeLogDigest(changeLog));
      expect(changeLogDigest(parseChangeLog(written.change_log))).toBe(written.change_log_sha256);
    });
  });

  describe('changeLogDigest', () => {
    const changeLog = loadChangeLog();

    it('is the sha256, in hex, of the canonical JSON, as manifestDigest is for the manifest', () => {
      const expected = createHash('sha256').update(canonicalJson(changeLog)).digest('hex');
      expect(changeLogDigest(changeLog)).toBe(expected);
      expect(changeLogDigest(changeLog)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not depend on the order of the keys in the file', () => {
      const reordered = parseChangeLog(JSON.parse(JSON.stringify(reverseKeys(changeLog))));
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(changeLog));
      expect(changeLogDigest(reordered)).toBe(changeLogDigest(changeLog));
    });

    it('changes when the content changes', () => {
      const changed = JSON.parse(JSON.stringify(changeLog)) as ChangeLog;
      const [first] = Object.keys(changed.tables);
      changed.tables[first] = { ...changed.tables[first], reason: `${changed.tables[first].reason} (edited)` };
      expect(changeLogDigest(parseChangeLog(changed))).not.toBe(changeLogDigest(changeLog));
    });
  });

  describe('run as the deploy job runs it', () => {
    let cwd: string;
    let tmp: string;

    beforeEach(() => {
      cwd = path.join(workDir, 'cwd');
      tmp = path.join(workDir, 'tmp');
      fs.mkdirSync(cwd);
      fs.mkdirSync(tmp);
    });

    /** Through the tsx CLI, as the workflow runs it, from `cwd` and with its own temporary directory. */
    function run(args: string[]) {
      return spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
        cwd,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp },
      });
    }

    /** The temporary directory's entries, less the tsx-<uid> directory the tsx CLI keeps for itself. */
    function tmpEntries(): string[] {
      return fs.readdirSync(tmp).filter((name) => !/^tsx-\d+$/.test(name));
    }

    it('writes only the path it is given, and prints only that path', () => {
      const outDir = path.join(workDir, 'out');
      fs.mkdirSync(outDir);
      const out = path.join(outDir, 'posture-expected.json');
      const accessBefore = listing(ACCESS_DIR);

      const result = run([out]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`wrote ${out}\n`);
      expect(fs.readdirSync(outDir)).toEqual(['posture-expected.json']);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(tmpEntries()).toEqual([]);
      expect(listing(ACCESS_DIR)).toEqual(accessBefore);
      const written = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>;
      expect(written.manifest_sha256).toBe(manifestDigest(loadManifest()));
      expect(written.change_log_sha256).toBe(changeLogDigest(loadChangeLog()));
    });

    it.each([[[]], [['one.json', 'two.json']], [['']]])('refuses arguments %j without writing anything', (args) => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^usage: /);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(tmpEntries()).toEqual([]);
    });

    it('fails with one fixed line when the path cannot be written', () => {
      const out = path.join(workDir, 'missing-dir', 'posture-expected.json');
      const result = run([out]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('::error::The posture expectation could not be written.\n');
      expect(fs.existsSync(path.dirname(out))).toBe(false);
      expect(fs.readdirSync(cwd)).toEqual([]);
    });
  });
});
