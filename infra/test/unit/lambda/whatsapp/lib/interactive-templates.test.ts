import {
  buildHelpMenuInteractivePrompt,
  buildLegalInteractivePrompt,
  buildMediaInteractivePrompt,
  buildProfileInteractivePrompt,
  buildTrustInteractivePrompt,
} from '../../../../../lambda/whatsapp/lib/interactive-templates';
import { t, type Lang } from '../../../../../lambda/whatsapp/lib/templates';
import {
  buildV2StartInvitationPrompt, buildV2OtpPrompt, buildV2LegalPrompt,
  buildV2NumberedOptionsPrompt, V2_FALLBACK_TRUST_QUESTIONS,
} from '../../../../../lambda/whatsapp/lib/interactive-templates';

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

  it('builds parameterized trust quick-reply prompts', () => {
    const prompt = buildTrustInteractivePrompt(0, 'electrician', 'en');
    expect(prompt).toMatchObject({
      templateName: 'trust_choice_en',
      variables: {
        '1': 'One more question so we can recommend better jobs.\n\nWhat is your specialty?',
        '2': 'Residential',
        '3': 'Commercial',
        '4': 'Industrial',
        '5': 'trust:0:0',
        '6': 'trust:0:1',
        '7': 'trust:0:2',
      },
    });
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
    expect(p.fallbackBody).not.toMatch(/existing|already|ya tienes/i);
  });
});

describe('buildV2OtpPrompt', () => {
  it.each(LANGS)('interpolates the expiry and offers resend in %s', (lang) => {
    const p = buildV2OtpPrompt(lang, '5');
    expect(p.fallbackBody).toContain('5');
    expect(p.fallbackBody).not.toContain('{{');
    expect(JSON.stringify(p)).toContain('otp:resend');
  });
});

describe('buildV2LegalPrompt', () => {
  it.each(LANGS)('carries Terms and Privacy in variables and fallback in %s', (lang) => {
    const p = buildV2LegalPrompt(lang, 'https://jale.app/terms', 'https://jale.app/privacy');
    const vars = Object.values(p.variables);
    expect(vars).toContain('https://jale.app/terms');
    expect(vars).toContain('https://jale.app/privacy');
    expect(p.fallbackBody).toContain('https://jale.app/terms');
    expect(p.fallbackBody).toContain('https://jale.app/privacy');
    const serialized = JSON.stringify(p);
    expect(serialized).toContain('legal:accept');
    expect(serialized).toContain('legal:decline');
    expect(serialized).toContain('legal:review');
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
});
