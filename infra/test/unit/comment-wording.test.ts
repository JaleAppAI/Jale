/**
 * Comments and test names describe what the code does, and what the local
 * test bed does when a suite needs a database. This check refuses wording
 * that earlier comments and test names used, in the trees it scans: the
 * tests, the Lambda sources, the infra scripts, the test-bed scripts, and
 * the migrations from 103 on. Earlier migrations are frozen, so they are
 * never scanned.
 *
 * Each refused phrase is stored base64-encoded, so this file never spells
 * one, and a hit is reported by file, line and phrase number only. Matching
 * ignores case and comment markers, and joins consecutive lines, so a phrase
 * that wraps across two comment lines is still found.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const INFRA = path.resolve(__dirname, '../..');
const SELF = path.resolve(__filename);
const ALL = ['test/unit', 'lambda', 'scripts', 'db/local', 'db/migrations'] as const;
/** Migrations before this number are frozen: their text never changes, so they are not scanned. */
const FIRST_SCANNED_MIGRATION = 103;
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.sql']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'cdk.out', 'dist', 'coverage']);

/** [the phrase, base64-encoded; the roots under infra/ where it is refused]. */
const REFUSED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['amFsZV9hZG1pbidzIG93biByb3ctbGV2ZWwgc2VjdXJpdHk=', ALL],
  ['b3duZXIgbG9naW4gd2l0aG91dCByb3cgcG9saWNpZXM=', ALL],
  ['b3duZXIgbG9naW4gcnVucyB3aXRob3V0IHJvdyBwb2xpY2llcw==', ALL],
  ['cmVhbCBqYWxlX2FkbWlu', ALL],
  ['d2hpY2ggdW5kZXIgRk9SQ0Ugc2Vlcw==', ALL],
  ['b2JleSB0aGVpciBwb2xpY2llcw==', ALL],
  ['dGhlIHJvbGUgdGhlIG1pZ3JhdGlvbiBydW5zIGFz', ALL],
  ['dGhlIHJvbGUgdGhpcyBmaWxlIHJ1bnMgYXM=', ALL],
  ['amFsZV9hZG1pbidzIG93biByZWFkcw==', ALL],
  // These two stay in a few older test comments, and in one assertion that an
  // old header line stays absent, so they are refused everywhere but the tests.
  ['cHJvZHVjdGlvbiBvd25lcnNoaXAgbW9kZWw=', ['lambda', 'scripts', 'db/local', 'db/migrations']],
  ['UkRTIG1hc3RlciB1c2Vy', ['lambda', 'scripts', 'db/local', 'db/migrations']],
  ['YXMgdGhleSBkbyBpbiBwcm9kdWN0aW9u', ALL],
  ['aXMgYW4gb3JkaW5hcnkgbG9naW4=', ALL],
  ['YW4gb3JkaW5hcnkgbG9naW4gdGhhdCBSTFM=', ALL],
  ['cG9saWN5LWZpbHRlcmVk', ALL],
  ['YSBiYXJlIGphbGVfYWRtaW4gVVBEQVRF', ALL],
  ['YXMgamFsZV9hZG1pbiBhZmZlY3RzIHplcm8gcm93cw==', ALL],
  ['ZXZlbiBqYWxlX2FkbWluIGNhbm5vdA==', ALL],
  ['cmVhbCBvd25lciBSTFMgY29udGV4dA==', ALL],
  ['UkxTIHByb3ZlcyBub3RoaW5n', ['test/unit', 'lambda/api']],
  ['cmVhZHMgb25seSB0aGUgY2FsbGVyJ3Mgb3duIGxpbmtz', ALL],
  ['d2l0aG91dCBpdCB0aGUgd3JpdGUgaXMgcmVmdXNlZA==', ALL],
  ['aXMgYWN0aXZlIGZvciBpdCBvbiBhIEZPUkNFIHRhYmxl', ALL],
  ['REVGSU5FUi1iYXNlZCBSTFMgcG9saWNpZXM=', ALL],
  ['UkxTIHJldHVybnMgbm8gcm93cw==', ALL],
  ['dGhlIHF1ZXJ5IHRoZSBSTFMgcG9saWN5IGdvdmVybnM=', ALL],
  ['bm8gcG9saWN5IGZpbHRlcnMgYW55dGhpbmcgZm9y', ALL],
  ['YWxyZWFkeSBoaWRlcyB2YXVsdCByb3dz', ALL],
  ['d3JpdGUgaXMgc2lsZW50bHkgZmlsdGVyZWQ=', ALL],
  ['UkxTIGhpZGVzIHRoZSBqb2I=', ALL],
  ['UkxTIG93bmVyc2hpcCBjaGVjayBjYW5ub3Qgc2Vl', ALL],
  ['UkxTIHJldHVybnMgbm8gdmF1bHQgZG9jcw==', ALL],
  ['b24gYW4gUkxTIGRlbmlhbA==', ALL],
];

