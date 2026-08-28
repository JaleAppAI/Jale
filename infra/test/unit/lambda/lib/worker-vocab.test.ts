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
  WORKER_VOCAB,
  WORKER_VOCAB_VERSION,
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
