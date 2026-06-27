import { t, detectLanguage, TemplateKey } from '../../../../../lambda/whatsapp/lib/templates';

describe('templates.ts — t()', () => {
  it('returns the ES variant', () => {
    expect(t('welcome_new_user', 'es')).toMatch(/Bienvenido/);
  });

  it('returns the EN variant', () => {
    expect(t('welcome_new_user', 'en')).toMatch(/Welcome/);
  });

  it('substitutes {{placeholder}} values', () => {
    const s = t('legal_prompt', 'es', { tos_url: 'https://example.com/tos' });
    expect(s).toContain('https://example.com/tos');
    expect(s).not.toContain('{{tos_url}}');
  });

  it('substitutes multiple placeholders', () => {
    const s = t('profile_reprompt', 'en', { question: 'What is your name?' });
    expect(s).toContain('What is your name?');
    expect(s).not.toContain('{{question}}');
  });

  it('leaves unknown placeholders intact', () => {
    const s = t('legal_prompt', 'es', {});
    // tos_url placeholder stays because no value was supplied
    expect(s).toContain('{{tos_url}}');
  });

  it('all keys have both ES and EN variants (no missing translations)', () => {
    const keys = [
      'start_prompt',
      'welcome_new_user', 'welcome_existing_user', 'otp_retry', 'otp_timeout', 'otp_expired',
      'otp_expired_retry',
      'legal_prompt', 'legal_declined',
      'ask_name', 'ask_city', 'ask_trade', 'ask_trade_freetext',
      'ask_experience', 'ask_transportation', 'ask_availability',
      'profile_complete', 'profile_reprompt', 'profile_jobs_blocked',
      'idle_help', 'help_menu', 'profile_not_ready',
      'jobs_none', 'job_accepted', 'job_already_applied', 'job_documents_required', 'job_declined', 'job_not_found',
      'unknown_message',
      'ask_media_photo', 'media_photo_invalid', 'ask_media_photo_type',
      'ask_media_voice', 'media_voice_invalid',
      'ai_processing_ack', 'ai_processing_wait', 'ai_extraction_summary', 'ai_extraction_failed',
    ] as const;
    for (const k of keys) {
      const es = t(k, 'es');
      const en = t(k, 'en');
      expect(es).toBeTruthy();
      expect(en).toBeTruthy();
      expect(es).not.toBe(en);
    }
  });

  it('profile question numeric choices match the canonical slug order', () => {
    // ask_trade lists: 1. Electricista 2. Plomero 3. Carpintero 4. Concreto 5. Pintura 6. Otro
    // These must align with PROFILE_FIELDS.find('main_trade').options in flows.ts:
    // [electrician, plumber, carpenter, concrete, painting, other]
    const tradeEs = t('ask_trade', 'es');
    expect(tradeEs).toMatch(/1\.\s*Electricista/);
    expect(tradeEs).toMatch(/6\.\s*Otro/);

    const expEn = t('ask_experience', 'en');
    expect(expEn).toMatch(/1\.\s*0-1/);
    expect(expEn).toMatch(/4\.\s*10\+/);
  });

  it('profile questions read like chat prompts without repeated section headers', () => {
    const prompts = [
      t('ask_name', 'es'),
      t('ask_city', 'es'),
      t('ask_trade', 'es'),
      t('ask_trade_freetext', 'es'),
      t('ask_experience', 'es'),
      t('ask_transportation', 'es'),
      t('ask_availability', 'es'),
      t('ask_name', 'en'),
      t('ask_city', 'en'),
      t('ask_trade', 'en'),
      t('ask_trade_freetext', 'en'),
      t('ask_experience', 'en'),
      t('ask_transportation', 'en'),
      t('ask_availability', 'en'),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/^(Perfil|Profile)\n\n/);
    }
  });

  it('Spanish profile questions use compact numeric reply instructions', () => {
    expect(t('ask_trade', 'es')).toContain('Responde con 1, 2, 3, 4, 5 o 6.');
    expect(t('ask_transportation', 'es')).toContain('Responde con 1 o 2.');
  });

  it('profile completion points users to help and jobs', () => {
    const done = t('profile_complete', 'en');
    expect(done).toContain('"Help"');
    expect(done).toContain('"Jobs"');
  });

  it('help menu lists the main commands', () => {
    const help = t('help_menu', 'en');
    expect(help).toContain('Jobs');
    expect(help).toContain('Profile');
    expect(help).toContain('Help');
    expect(help).toContain('use the buttons');
    expect(help).toContain('[number] accept');
    expect(help).not.toContain('1 accept');
  });

  it('job_documents_required interpolates the missing document list', () => {
    const body = t('job_documents_required', 'en', { missing_docs: "Resume, Driver's license" });
    expect(body).toContain("Resume, Driver's license");
    expect(body).not.toContain('{{missing_docs}}');
  });
});

describe('media flow templates', () => {
  const newKeys: TemplateKey[] = [
    'ask_media_photo',
    'media_photo_invalid',
    'ask_media_photo_type',
    'ask_media_voice',
    'media_voice_invalid',
    'ai_processing_ack',
    'ai_processing_wait',
    'ai_extraction_summary',
    'ai_extraction_failed',
  ];

  test.each(newKeys)('%s has both en and es variants', (key) => {
    expect(t(key, 'en')).toBeTruthy();
    expect(t(key, 'es')).toBeTruthy();
    expect(t(key, 'en')).not.toBe(t(key, 'es'));
  });

  test('ai_extraction_summary interpolates {{summary}} variable', () => {
    const result = t('ai_extraction_summary', 'en', { summary: 'Electrician in Austin' });
    expect(result).toContain('Electrician in Austin');
    expect(result).not.toContain('{{summary}}');
  });

  test('ai_extraction_summary interpolates {{summary}} in Spanish', () => {
    const result = t('ai_extraction_summary', 'es', { summary: 'Electricista en Austin' });
    expect(result).toContain('Electricista en Austin');
    expect(result).not.toContain('{{summary}}');
  });
});

describe('templates.ts — detectLanguage', () => {
  test.each([
    ['Hola', 'es'],
    ['HOLA', 'es'],
    ['Hello', 'en'],
    ['hello', 'en'],
    ['Hi', 'en'],
    ['hey', 'en'],
    ['Trabajos', 'es'],
    ['Anything else', 'es'], // default
    ['', 'es'],
  ])('detectLanguage("%s") → %s', (input, expected) => {
    expect(detectLanguage(input)).toBe(expected);
  });
});
