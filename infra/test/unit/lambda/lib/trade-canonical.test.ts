/**
 * L6 — canonical worker trades (`lambda/lib/trade-canonical.ts`).
 *
 * Every case runs against an in-memory fake `client` that answers the ONE
 * `trade_aliases` SELECT the module issues. The seeded rows mirror migration
 * 060's seven seeded rows exactly (aliases pre-normalized), so a drift in that
 * migration's shape shows up here.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  resolveTradeAlias,
  canonicalizeWorkerTrade,
  professionKeyForTrade,
  tidyTradeText,
  standardTradeKeyForCategory,
  type TradeAliasRow,
} from '../../../../lambda/lib/trade-canonical';
import { TRADE_KEYS } from '../../../../lambda/lib/worker-vocab';

// ── Migration 060's seeded rows, verbatim ────────────────────────────
interface SeedRow extends TradeAliasRow {
  aliases: string[];
}

const SEEDED_ROWS: SeedRow[] = [
  {
    trade_key: 'electrician',
    canonical_en: 'Electrician',
    canonical_es: 'Electricista',
    trade_category: 'electrician',
    aliases: ['electrician', 'electrical', 'electricista', 'electrico', 'wire', 'wiring', 'panel', 'journeyman'],
  },
  {
    trade_key: 'plumber',
    canonical_en: 'Plumber',
    canonical_es: 'Plomero',
    trade_category: 'plumber',
    aliases: ['plumber', 'plumbing', 'plomero', 'fontanero', 'plomeria', 'pipe', 'pipes', 'fixture', 'fixtures'],
  },
  {
    trade_key: 'carpenter',
    canonical_en: 'Carpenter',
    canonical_es: 'Carpintero',
    trade_category: 'carpenter',
    aliases: ['carpenter', 'carpentry', 'carpintero', 'carpinteria', 'framer', 'framing', 'wood', 'trim'],
  },
  {
    trade_key: 'concrete',
    canonical_en: 'Concrete',
    canonical_es: 'Concreto',
    trade_category: 'concrete',
    aliases: ['concrete', 'cement', 'concreto', 'cemento', 'albanil', 'rebar', 'formwork', 'finisher'],
  },
  {
    trade_key: 'painter',
    canonical_en: 'Painter',
    canonical_es: 'Pintor',
    trade_category: 'painting',
    aliases: ['painter', 'painting', 'paint', 'pintor', 'pintura', 'spray', 'roller'],
  },
  {
    trade_key: 'drywall',
    canonical_en: 'Drywall',
    canonical_es: 'Tablaroquero',
    trade_category: 'drywall',
    aliases: ['drywall', 'drywaller', 'sheetrock', 'taper', 'taping', 'mud', 'texture', 'hanger', 'tablaroca', 'tablaroquero'],
  },
  {
    trade_key: 'welder',
    canonical_en: 'Welder',
    canonical_es: 'Soldador',
    trade_category: null,
    aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
  },
];

/**
 * Fake client that resolves the module's SELECT the way Postgres would:
 * `trade_key = $1 OR $1 = ANY(aliases)`, first match wins. Records every
 * `$1` it was asked for so the plural-strip retry is observable.
 */
function makeClient(rows: SeedRow[] = SEEDED_ROWS) {
  const keys: string[] = [];
  return {
    keys,
    query: jest.fn(async (_sql: string, params?: unknown[]) => {
      const key = String(params?.[0] ?? '');
      keys.push(key);
      const hit = rows.find((r) => r.trade_key === key || r.aliases.includes(key));
      return { rows: hit ? [hit] : [] };
    }),
  } as any;
}

/** A client that answers every query with a row that is NOT a trade_aliases
 * row — exactly what the WhatsApp router's shared in-memory fake client does
 * (test/unit/lambda/whatsapp/onboarding-v2-profile.test.ts). The module must
 * treat this as a miss, never as a resolved trade. */
function makeWrongShapeClient() {
  return {
    query: jest.fn(async () => ({
      rows: [{ full_name: null, main_trade: null, main_trade_other: null }],
    })),
  } as any;
}

function makeThrowingClient() {
  return {
    query: jest.fn(async () => {
      throw new Error('relation "trade_aliases" does not exist');
    }),
  } as any;
}

// ── tidyTradeText ────────────────────────────────────────────────────
describe('tidyTradeText', () => {
  it('trims, collapses whitespace and capitalises only the first letter', () => {
    expect(tidyTradeText('  soldador  ')).toBe('Soldador');
    expect(tidyTradeText('pipe   fitter')).toBe('Pipe fitter');
  });

  it('never lowercases the rest — an acronym the worker typed survives', () => {
    expect(tidyTradeText('  hvac   TECH ')).toBe('Hvac TECH');
    expect(tidyTradeText('HVAC')).toBe('HVAC');
  });

  it('returns empty string for blank input', () => {
    expect(tidyTradeText('')).toBe('');
    expect(tidyTradeText('   \n\t ')).toBe('');
  });
});

