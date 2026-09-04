/**
 * L6 — `scripts/backfill-trade-canonical.ts`.
 *
 * The classification and roll-up are pure, so they are tested directly. The
 * two DB-touching functions run against an in-memory fake client, which also
 * pins the two properties that matter operationally: a dry run writes nothing,
 * and nothing identifying is ever selected or printed.
 */

import {
  classifyBackfillRow,
  summarizeBackfillPlan,
  parseBackfillArgs,
  buildBackfillPlan,
  formatBackfillReport,
  runBackfill,
  type BackfillPlanEntry,
} from '../../../scripts/backfill-trade-canonical';
import type { CanonicalTrade } from '../../../lambda/lib/trade-canonical';

const RESOLVED_STANDARD: CanonicalTrade = {
  main_trade: 'electrician',
  main_trade_other: null,
  resolved: true,
  trade_key: 'electrician',
};
const RESOLVED_OTHER: CanonicalTrade = {
  main_trade: 'other',
  main_trade_other: 'Soldador',
  resolved: true,
  trade_key: 'welder',
};
const UNRESOLVED: CanonicalTrade = {
  main_trade: 'other',
  main_trade_other: 'Pipe fitter',
  resolved: false,
};

// ── classifyBackfillRow ─────────────────────────────────────────────
describe('classifyBackfillRow', () => {
  it('labels a promotion onto a standard main_trade key', () => {
    expect(classifyBackfillRow('electricista', 4, RESOLVED_STANDARD)).toEqual({
      before: 'electricista',
      rows: 4,
      outcome: 'resolved_standard',
      mainTrade: 'electrician',
      mainTradeOther: null,
      after: '[main_trade=electrician]',
      changed: true,
    });
  });

  it('labels a resolved trade that stays custom', () => {
    expect(classifyBackfillRow('soldador', 2, RESOLVED_OTHER)).toMatchObject({
      outcome: 'resolved_other',
      mainTrade: 'other',
      mainTradeOther: 'Soldador',
      after: 'Soldador',
      changed: true,
    });
  });

  it('labels a trade the alias cache has not learned', () => {
    expect(classifyBackfillRow('pipe   fitter', 1, UNRESOLVED)).toMatchObject({
      outcome: 'unresolved',
      after: 'Pipe fitter',
      changed: true,
    });
  });

  it('marks an already-canonical string unchanged, so no UPDATE is issued', () => {
    const entry = classifyBackfillRow('Soldador', 7, RESOLVED_OTHER);
    expect(entry.changed).toBe(false);
    expect(entry.outcome).toBe('resolved_other');
  });

  it('an unresolved string that is already tidy is unchanged (idempotent re-run)', () => {
    expect(classifyBackfillRow('Pipe fitter', 3, UNRESOLVED).changed).toBe(false);
  });

  it('never proposes the one pair chk_trade_other rejects', () => {
    const blank: CanonicalTrade = { main_trade: 'other', main_trade_other: null, resolved: false };
    expect(classifyBackfillRow('   ', 1, blank).changed).toBe(false);
  });
});

// ── summarizeBackfillPlan ───────────────────────────────────────────
describe('summarizeBackfillPlan', () => {
  it('counts ROWS per outcome and rewrites per distinct string', () => {
    const plan: BackfillPlanEntry[] = [
      classifyBackfillRow('electricista', 4, RESOLVED_STANDARD),
      classifyBackfillRow('soldador', 2, RESOLVED_OTHER),
      classifyBackfillRow('Soldadura', 3, RESOLVED_OTHER),
      classifyBackfillRow('Soldador', 7, RESOLVED_OTHER), // already canonical
      classifyBackfillRow('pipe   fitter', 1, UNRESOLVED),
    ];

    expect(summarizeBackfillPlan(plan)).toEqual({
      resolved_standard: 4,
      resolved_other: 12,
      unresolved: 1,
      changedStrings: 4,
      changedRows: 10,
      totalStrings: 5,
      totalRows: 17,
    });
  });

  it('handles an empty plan', () => {
    expect(summarizeBackfillPlan([])).toMatchObject({ totalRows: 0, changedRows: 0, totalStrings: 0 });
  });
});

// ── parseBackfillArgs ───────────────────────────────────────────────
describe('parseBackfillArgs', () => {
  it('defaults to a dry run in Spanish', () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, value: { apply: false, lang: 'es' } });
  });

  it('accepts --apply and --lang', () => {
    expect(parseBackfillArgs(['--apply'])).toEqual({ ok: true, value: { apply: true, lang: 'es' } });
    expect(parseBackfillArgs(['--lang', 'en'])).toEqual({ ok: true, value: { apply: false, lang: 'en' } });
    expect(parseBackfillArgs(['--apply', '--lang', 'en'])).toEqual({ ok: true, value: { apply: true, lang: 'en' } });
  });

  it('rejects an unknown flag rather than silently dry-running', () => {
    expect(parseBackfillArgs(['--force'])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--lang', 'fr'])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--lang'])).toMatchObject({ ok: false });
  });
});

// ── DB-facing behaviour ─────────────────────────────────────────────
const ALIAS_ROWS = [
  { trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null, aliases: ['welder', 'welding', 'soldador', 'soldadura'] },
  { trade_key: 'electrician', canonical_en: 'Electrician', canonical_es: 'Electricista', trade_category: 'electrician', aliases: ['electrician', 'electricista'] },
];

