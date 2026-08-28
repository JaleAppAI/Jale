import {
  buildHelpMenuInteractivePrompt,
  buildLegalInteractivePrompt,
  buildMediaInteractivePrompt,
  buildProfileInteractivePrompt,
} from '../../../../../lambda/whatsapp/lib/interactive-templates';
import { t, type Lang } from '../../../../../lambda/whatsapp/lib/templates';
import {
  buildV2StartInvitationPrompt, buildV2OtpPrompt, buildV2LegalPrompt,
  buildV2NumberedOptionsPrompt, buildV2TradePrompt, V2_FALLBACK_TRUST_QUESTIONS,
} from '../../../../../lambda/whatsapp/lib/interactive-templates';
import { ACCOUNT_EXISTENCE_LEAK_PATTERN } from './v2-copy-test-helpers';

describe('interactive onboarding templates', () => {
  it('builds legal quick-reply prompts with the ToS URL variable', () => {
    expect(buildLegalInteractivePrompt('en', 'https://jale.app/legal/tos')).toMatchObject({
      templateName: 'onboarding_legal_en',
      variables: { '1': 'https://jale.app/legal/tos' },
    });
    expect(buildLegalInteractivePrompt('es', 'https://jale.app/legal/tos')).toMatchObject({
      templateName: 'onboarding_legal_es',
      variables: { '1': 'https://jale.app/legal/tos' },
    });
  });

  it('uses list-picker templates for profile prompts with more than three choices', () => {
    expect(buildProfileInteractivePrompt('main_trade', 'es')).toMatchObject({
      templateName: 'onboarding_trade_es',
      variables: {},
    });
    expect(buildProfileInteractivePrompt('years_experience', 'en')).toMatchObject({
      templateName: 'onboarding_experience_en',
      variables: {},
    });
    expect(buildProfileInteractivePrompt('availability', 'en')).toMatchObject({
      templateName: 'onboarding_availability_en',
      variables: {},
    });
  });

  it('uses quick-reply templates for two-option profile prompts', () => {
    expect(buildProfileInteractivePrompt('has_transportation', 'en')).toMatchObject({
      templateName: 'onboarding_transportation_en',
      variables: {},
    });
  });

  it('uses updated transportation yes/no fallback copy', () => {
    const prompt = buildProfileInteractivePrompt('has_transportation', 'es');
    expect(prompt).toMatchObject({
      templateName: 'onboarding_transportation_es',
      variables: {},
    });
    expect(prompt?.fallbackBody).toContain('Tienes transporte propio?');
    expect(prompt?.fallbackBody).toContain('Responde con 1 o 2.');
  });

  it('does not build rich prompts for open-ended profile fields', () => {
    expect(buildProfileInteractivePrompt('full_name', 'en')).toBeNull();
    expect(buildProfileInteractivePrompt('city', 'es')).toBeNull();
    expect(buildProfileInteractivePrompt('main_trade_other', 'en')).toBeNull();
  });

  it('builds media quick-reply prompts', () => {
    expect(buildMediaInteractivePrompt('photo_skip', 'en')).toMatchObject({
      templateName: 'onboarding_photo_skip_en',
      variables: {},
    });
    expect(buildMediaInteractivePrompt('photo_type', 'es')).toMatchObject({
      templateName: 'onboarding_photo_type_es',
      variables: {},
    });
    expect(buildMediaInteractivePrompt('voice_choice', 'en')).toMatchObject({
      templateName: 'onboarding_voice_choice_en',
      variables: {},
    });
  });

  it('uses updated media fallback copy for voice and photo upload', () => {
    expect(buildMediaInteractivePrompt('voice_choice', 'es').fallbackBody).toContain(
      'Puedes mandar una nota de voz ahora',
    );
    expect(buildMediaInteractivePrompt('voice_choice', 'en').fallbackBody).toContain(
      'You can send a voice note now',
    );
    expect(buildMediaInteractivePrompt('photo_skip', 'es').fallbackBody).toContain(
      'Foto para tu perfil',
    );
    expect(buildMediaInteractivePrompt('photo_skip', 'en').fallbackBody).toContain(
      'Profile photo',
    );
  });

  it('builds the help menu list-picker prompt', () => {
    expect(buildHelpMenuInteractivePrompt('en')).toMatchObject({
      templateName: 'help_menu_list_en',
      variables: {},
      fallbackBody: t('help_menu', 'en'),
    });
    expect(buildHelpMenuInteractivePrompt('es')).toMatchObject({
      templateName: 'help_menu_list_es',
      variables: {},
      fallbackBody: t('help_menu', 'es'),
    });
  });
});

const LANGS: Lang[] = ['en', 'es'];

describe('buildV2StartInvitationPrompt', () => {
  it.each(LANGS)('offers both language choices in %s', (lang) => {
    const p = buildV2StartInvitationPrompt(lang);
    expect(p.templateName).toContain('v2');
    expect(p.fallbackBody).toContain('START');
    expect(p.fallbackBody).toContain('EMPEZAR');
    expect(p.fallbackBody).not.toMatch(ACCOUNT_EXISTENCE_LEAK_PATTERN);
  });
});