// ── standardTradeKeyForCategory ──────────────────────────────────────
describe('standardTradeKeyForCategory', () => {
  it('maps a trade_category that is also a users.main_trade enum key', () => {
    expect(standardTradeKeyForCategory('electrician')).toBe('electrician');
    expect(standardTradeKeyForCategory('painting')).toBe('painting');
    expect(standardTradeKeyForCategory('concrete')).toBe('concrete');
  });

  it('refuses categories that are NOT in the users.main_trade enum', () => {
    // 'drywall' and 'general_labor' are valid jobs.trade_category values but
    // NOT valid users.main_trade values — writing them would trip the
    // main_trade CHECK (004_whatsapp.sql:55-56).
    expect(standardTradeKeyForCategory('drywall')).toBeNull();
    expect(standardTradeKeyForCategory('general_labor')).toBeNull();
    expect(standardTradeKeyForCategory('other')).toBeNull();
    expect(standardTradeKeyForCategory(null)).toBeNull();
    expect(standardTradeKeyForCategory(undefined)).toBeNull();
  });
});

// ── resolveTradeAlias ────────────────────────────────────────────────
describe('resolveTradeAlias', () => {
  it('resolves an alias hit (soldador -> the welder row)', async () => {
    const client = makeClient();
    const row = await resolveTradeAlias(client, 'soldador');
    expect(row).toMatchObject({ trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null });
  });

  it('resolves a differently-spelled alias onto the SAME row (Soldadura)', async () => {
    const client = makeClient();
    const row = await resolveTradeAlias(client, 'Soldadura');
    expect(row?.trade_key).toBe('welder');
  });

  it('resolves on trade_key directly', async () => {
    const client = makeClient();
    expect((await resolveTradeAlias(client, 'Welder'))?.trade_key).toBe('welder');
  });

  it('strips a trailing plural s and retries once', async () => {
    const client = makeClient();
    const row = await resolveTradeAlias(client, 'Welders');
    expect(row?.trade_key).toBe('welder');
    expect(client.keys).toEqual(['welders', 'welder']);
  });

  it('returns null for an unknown trade, after the plural retry', async () => {
    const client = makeClient();
    expect(await resolveTradeAlias(client, 'back')).toBeNull();
  });

  it('returns null for empty/whitespace input WITHOUT querying', async () => {
    const client = makeClient();
    expect(await resolveTradeAlias(client, '')).toBeNull();
    expect(await resolveTradeAlias(client, '   ')).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('treats a row that is not a trade_aliases row as a miss', async () => {
    const client = makeWrongShapeClient();
    expect(await resolveTradeAlias(client, 'soldador')).toBeNull();
  });
});

// ── canonicalizeWorkerTrade ──────────────────────────────────────────
describe('canonicalizeWorkerTrade', () => {
  it('soldador (es) -> main_trade other + Soldador', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: 'soldador', lang: 'es' })).toEqual({
      main_trade: 'other',
      main_trade_other: 'Soldador',
      resolved: true,
      trade_key: 'welder',
    });
  });

  it('soldador (en) -> main_trade other + Welder', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: 'soldador', lang: 'en' })).toEqual({
      main_trade: 'other',
      main_trade_other: 'Welder',
      resolved: true,
      trade_key: 'welder',
    });
  });

  it('every spelling of the welder trade lands on the SAME canonical text', async () => {
    const client = makeClient();
    for (const raw of ['soldador', 'Soldadura', 'welder', 'WELDING', 'welders']) {
      const out = await canonicalizeWorkerTrade(client, { raw, lang: 'es' });
      expect(out.main_trade_other).toBe('Soldador');
      expect(out.trade_key).toBe('welder');
    }
  });

  it('electricista -> the STANDARD electrician key with main_trade_other cleared', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: 'electricista', lang: 'es' })).toEqual({
      main_trade: 'electrician',
      main_trade_other: null,
      resolved: true,
      trade_key: 'electrician',
    });
  });

  it('pintor -> the STANDARD painting key (the painter row carries trade_category painting)', async () => {
    const client = makeClient();
    const out = await canonicalizeWorkerTrade(client, { raw: 'pintor', lang: 'es' });
    expect(out.main_trade).toBe('painting');
    expect(out.main_trade_other).toBeNull();
    expect(TRADE_KEYS as readonly string[]).toContain(out.main_trade);
  });

  it('tablaroca -> canonical OTHER: drywall is a job category but not a main_trade enum key', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: 'tablaroca', lang: 'es' })).toEqual({
      main_trade: 'other',
      main_trade_other: 'Tablaroquero',
      resolved: true,
      trade_key: 'drywall',
    });
  });

  it('an unknown trade is tidied and reported unresolved', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: '  back  ', lang: 'es' })).toEqual({
      main_trade: 'other',
      main_trade_other: 'Back',
      resolved: false,
    });
  });

  it('blank input is unresolved with a NULL other — never other + null past chk_trade_other', async () => {
    const client = makeClient();
    expect(await canonicalizeWorkerTrade(client, { raw: '   ', lang: 'es' })).toEqual({
      main_trade: 'other',
      main_trade_other: null,
      resolved: false,
    });
  });

  it('fails OPEN on a DB error: degrades to the tidied raw text, unresolved', async () => {
    const client = makeThrowingClient();
    expect(await canonicalizeWorkerTrade(client, { raw: 'soldador', lang: 'es' })).toEqual({
      main_trade: 'other',
      main_trade_other: 'Soldador',
      resolved: false,
    });
  });

  it('always yields a main_trade the users.main_trade CHECK accepts', async () => {
    const client = makeClient();
    for (const raw of ['soldador', 'electricista', 'pintor', 'tablaroca', 'back', 'plomero']) {
      const out = await canonicalizeWorkerTrade(client, { raw, lang: 'es' });
      expect(TRADE_KEYS as readonly string[]).toContain(out.main_trade);
      if (out.main_trade === 'other') expect(out.main_trade_other).toBeTruthy();
    }
  });
});

