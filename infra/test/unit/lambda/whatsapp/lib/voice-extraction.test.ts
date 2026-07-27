/**
 * Task 8c: pure unit tests for `planExtractionWrites`. No I/O, no adapters —
 * `resolveLocation` is injected as a plain function so these tests exercise
 * the SAME resolver shape (`ZIP | "City, ST" | null`) production wires in,
 * without touching `onboarding-adapters.ts`.
 */

import { planExtractionWrites, type PlanExtractionOptions } from '../../../../../lambda/whatsapp/lib/voice-extraction';
import { createLocationResolver } from '../../../../../lambda/whatsapp/lib/onboarding-adapters';
import type { VoiceExtractionFields } from '../../../../../lambda/whatsapp/lib/voice-events';

const realResolver = createLocationResolver();

function options(overrides: Partial<PlanExtractionOptions> = {}): PlanExtractionOptions {
  return {
    threshold: 0.75,
    resolveLocation: (raw) => realResolver.resolve(raw),
    ...overrides,
  };
}

const HIGH = 0.9;
const LOW = 0.5;

describe('planExtractionWrites', () => {
  describe('NULL-only fill precedence', () => {
    it('skips every field already present in dbFilled, regardless of confidence', () => {
      const dbFilled = {
        full_name: 'Existing Name',
        city: 'Austin',
        main_trade: 'plumber',
        years_experience: '5-9',
        has_transportation: true,
        availability: 'full_time',
      };
      const fields: VoiceExtractionFields = {
        full_name: 'Someone Else',
        city: '78701',
        main_trade: 'electrician',
        years_experience: '10+',
        has_transportation: false,
        availability: 'weekends',
      };
      const confidences = {
        full_name: HIGH, city: HIGH, main_trade: HIGH,
        years_experience: HIGH, has_transportation: HIGH, availability: HIGH,
      };

      const result = planExtractionWrites(dbFilled, fields, confidences, options());

      expect(result.writes).toHaveLength(0);
      expect(result.appliedFields).toHaveLength(0);
      expect(result.skipped.every((s) => s.reason === 'already_filled')).toBe(true);
    });

    it('fills only the missing fields when some are already on file', () => {
      const dbFilled = { full_name: 'Existing Name' };
      const fields: VoiceExtractionFields = {
        full_name: 'Someone Else',
        city: '78701',
        main_trade: 'electrician',
      };
      const confidences = { full_name: HIGH, city: HIGH, main_trade: HIGH };

      const result = planExtractionWrites(dbFilled, fields, confidences, options());

      expect(result.appliedFields).toEqual(expect.arrayContaining(['city', 'main_trade']));
      expect(result.appliedFields).not.toContain('full_name');
      expect(result.writes).toEqual(expect.arrayContaining([
        { field: 'location', value: { city: null, state: null, postalCode: '78701', source: 'zip' } },
        { field: 'trade', value: 'electrician' },
      ]));
    });
  });

  describe('confidence threshold', () => {
    it('rejects a field below threshold', () => {
      const result = planExtractionWrites(
        {},
        { full_name: 'Jose Martinez' },
        { full_name: 0.74 },
        options({ threshold: 0.75 }),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'full_name', reason: 'low_confidence' });
    });

    it('accepts a field exactly at threshold', () => {
      const result = planExtractionWrites(
        {},
        { full_name: 'Jose Martinez' },
        { full_name: 0.75 },
        options({ threshold: 0.75 }),
      );
      expect(result.writes).toEqual([{ field: 'full_name', value: 'Jose Martinez' }]);
    });

    it('missing/NaN confidence score is treated as failing the threshold', () => {
      const result = planExtractionWrites(
        {},
        { full_name: 'Jose Martinez' },
        {},
        options({ threshold: 0.75 }),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'full_name', reason: 'low_confidence' });
    });
  });

  describe('strict enums — no fuzzy coercion', () => {
    it('rejects "3 years" for years_experience instead of coercing to a bucket', () => {
      const result = planExtractionWrites(
        {},
        { years_experience: '3 years' },
        { years_experience: HIGH },
        options(),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'years_experience', reason: 'invalid_enum' });
    });

    it.each(['0-1', '2-4', '5-9', '10+'])('accepts the canonical years_experience slug "%s"', (slug) => {
      const result = planExtractionWrites({}, { years_experience: slug }, { years_experience: HIGH }, options());
      expect(result.writes).toEqual([{ field: 'years_experience', value: slug }]);
    });

    it('rejects an invalid availability slug', () => {
      const result = planExtractionWrites(
        {},
        { availability: 'whenever' },
        { availability: HIGH },
        options(),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'availability', reason: 'invalid_enum' });
    });

    it.each(['full_time', 'part_time', 'weekends', 'flexible'])('accepts the canonical availability slug "%s"', (slug) => {
      const result = planExtractionWrites({}, { availability: slug }, { availability: HIGH }, options());
      expect(result.writes).toEqual([{ field: 'availability', value: slug }]);
    });

    it('rejects an unrecognized main_trade value', () => {
      const result = planExtractionWrites(
        {},
        { main_trade: 'welder' }, // not a standard slug and not literally 'other'
        { main_trade: HIGH },
        options(),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'main_trade', reason: 'invalid_enum' });
    });
  });

  describe('boolean type check (has_transportation)', () => {
    it('accepts a real boolean', () => {
      const result = planExtractionWrites({}, { has_transportation: true }, { has_transportation: HIGH }, options());
      expect(result.writes).toEqual([{ field: 'has_transportation', value: true }]);
    });

    it('rejects a non-boolean value (e.g. a stringly-typed "yes")', () => {
      const fields = { has_transportation: 'yes' as unknown as boolean };
      const result = planExtractionWrites({}, fields, { has_transportation: HIGH }, options());
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'has_transportation', reason: 'invalid_type' });
    });

    it('false is a legitimate low-but-present value, not treated as "missing"', () => {
      const result = planExtractionWrites({}, { has_transportation: false }, { has_transportation: HIGH }, options());
      expect(result.writes).toEqual([{ field: 'has_transportation', value: false }]);
    });
  });

  describe('location shapes', () => {
    it('resolves a ZIP', () => {
      const result = planExtractionWrites({}, { city: '78701' }, { city: HIGH }, options());
      expect(result.writes).toEqual([
        { field: 'location', value: { city: null, state: null, postalCode: '78701', source: 'zip' } },
      ]);
    });

    it('resolves "City, ST"', () => {
      const result = planExtractionWrites({}, { city: 'Austin, TX' }, { city: HIGH }, options());
      expect(result.writes).toEqual([
        { field: 'location', value: { city: 'Austin', state: 'TX', postalCode: null, source: 'city_state' } },
      ]);
    });

    it('skips a bare city name the resolver cannot place (no state, no zip)', () => {
      const result = planExtractionWrites({}, { city: 'Austin' }, { city: HIGH }, options());
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'city', reason: 'unresolvable_location' });
    });
  });

  describe('chk_trade_other safety — atomic custom-trade write both directions', () => {
    it('main_trade="other" WITH usable free text emits ONLY the atomic custom_trade write, never a bare trade write', () => {
      const result = planExtractionWrites(
        {},
        { main_trade: 'other', main_trade_other: 'dog groomer' },
        { main_trade: HIGH },
        options(),
      );
      expect(result.writes).toEqual([{ field: 'custom_trade', value: 'dog groomer' }]);
      expect(result.writes.some((w) => w.field === 'trade')).toBe(false);
      expect(result.appliedFields).toEqual(expect.arrayContaining(['main_trade', 'main_trade_other']));
    });

    it('main_trade="other" with NO free text skips BOTH columns — never a partial write', () => {
      const result = planExtractionWrites(
        {},
        { main_trade: 'other', main_trade_other: null },
        { main_trade: HIGH },
        options(),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'main_trade', reason: 'other_missing_text' });
    });

    it('main_trade="other" with whitespace-only free text is treated as missing text', () => {
      const result = planExtractionWrites(
        {},
        { main_trade: 'other', main_trade_other: '   ' },
        { main_trade: HIGH },
        options(),
      );
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'main_trade', reason: 'other_missing_text' });
    });

    it('a standard trade never triggers the custom_trade path, even if main_trade_other is (oddly) also present', () => {
      const result = planExtractionWrites(
        {},
        { main_trade: 'plumber', main_trade_other: 'ignored text' },
        { main_trade: HIGH },
        options(),
      );
      expect(result.writes).toEqual([{ field: 'trade', value: 'plumber' }]);
    });
  });

  describe('independence — a bad field never blocks a good one', () => {
    it('a low-confidence trade does not block a high-confidence name', () => {
      const result = planExtractionWrites(
        {},
        { full_name: 'Jose Martinez', main_trade: 'plumber' },
        { full_name: HIGH, main_trade: LOW },
        options(),
      );
      expect(result.writes).toEqual([{ field: 'full_name', value: 'Jose Martinez' }]);
      expect(result.skipped).toContainEqual({ field: 'main_trade', reason: 'low_confidence' });
    });
  });

  describe('empty/whitespace extracted text', () => {
    it('an empty full_name string is skipped, not written as an empty name', () => {
      const result = planExtractionWrites({}, { full_name: '   ' }, { full_name: HIGH }, options());
      expect(result.writes).toHaveLength(0);
      expect(result.skipped).toContainEqual({ field: 'full_name', reason: 'empty' });
    });
  });
});
