/**
 * `lambda/lib/worker-vocab.ts` — the single source of truth for the four
 * worker-profile vocabularies (trade, experience band, availability,
 * transportation).
 *
 * The keys are the values written to `users.main_trade` /
 * `users.years_experience` / `users.availability` and are pinned by DB CHECK
 * constraints, so they are asserted literally here rather than derived from
 * the module: a test that reads the module's own arrays back to itself would
 * pass through any rename. The labels are asserted literally for the same
 * reason — they are a *move* of copy that already shipped through WhatsApp
 * (`whatsapp/lib/templates.ts`, `whatsapp/onboarding/constants.ts`), not new
 * wording, and drifting them silently changes what workers read.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TRADE_KEYS,
  STANDARD_TRADE_KEYS,
  EXPERIENCE_KEYS,
  AVAILABILITY_KEYS,
  TRANSPORT_KEYS,
  TRADE_LABELS,
  EXPERIENCE_LABELS,
  AVAILABILITY_LABELS,
  TRANSPORT_LABELS,
  isTradeKey,
  isExperienceKey,
  isAvailabilityKey,
  isStandardTradeKey,
  isTransportKey,
  transportKeyToBoolean,
  booleanToTransportKey,
  WORKER_VOCAB,
  WORKER_VOCAB_VERSION,
  type TradeKey,
} from '../../../../lambda/lib/worker-vocab';

/** Every WhatsApp-rendered string in this codebase is ASCII-only (no accents,
 *  no smart quotes) so Twilio content templates and SMS fallbacks render the
 *  same everywhere. The Spanish labels are held to that too. */
const ASCII_ONLY = /^[\x20-\x7E]+$/;

describe('worker-vocab — key sets', () => {
  it('pins the trade slugs in list-picker order', () => {
    expect(TRADE_KEYS).toEqual([
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other',
    ]);
  });

  it('pins the standard trades as the trade slugs minus "other"', () => {
    expect(STANDARD_TRADE_KEYS).toEqual([
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting',
    ]);
    expect(STANDARD_TRADE_KEYS).toEqual(TRADE_KEYS.filter((k) => k !== 'other'));
  });

  it('pins the experience bands in ascending order', () => {
    expect(EXPERIENCE_KEYS).toEqual(['0-1', '2-4', '5-9', '10+']);
  });

  it('pins the availability slugs', () => {
    expect(AVAILABILITY_KEYS).toEqual(['full_time', 'part_time', 'weekends', 'flexible']);
  });

  it('pins the transportation keys (yes/no, stored as boolean has_transportation)', () => {
    expect(TRANSPORT_KEYS).toEqual(['yes', 'no']);
  });

  it('has no duplicate keys in any vocabulary', () => {
    for (const keys of [TRADE_KEYS, STANDARD_TRADE_KEYS, EXPERIENCE_KEYS, AVAILABILITY_KEYS, TRANSPORT_KEYS]) {
      expect(new Set(keys as readonly string[]).size).toBe(keys.length);
    }
  });
});

