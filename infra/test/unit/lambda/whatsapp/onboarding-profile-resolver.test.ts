/**
 * Pure unit tests for the V1/V2 parity resolver
 * (lib/onboarding-profile-resolver.ts). No I/O, no fakes needed — every
 * case is just plain objects in, a WorkflowStepKey (or null) out.
 */

import {
  resolveNextProfileStep,
  PROFILE_FIELD_TO_STEP,
} from '../../../../lambda/whatsapp/lib/onboarding-profile-resolver';
import type { ProfileField } from '../../../../lambda/whatsapp/lib/flows';

const ALL_FIELDS: ProfileField[] = [
  'full_name', 'city', 'main_trade', 'main_trade_other',
  'years_experience', 'has_transportation', 'availability',
];

const COMPLETE_PROFILE: Record<ProfileField, string | boolean> = {
  full_name: 'Maria Lopez',
  city: 'Austin',
  main_trade: 'electrician',
  main_trade_other: 'unused', // main_trade !== 'other', so this is never consulted
  years_experience: '2-4',
  has_transportation: true,
  availability: 'full_time',
};

describe('PROFILE_FIELD_TO_STEP', () => {
  it('maps every one of the seven canonical fields to a distinct WorkflowStepKey', () => {
    const steps = ALL_FIELDS.map((f) => PROFILE_FIELD_TO_STEP[f]);
    expect(new Set(steps).size).toBe(ALL_FIELDS.length);
  });

  it('matches the documented V1 field -> V2 step mapping', () => {
    expect(PROFILE_FIELD_TO_STEP).toEqual({
      full_name: 'profile.name',
      city: 'profile.location',
      main_trade: 'profile.trade',
      main_trade_other: 'profile.custom_trade',
      years_experience: 'profile.experience',
      has_transportation: 'profile.transportation',
      availability: 'profile.availability',
    });
  });
});

describe('resolveNextProfileStep', () => {
  it('a completely empty profile resolves to profile.name', () => {
    expect(resolveNextProfileStep({})).toBe('profile.name');
  });

  it('a fully-complete profile returns null', () => {
    expect(resolveNextProfileStep(COMPLETE_PROFILE)).toBeNull();
  });

  it.each(ALL_FIELDS.filter((f) => f !== 'main_trade_other'))(
    'a profile missing only "%s" resolves to its mapped step',
    (missingField) => {
      const dbFilled = { ...COMPLETE_PROFILE, [missingField]: undefined };
      expect(resolveNextProfileStep(dbFilled)).toBe(PROFILE_FIELD_TO_STEP[missingField]);
    },
  );

  it('resumes at the FIRST missing field of a partially-filled profile, in canonical order', () => {
    // full_name and city filled; main_trade onward missing.
    const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
      full_name: 'Maria Lopez',
      city: 'Austin',
    };
    expect(resolveNextProfileStep(dbFilled)).toBe('profile.trade');
  });

  it('resumes past experience/transportation when only availability is missing', () => {
    const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
      full_name: 'Maria Lopez',
      city: 'Austin',
      main_trade: 'electrician',
      years_experience: '5-9',
      has_transportation: false,
    };
    expect(resolveNextProfileStep(dbFilled)).toBe('profile.availability');
  });

  it('treats explicit null the same as missing (not the same as an empty string)', () => {
    const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
      full_name: 'Maria Lopez',
      city: null,
    };
    expect(resolveNextProfileStep(dbFilled)).toBe('profile.location');
  });

  describe('main_trade_other conditional', () => {
    it('is resolved (asked) only when main_trade === "other"', () => {
      const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
        full_name: 'Maria Lopez',
        city: 'Austin',
        main_trade: 'other',
      };
      expect(resolveNextProfileStep(dbFilled)).toBe('profile.custom_trade');
    });

    it('is skipped for any standard (non-"other") trade, even if left null', () => {
      const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
        full_name: 'Maria Lopez',
        city: 'Austin',
        main_trade: 'plumber',
        main_trade_other: null,
      };
      expect(resolveNextProfileStep(dbFilled)).toBe('profile.experience');
    });

    it('honors main_trade from the `collected` argument when DB has not caught up yet', () => {
      const dbFilled: Partial<Record<ProfileField, string | boolean | null>> = {
        full_name: 'Maria Lopez',
        city: 'Austin',
        main_trade: 'other',
      };
      // main_trade_other answered in-session but not yet reflected in dbFilled.
      expect(resolveNextProfileStep(dbFilled, { main_trade_other: 'dog groomer' })).toBe('profile.experience');
    });
  });

  it('defaults `collected` to {} when omitted (DB-only callers)', () => {
    // Exercises the call shape a future async AI-extraction callback would
    // use: only dbFilled, no collected bag.
    expect(resolveNextProfileStep({ full_name: 'X' })).toBe('profile.location');
  });
});
