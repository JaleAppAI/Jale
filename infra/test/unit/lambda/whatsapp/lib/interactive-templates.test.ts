import {
  buildLegalInteractivePrompt,
  buildMediaInteractivePrompt,
  buildProfileInteractivePrompt,
  buildTrustInteractivePrompt,
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
    expect(prompt?.fallbackBody).toBe('Tienes transporte propio?');
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
});