describe('buildV2OtpPrompt', () => {
  it.each(LANGS)('interpolates the expiry into the fallback in %s', (lang) => {
    const p = buildV2OtpPrompt(lang, '5');
    expect(p.fallbackBody).toContain('5');
    expect(p.fallbackBody).not.toContain('{{');
  });

  // Locks the contract the approved v2_onboarding_otp_* template must be built
  // against. The resend button (payload 'otp:resend') is baked into the
  // template per language, so exactly one variable travels at send time —
  // a mismatch here is a Twilio 400 that __fallback_body cannot rescue.
  it.each(LANGS)('sends exactly one variable, the expiry minutes, in %s', (lang) => {
    const p = buildV2OtpPrompt(lang, '5');
    expect(p.templateName).toBe(`v2_onboarding_otp_${lang}`);
    expect(p.variables).toEqual({ '1': '5' });
  });

  it('never passes the resend payload or label as a variable', () => {
    const p = buildV2OtpPrompt('en', '5');
    expect(Object.values(p.variables)).not.toContain('otp:resend');
    expect(Object.values(p.variables)).not.toContain('Resend');
  });
});

describe('buildV2LegalPrompt', () => {
  // These assertions encode V1's Twilio contract, which is the only proof we
  // have that the send is accepted: a REGISTERED template invoked with the
  // wrong variable count is a Twilio 400, and outbox.ts's __fallback_body
  // rescue only covers a MISSING ContentSid — it cannot save a rejected
  // payload. buildLegalInteractivePrompt (V1, live in prod) sends exactly one
  // variable to this template, so v2 must too.
  it.each(LANGS)('reuses V1\'s registered onboarding_legal template in %s', (lang) => {
    const p = buildV2LegalPrompt(lang, 'https://jale.app/terms', 'https://jale.app/privacy');
    expect(p.templateName).toBe(`onboarding_legal_${lang}`);
    expect(p.variables).toEqual({ '1': 'https://jale.app/terms' });
    expect(Object.keys(p.variables)).toHaveLength(1);
  });

  it.each(LANGS)('keeps both links in the plain-text fallback in %s', (lang) => {
    const p = buildV2LegalPrompt(lang, 'https://jale.app/terms', 'https://jale.app/privacy');
    expect(p.fallbackBody).toContain('https://jale.app/terms');
    expect(p.fallbackBody).toContain('https://jale.app/privacy');
    expect(p.fallbackBody).not.toContain('{{');
  });

  it('never passes button payloads as variables (the approved template bakes them in)', () => {
    const serialized = JSON.stringify(buildV2LegalPrompt('en', 'https://t', 'https://p'));
    expect(serialized).not.toContain('legal:accept');
    expect(serialized).not.toContain('legal:decline');
  });
});

describe('buildV2TradePrompt', () => {
  it.each(LANGS)('reuses V1\'s registered onboarding_trade template with zero variables in %s', (lang) => {
    // buildProfileInteractivePrompt (V1) sends this template no variables.
    const p = buildV2TradePrompt(lang, 'Pick one', ['Alpha', 'Beta']);
    expect(p.templateName).toBe(`onboarding_trade_${lang}`);
    expect(p.variables).toEqual({});
  });

  it.each(LANGS)('numbers each option in the fallback body in %s', (lang) => {
    const p = buildV2TradePrompt(lang, 'Pick one', ['Alpha', 'Beta', 'Gamma']);
    expect(p.fallbackBody).toContain('1. Alpha');
    expect(p.fallbackBody).toContain('2. Beta');
    expect(p.fallbackBody).toContain('3. Gamma');
  });
});

describe('buildV2NumberedOptionsPrompt', () => {
  it.each(LANGS)('numbers each option from 1 in %s', (lang) => {
    const p = buildV2NumberedOptionsPrompt(lang, 'Pick one', ['Alpha', 'Beta', 'Gamma']);
    expect(p.fallbackBody).toContain('1. Alpha');
    expect(p.fallbackBody).toContain('2. Beta');
    expect(p.fallbackBody).toContain('3. Gamma');
  });
});

describe('V2_FALLBACK_TRUST_QUESTIONS', () => {
  it('has exactly three reviewed bilingual questions with EN != ES', () => {
    expect(V2_FALLBACK_TRUST_QUESTIONS).toHaveLength(3);
    for (const q of V2_FALLBACK_TRUST_QUESTIONS) {
      expect(q.en.trim().length).toBeGreaterThan(0);
      expect(q.es.trim().length).toBeGreaterThan(0);
      expect(q.en).not.toBe(q.es);
    }
  });

  it('asks no question about years of experience / how long — the profile already collected that', () => {
    // R1-A: menu labels and duration questions give the AI scorer nothing to
    // grade. Q1 used to ask "How many years have you worked in this trade?",
    // which duplicates `users.years_experience` collected at profile.experience.
    const banned = /how many years|how long|years have you|cuantos anos|cuanto tiempo/i;
    for (const q of V2_FALLBACK_TRUST_QUESTIONS) {
      expect(q.en).not.toMatch(banned);
      expect(q.es).not.toMatch(banned);
    }
  });

  it('opens with a broad, trade-agnostic question about the work itself', () => {
    expect(V2_FALLBACK_TRUST_QUESTIONS[0].en).toMatch(/typical day/i);
    expect(V2_FALLBACK_TRUST_QUESTIONS[0].es).toMatch(/dia tipico/i);
  });

  it('is plain ASCII on both sides, matching every other v2 template string', () => {
    for (const q of V2_FALLBACK_TRUST_QUESTIONS) {
      expect(q.en).toMatch(/^[\x00-\x7F]*$/);
      expect(q.es).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});