describe('worker-vocab — labels', () => {
  const CASES: ReadonlyArray<[string, readonly string[], Record<string, { en: string; es: string }>]> = [
    ['TRADE_LABELS', TRADE_KEYS, TRADE_LABELS],
    ['EXPERIENCE_LABELS', EXPERIENCE_KEYS, EXPERIENCE_LABELS],
    ['AVAILABILITY_LABELS', AVAILABILITY_KEYS, AVAILABILITY_LABELS],
    ['TRANSPORT_LABELS', TRANSPORT_KEYS, TRANSPORT_LABELS],
  ];

  it.each(CASES)('%s covers every key in both languages, and nothing else', (_name, keys, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(typeof labels[key].en).toBe('string');
      expect(typeof labels[key].es).toBe('string');
      expect(labels[key].en.trim().length).toBeGreaterThan(0);
      expect(labels[key].es.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(CASES)('%s is ASCII-only on both sides', (_name, keys, labels) => {
    for (const key of keys) {
      expect(labels[key].en).toMatch(ASCII_ONLY);
      expect(labels[key].es).toMatch(ASCII_ONLY);
    }
  });

  it('carries the trade wording moved out of whatsapp/onboarding/constants.ts', () => {
    expect(TRADE_LABELS).toEqual({
      electrician: { en: 'Electrician', es: 'Electricista' },
      plumber: { en: 'Plumber', es: 'Plomero' },
      carpenter: { en: 'Carpenter', es: 'Carpintero' },
      concrete: { en: 'Concrete', es: 'Concreto' },
      painting: { en: 'Painting', es: 'Pintura' },
      other: { en: 'Other', es: 'Otro' },
    });
  });

  it('carries the experience wording WhatsApp renders in ask_experience', () => {
    expect(EXPERIENCE_LABELS).toEqual({
      '0-1': { en: '0-1 years', es: '0-1 anos' },
      '2-4': { en: '2-4 years', es: '2-4 anos' },
      '5-9': { en: '5-9 years', es: '5-9 anos' },
      '10+': { en: '10+ years', es: '10+ anos' },
    });
  });

  it('carries the availability wording WhatsApp renders in ask_availability', () => {
    expect(AVAILABILITY_LABELS).toEqual({
      full_time: { en: 'Full-time', es: 'Tiempo completo' },
      part_time: { en: 'Part-time', es: 'Medio tiempo' },
      weekends: { en: 'Weekends', es: 'Fines de semana' },
      flexible: { en: 'Flexible', es: 'Flexible' },
    });
  });

  it('carries the transportation wording WhatsApp renders in ask_transportation', () => {
    expect(TRANSPORT_LABELS).toEqual({
      yes: { en: 'Yes', es: 'Si' },
      no: { en: 'No', es: 'No' },
    });
  });
});

describe('worker-vocab — type guards', () => {
  it('isTradeKey accepts every trade slug and rejects everything else', () => {
    for (const key of TRADE_KEYS) expect(isTradeKey(key)).toBe(true);
    for (const bad of ['Electrician', 'electrician ', 'welder', '', 'full_time']) {
      expect(isTradeKey(bad)).toBe(false);
    }
  });

  it('isExperienceKey accepts every band and rejects everything else', () => {
    for (const key of EXPERIENCE_KEYS) expect(isExperienceKey(key)).toBe(true);
    for (const bad of ['0', '10', '1-2', '10+ years', '']) {
      expect(isExperienceKey(bad)).toBe(false);
    }
  });

  it('isAvailabilityKey accepts every slug and rejects everything else', () => {
    for (const key of AVAILABILITY_KEYS) expect(isAvailabilityKey(key)).toBe(true);
    for (const bad of ['fulltime', 'Full-time', 'part time', '']) {
      expect(isAvailabilityKey(bad)).toBe(false);
    }
  });

  it('the guards reject non-string input without throwing', () => {
    for (const guard of [isTradeKey, isExperienceKey, isAvailabilityKey]) {
      for (const bad of [null, undefined, 0, 1, true, {}, [], () => undefined]) {
        expect(guard(bad)).toBe(false);
      }
    }
  });
});

describe('worker-vocab — WORKER_VOCAB manifest', () => {
  it('is version 1', () => {
    expect(WORKER_VOCAB_VERSION).toBe(1);
    expect(WORKER_VOCAB.version).toBe(WORKER_VOCAB_VERSION);
  });

  it('carries every key list, in order', () => {
    expect(WORKER_VOCAB.trades).toEqual([...TRADE_KEYS]);
    expect(WORKER_VOCAB.standardTrades).toEqual([...STANDARD_TRADE_KEYS]);
    expect(WORKER_VOCAB.experience).toEqual([...EXPERIENCE_KEYS]);
    expect(WORKER_VOCAB.availability).toEqual([...AVAILABILITY_KEYS]);
    expect(WORKER_VOCAB.transport).toEqual([...TRANSPORT_KEYS]);
  });

  it('survives a JSON round trip unchanged (it crosses the wire to clients)', () => {
    expect(JSON.parse(JSON.stringify(WORKER_VOCAB))).toEqual(WORKER_VOCAB);
    expect(Object.keys(WORKER_VOCAB).sort()).toEqual(
      ['availability', 'experience', 'standardTrades', 'trades', 'transport', 'version'],
    );
  });
});

describe('worker-vocab — remaining guards and the transport conversion', () => {
  it('isStandardTradeKey accepts the five real trades and rejects "other"', () => {
    for (const key of STANDARD_TRADE_KEYS) expect(isStandardTradeKey(key)).toBe(true);
    // The whole point of the separate list: `other` is a pointer at
    // main_trade_other, not a trade, so anything demanding real work rejects it.
    expect(isStandardTradeKey('other')).toBe(false);
    for (const bad of ['welder', 'Electrician', '', null, 7, {}]) {
      expect(isStandardTradeKey(bad)).toBe(false);
    }
  });

  it('isTransportKey accepts yes/no and rejects the booleans they map to', () => {
    for (const key of TRANSPORT_KEYS) expect(isTransportKey(key)).toBe(true);
    for (const bad of ['true', 'si', 'Yes', '', true, false, null]) {
      expect(isTransportKey(bad)).toBe(false);
    }
  });

  it('round-trips transport keys through the has_transportation boolean', () => {
    expect(transportKeyToBoolean('yes')).toBe(true);
    expect(transportKeyToBoolean('no')).toBe(false);
    expect(booleanToTransportKey(true)).toBe('yes');
    expect(booleanToTransportKey(false)).toBe('no');
    for (const key of TRANSPORT_KEYS) {
      expect(booleanToTransportKey(transportKeyToBoolean(key))).toBe(key);
    }
    // Order matters downstream: flows.ts builds the has_transportation button
    // options as TRANSPORT_KEYS.map(transportKeyToBoolean), and the WhatsApp
    // reply parser resolves a numeric answer by index into that array.
    expect(TRANSPORT_KEYS.map(transportKeyToBoolean)).toEqual([true, false]);
  });
});

describe('worker-vocab — hardening', () => {
  it('freezes every key tuple (readonly is only a compile-time promise)', () => {
    for (const keys of [TRADE_KEYS, STANDARD_TRADE_KEYS, EXPERIENCE_KEYS, AVAILABILITY_KEYS, TRANSPORT_KEYS]) {
      expect(Object.isFrozen(keys)).toBe(true);
    }
  });

  it('still narrows the key types to literal unions after Object.freeze', () => {
    // Compile-time assertion: if `Object.freeze` had widened the tuples to
    // string[], TradeKey would be `string` and the @ts-expect-error below
    // would itself be an error ("unused @ts-expect-error"), failing this file
    // at type-check time rather than at runtime.
    const good: TradeKey = 'electrician';
    // @ts-expect-error 'welder' is not a member of TRADE_KEYS
    const bad: TradeKey = 'welder';
    expect(good).toBe('electrician');
    expect(bad).toBe('welder');
  });
});

// ── DB CHECK constraint parity ──────────────────────────────────
//
// The keys are not just an app convention: four CHECK constraints in the
// migrations enumerate them, and the app sending a value outside one is a
// write failure, not a validation message. These read the constraints out of
// the migration SQL as text -- no database needed -- so a key added or
// reordered here fails CI unless the matching migration lands with it.

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

/** SQL comments are stripped first for the same reason the frontend parity
 *  guard strips TS comments: a list quoted in a comment must never be read as
 *  the live constraint. */
function readMigration(file: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
}

function checkList(sql: string, label: string, re: RegExp): string[] {
  const match = re.exec(sql);
  if (!match) throw new Error(`could not find the ${label} CHECK constraint in the migration`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('worker-vocab — DB CHECK constraint parity', () => {
  it('users.main_trade (004) enumerates exactly TRADE_KEYS', () => {
    const sql = readMigration('004_whatsapp.sql');
    expect(checkList(sql, 'users.main_trade', /CHECK \(main_trade IN \(([\s\S]*?)\)\)/))
      .toEqual([...TRADE_KEYS]);
  });

  it('users.years_experience (004) enumerates exactly EXPERIENCE_KEYS', () => {
    const sql = readMigration('004_whatsapp.sql');
    expect(checkList(sql, 'users.years_experience', /CHECK \(years_experience IN \(([\s\S]*?)\)\)/))
      .toEqual([...EXPERIENCE_KEYS]);
  });

  it('users.availability (004) enumerates exactly AVAILABILITY_KEYS', () => {
    const sql = readMigration('004_whatsapp.sql');
    expect(checkList(sql, 'users.availability', /CHECK \(availability IN \(([\s\S]*?)\)\)/))
      .toEqual([...AVAILABILITY_KEYS]);
  });

  it('employer_profiles.hiring_trades (016) contains the FULL trade vocabulary, other included', () => {
    // An `<@ ARRAY[...]` containment check rather than an IN list, and gated
    // in the app by api/employer-profile.ts's VALID_TRADES = TRADE_KEYS. An
    // employer may hire for a trade outside the five standard ones, so this
    // is TRADE_KEYS and not STANDARD_TRADE_KEYS.
    const sql = readMigration('016_employer_profiles.sql');
    expect(checkList(sql, 'employer_profiles.hiring_trades', /CHECK \(hiring_trades <@ ARRAY\[([\s\S]*?)\]/))
      .toEqual([...TRADE_KEYS]);
  });

  it('worker_profiles.availability (003) repeats the same four slugs as users.availability (004)', () => {
    // Not gated by this module: whatsapp/lib/profile-flow.ts's
    // upsertWorkerProfileFromUsers copies users.availability straight into
    // worker_profiles.availability, so if the two CHECKs ever diverge that
    // copy starts failing at write time.
    const sql = readMigration('003_jobs_and_applications.sql');
    expect(checkList(sql, 'worker_profiles.availability', /CHECK \(availability IN \(([\s\S]*?)\)\)/))
      .toEqual([...AVAILABILITY_KEYS]);
  });
});