const phrases = REFUSED.map(([encoded, roots], index) => ({
  number: index + 1,
  text: Buffer.from(encoded, 'base64').toString('utf8').toLowerCase(),
  roots,
}));

function migrationNumber(file: string): number | null {
  const match = /^(\d{3})_/.exec(path.basename(file));
  return match ? Number(match[1]) : null;
}

/** Every text file under a root (relative to infra/), skipping build output and frozen migrations. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (EXTENSIONS.has(path.extname(entry.name)) && full !== SELF) {
        out.push(full);
      }
    }
  };
  walk(path.join(INFRA, root));
  if (root !== 'db/migrations') return out;
  return out.filter((file) => {
    const number = migrationNumber(file);
    return number !== null && number >= FIRST_SCANNED_MIGRATION;
  });
}

/**
 * The file as one lowercase string: each line loses its indentation and a
 * leading comment marker, consecutive lines are joined with one space, and
 * runs of spaces collapse. `lineAt` maps an offset back to its 1-based line.
 */
function flatten(text: string): { flat: string; lineAt: (offset: number) => number } {
  const starts: number[] = [];
  let flat = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(\{\/\*|\/\/+|\/\*+|\*+\/?|--+|#+)\s?/, '').replace(/\s+/g, ' ');
    if (flat.length > 0) flat += ' ';
    starts.push(flat.length);
    flat += line.toLowerCase();
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
  return { flat, lineAt };
}

/** Hits as `file:line #phrase`, never the matched text. */
function scan(file: string, text: string, refused: typeof phrases): string[] {
  const { flat, lineAt } = flatten(text);
  const hits: string[] = [];
  for (const phrase of refused) {
    for (let at = flat.indexOf(phrase.text); at !== -1; at = flat.indexOf(phrase.text, at + 1)) {
      hits.push(`${file}:${lineAt(at)} #${phrase.number}`);
    }
  }
  return hits;
}

describe('comment wording', () => {
  it('decodes every refused phrase to plain text', () => {
    for (const phrase of phrases) {
      expect(phrase.text.length).toBeGreaterThan(8);
      expect(phrase.text).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('finds a phrase that wraps across two comment lines, and names its first line', () => {
    const words = phrases[0].text.split(' ');
    const cut = Math.floor(words.length / 2);
    const sample = [
      'const unrelated = 1;',
      `  // ${words.slice(0, cut).join(' ')}`,
      `  // ${words.slice(cut).join(' ')}`,
    ].join('\n');
    expect(scan('sample.ts', sample, [phrases[0]])).toEqual(['sample.ts:2 #1']);
    expect(scan('sample.ts', 'const unrelated = 1;', [phrases[0]])).toEqual([]);
  });

  it('scans the editable migrations and the test-bed scripts, and never a frozen migration', () => {
    const migrations = filesUnder('db/migrations').map((file) => path.basename(file));
    expect(migrations).toContain('103_worker_referred_jobs.sql');
    expect(migrations.some((name) => (migrationNumber(name) ?? 0) < FIRST_SCANNED_MIGRATION)).toBe(false);
    const local = filesUnder('db/local').map((file) => path.basename(file));
    expect(local).toEqual(expect.arrayContaining(['bootstrap-testbed.sh', 'verify-testbed.sh']));
    expect(filesUnder('test/unit')).not.toContain(SELF);
  });

  it('no scanned file carries a refused phrase', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const root of ALL) {
      const refused = phrases.filter((phrase) => phrase.roots.some((r) => r === root || r.startsWith(`${root}/`)));
      for (const file of filesUnder(root)) {
        const relative = path.relative(INFRA, file).split(path.sep).join('/');
        const applicable = refused.filter((phrase) =>
          phrase.roots.some((r) => relative === r || relative.startsWith(`${r}/`)));
        if (applicable.length === 0) continue;
        scanned += 1;
        hits.push(...scan(relative, fs.readFileSync(file, 'utf8'), applicable));
      }
    }
    expect(scanned).toBeGreaterThan(500);
    expect(hits).toEqual([]);
  });
});