function makeClient(stored: Array<{ before: string; rows: number }>) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    statements,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (/FROM users/.test(sql) && /GROUP BY/.test(sql)) {
        return { rows: stored.map((s) => ({ before: s.before, rows: s.rows })), rowCount: stored.length };
      }
      if (/FROM trade_aliases/.test(sql)) {
        const key = String(params?.[0] ?? '');
        const hit = ALIAS_ROWS.find((r) => r.trade_key === key || r.aliases.includes(key));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return client as typeof client & { query: jest.Mock };
}

const updates = (client: { statements: Array<{ sql: string; params?: unknown[] }> }) =>
  client.statements.filter((s) => /UPDATE users/.test(s.sql));

describe('buildBackfillPlan', () => {
  it('classifies each distinct stored string via the live canonicaliser', async () => {
    const client = makeClient([
      { before: 'soldador', rows: 2 },
      { before: 'Soldadura', rows: 1 },
      { before: 'electricista', rows: 3 },
      { before: 'back', rows: 1 },
    ]);

    const plan = await buildBackfillPlan(client, 'es');

    expect(plan.map((e) => [e.before, e.outcome, e.after])).toEqual([
      ['soldador', 'resolved_other', 'Soldador'],
      ['Soldadura', 'resolved_other', 'Soldador'],
      ['electricista', 'resolved_standard', '[main_trade=electrician]'],
      ['back', 'unresolved', 'Back'],
    ]);
  });

  it('selects no identifying column', async () => {
    const client = makeClient([{ before: 'soldador', rows: 1 }]);

    await buildBackfillPlan(client, 'es');

    const groupBy = client.statements.find((s) => /GROUP BY/.test(s.sql))!.sql;
    for (const column of ['id', 'full_name', 'phone', 'whatsapp_number', 'cognito_sub', 'email']) {
      expect(groupBy).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });
});

describe('runBackfill', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => log.mockClear());
  afterAll(() => log.mockRestore());

  it('DRY RUN writes nothing at all', async () => {
    const client = makeClient([
      { before: 'soldador', rows: 2 },
      { before: 'electricista', rows: 3 },
    ]);

    const summary = await runBackfill(client, { apply: false, lang: 'es' });

    expect(updates(client)).toHaveLength(0);
    expect(client.statements.some((s) => /BEGIN|COMMIT/.test(s.sql))).toBe(false);
    expect(summary).toMatchObject({ resolved_other: 2, resolved_standard: 3, changedRows: 5 });
  });

  it('--apply rewrites each changed string once, inside one transaction', async () => {
    const client = makeClient([
      { before: 'soldador', rows: 2 },
      { before: 'Soldador', rows: 5 }, // already canonical -> skipped
      { before: 'electricista', rows: 3 },
    ]);

    await runBackfill(client, { apply: true, lang: 'es' });

    expect(updates(client).map((s) => s.params)).toEqual([
      ['soldador', 'other', 'Soldador'],
      ['electricista', 'electrician', null],
    ]);
    const sqls = client.statements.map((s) => s.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('rolls back and rethrows if an UPDATE fails', async () => {
    const client = makeClient([{ before: 'soldador', rows: 2 }]);
    client.query.mockImplementationOnce(async (sql: string) => {
      client.statements.push({ sql });
      return { rows: [{ before: 'soldador', rows: 2 }], rowCount: 1 };
    });
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/UPDATE users/.test(sql)) {
        client.statements.push({ sql, params });
        throw new Error('deadlock detected');
      }
      return original(sql, params);
    });

    await expect(runBackfill(client, { apply: true, lang: 'es' })).rejects.toThrow('deadlock detected');
    expect(client.statements.map((s) => s.sql)).toContain('ROLLBACK');
  });

  it('an English run stores the English canonical name', async () => {
    const client = makeClient([{ before: 'soldador', rows: 1 }]);

    await runBackfill(client, { apply: true, lang: 'en' });

    expect(updates(client)[0].params).toEqual(['soldador', 'other', 'Welder']);
  });
});

describe('formatBackfillReport', () => {
  const plan = () => [
    classifyBackfillRow('soldador', 2, RESOLVED_OTHER),
    classifyBackfillRow('Soldador', 5, RESOLVED_OTHER),
    classifyBackfillRow('electricista', 3, RESOLVED_STANDARD),
  ];

  it('says loudly that a dry run writes nothing', () => {
    const report = formatBackfillReport(plan(), summarizeBackfillPlan(plan()), { apply: false, lang: 'es' });
    expect(report).toContain('DRY RUN');
    expect(report).toContain('--apply');
  });

  it('prints the before -> after trade strings and the per-outcome counts', () => {
    const report = formatBackfillReport(plan(), summarizeBackfillPlan(plan()), { apply: true, lang: 'es' });
    expect(report).toContain('"soldador" -> "Soldador"');
    expect(report).toContain('"electricista" -> "[main_trade=electrician]"');
    expect(report).toContain('resolved -> standard main_trade');
    expect(report).toContain('already canonical, left alone: 1 distinct string');
  });
});