// ── professionKeyForTrade ────────────────────────────────────────────
describe('professionKeyForTrade', () => {
  it('soldador, Soldadura and welder share ONE profession key', async () => {
    const client = makeClient();
    expect(await professionKeyForTrade(client, 'soldador')).toBe('welder');
    expect(await professionKeyForTrade(client, 'Soldadura')).toBe('welder');
    expect(await professionKeyForTrade(client, 'welder')).toBe('welder');
  });

  it('a STANDARD trade key passes through untouched and never hits the DB', async () => {
    // Migration 012 seeds trade_questions.profession_key = 'painting' (and
    // 086 asserts exactly those five seeded rows still exist). The painter
    // alias row is keyed 'painter', so an unguarded alias lookup would orphan
    // every standard painting worker from the seeded question set.
    const client = makeClient();
    for (const key of ['electrician', 'plumber', 'carpenter', 'concrete', 'painting']) {
      expect(await professionKeyForTrade(client, key)).toBe(key);
    }
    expect(client.query).not.toHaveBeenCalled();
  });

  it('a custom spelling of a standard trade lands on that standard key too', async () => {
    const client = makeClient();
    expect(await professionKeyForTrade(client, 'pintor')).toBe('painting');
    expect(await professionKeyForTrade(client, 'electricista')).toBe('electrician');
  });

  it('falls back to normalizeProfession for an unknown trade', async () => {
    const client = makeClient();
    expect(await professionKeyForTrade(client, '  Pipe-Fitter ')).toBe('pipe fitter');
  });

  it('falls back to normalizeProfession when the lookup FAILS', async () => {
    expect(await professionKeyForTrade(makeThrowingClient(), 'Welder')).toBe('welder');
  });

  it('falls back to normalizeProfession when the client returns a foreign row shape', async () => {
    expect(await professionKeyForTrade(makeWrongShapeClient(), 'Welder')).toBe('welder');
  });
});

// ── drift guard ──────────────────────────────────────────────────────
describe('TRADE_TO_PROFESSION drift guard', () => {
  it('is the identity on every key that is also a users.main_trade enum key', () => {
    // `standardTradeKeyForCategory` is the reverse of job-matching.ts's
    // TRADE_TO_PROFESSION, restricted to the main_trade enum. That map is
    // module-private and job-matching.ts is owned by another lane, so this
    // reads it as text instead of importing it. If someone adds a
    // non-identity entry for a real main_trade key, the derivation above
    // silently diverges — and this fails first.
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../lambda/lib/job-matching.ts'),
      'utf-8',
    );
    const block = src.match(/const TRADE_TO_PROFESSION: Record<string, string> = \{([^}]*)\}/);
    expect(block).not.toBeNull();

    const entries = Array.from(block![1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm))
      .map((m) => [m[1], m[2]] as const);
    expect(entries.length).toBeGreaterThan(0);

    const standard = (TRADE_KEYS as readonly string[]).filter((k) => k !== 'other');
    for (const [tradeKey, category] of entries) {
      if (standard.includes(tradeKey)) {
        expect(category).toBe(tradeKey);
        expect(standardTradeKeyForCategory(category)).toBe(tradeKey);
      }
    }

    // Every standard main_trade key must appear in that map, or the matcher
    // cannot bridge it to a job category at all.
    for (const key of standard) {
      expect(entries.map(([k]) => k)).toContain(key);
    }
  });
});
