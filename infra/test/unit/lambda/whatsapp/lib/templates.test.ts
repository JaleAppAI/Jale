import { t, detectLanguage, TemplateKey, Lang } from '../../../../../lambda/whatsapp/lib/templates';
import {
  ACCOUNT_EXISTENCE_LEAK_PATTERN,
  expectDistinctLanguages,
} from './v2-copy-test-helpers';

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
      'unknown_message', 'processing_error',
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
    expect(help).toContain('Chats');
    expect(help).toContain('Close');
    expect(help).toContain('Help');
    expect(help).toContain('use the buttons');
    // Sprint 24 C1: the advertised verb follows the relabelled buttons.
    expect(help).toContain('[number] interested');
    expect(help).not.toContain('1 interested');
  });

  it('help menu lists the main commands in Spanish', () => {
    const help = t('help_menu', 'es');
    expect(help).toContain('Trabajos');
    expect(help).toContain('Perfil');
    expect(help).toContain('Chats');
    expect(help).toContain('Cerrar');
    expect(help).toContain('Ayuda');
    expect(help).toContain('usa los botones');
    expect(help).toContain('[numero] me interesa');
  });

  it('inserts a substituted value containing $& and $1 literally, without treating it as a replacement pattern', () => {
    // String.prototype.replace treats $&, $1, $` etc. as special patterns
    // when the replacement is a STRING. A model-produced summary containing
    // a literal "$" must not be corrupted by that.
    const value = 'Rate is $1/hr, total $&, prior job $`';
    const s = t('ai_extraction_summary', 'en', { summary: value });
    expect(s).toContain(value);
    expect(s).not.toContain('{{summary}}');
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

const V2_KEYS: TemplateKey[] = [
  'v2_start_invitation', 'v2_start_cooldown_note',
  'v2_otp_sent', 'v2_otp_invalid', 'v2_otp_expired', 'v2_otp_locked',
  'v2_otp_resend_cooldown', 'v2_otp_send_cap', 'v2_otp_send_failed',
  'v2_legal_prompt', 'v2_legal_declined',
  'v2_ask_name', 'v2_name_invalid',
  'v2_ask_location', 'v2_location_invalid',
  'v2_ask_custom_trade', 'v2_custom_trade_invalid',
  'v2_gate_blocked', 'v2_restarted', 'v2_language_changed', 'v2_ready',
  'v2_options_footer',
  'v2_voice_ack', 'v2_voice_failed', 'v2_voice_not_supported', 'v2_voice_invalid_type',
  'voice_note_not_supported',
];

// `v2_start_invitation` is deliberately bilingual in BOTH slots: a worker
// whose language is unknown must see both START and EMPEZAR, so it cannot
// satisfy a single-language marker check. Exempted by name, not by
// weakening the check for everything else.
const LANGUAGE_MARKER_EXEMPT: ReadonlySet<TemplateKey> = new Set<TemplateKey>([
  'v2_start_invitation',
]);

describe('v2 templates', () => {
  it.each(V2_KEYS)('%s has distinct non-empty EN and ES copy', (key) => {
    const en = t(key, 'en');
    const es = t(key, 'es');
    expect(en.trim().length).toBeGreaterThan(0);
    expect(es.trim().length).toBeGreaterThan(0);
    expect(en).not.toBe(es);
  });

  it.each(V2_KEYS.filter((k) => !LANGUAGE_MARKER_EXEMPT.has(k)))(
    '%s: the ES slot reads as Spanish and the EN slot reads as English',
    (key) => {
      expectDistinctLanguages(t(key, 'en'), t(key, 'es'));
    },
  );

  it('processing_error mentions retrying and the SUPPORT/SOPORTE keyword, in distinct languages', () => {
    // Sent by the processor's error fallback; the support keyword must
    // match isSupportCommand (flows.ts) exactly or the escape hatch is dead.
    const en = t('processing_error', 'en');
    const es = t('processing_error', 'es');
    expectDistinctLanguages(en, es);
    expect(en.toLowerCase()).toContain('try again');
    expect(en.toLowerCase()).toContain('support');
    expect(es.toLowerCase()).toContain('intenta de nuevo');
    expect(es.toLowerCase()).toContain('soporte');
  });

  it('v2_otp_sent interpolates the 5-minute limit', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      expect(t('v2_otp_sent', lang, { minutes: '5' })).toContain('5');
      expect(t('v2_otp_sent', lang, { minutes: '5' })).not.toContain('{{');
    }
  });

  it('v2_otp_invalid interpolates remaining attempts', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_invalid', lang, { attempts: '2' });
      expect(s).toContain('2');
      expect(s).not.toContain('{{');
    }
  });

  it('v2_otp_locked interpolates 15 minutes', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_locked', lang, { minutes: '15' });
      expect(s).toContain('15');
      expect(s).not.toContain('{{');
    }
  });

  it('v2_otp_resend_cooldown interpolates seconds', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_otp_resend_cooldown', lang, { seconds: '60' });
      expect(s).toContain('60');
      expect(s).not.toContain('{{');
    }
  });

  // Sprint 24 A3: the copy a worker sees when the OTP SMS could not be sent.
  it('v2_otp_send_failed names SMS, invites a retry, and stays plain ASCII', () => {
    const es = t('v2_otp_send_failed', 'es');
    const en = t('v2_otp_send_failed', 'en');
    expect(es).toContain('SMS');
    expect(en).toContain('SMS');
    expect(es.toLowerCase()).toContain('intenta de nuevo');
    expect(en.toLowerCase()).toContain('try again');
    // A non-ASCII byte reaches Twilio as a GSM-7 escape and re-segments the
    // message -- every other string in this module is unaccented ASCII.
    expect(es).toMatch(/^[\x00-\x7F]*$/);
    expect(en).toMatch(/^[\x00-\x7F]*$/);
    // No blame, no dead end: both recoveries the worker actually has.
    expect(es.toLowerCase()).toContain('otro numero');
    expect(en.toLowerCase()).toContain('another number');
  });

  it('the start invitation offers both languages and never reveals account existence', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      const s = t('v2_start_invitation', lang);
      expect(s).toContain('START');
      expect(s).toContain('EMPEZAR');
      expect(s).not.toMatch(ACCOUNT_EXISTENCE_LEAK_PATTERN);
    }
  });
});

// ── Sprint 23: application stages ──

const SPRINT23_APPLICATION_KEYS: TemplateKey[] = [
  'applications_header',
  'applications_footer',
  'applications_none',
  'application_not_requested_yet',
  'application_already_complete',
  'application_hired_info',
  'application_later_ack',
];

describe('sprint 23 application-stage templates', () => {
  test.each(SPRINT23_APPLICATION_KEYS)('%s has distinct non-empty EN and ES copy', (key) => {
    const en = t(key, 'en');
    const es = t(key, 'es');
    expect(en.trim().length).toBeGreaterThan(0);
    expect(es.trim().length).toBeGreaterThan(0);
    expect(en).not.toBe(es);
  });

  // Unaccented ASCII on BOTH sides, matching every other string in this module
  // and the V2_FALLBACK_TRUST_QUESTIONS check in interactive-templates.test.ts.
  // A non-ASCII byte here reaches Twilio as a GSM-7 escape and silently
  // re-segments the message.
  test.each(SPRINT23_APPLICATION_KEYS)('%s is plain ASCII in both languages', (key) => {
    expect(t(key, 'en')).toMatch(/^[\x00-\x7F]*$/);
    expect(t(key, 'es')).toMatch(/^[\x00-\x7F]*$/);
  });

  it('leaves no unsubstituted {{placeholder}} in either language', () => {
    for (const key of SPRINT23_APPLICATION_KEYS) {
      expect(t(key, 'en')).not.toContain('{{');
      expect(t(key, 'es')).not.toContain('{{');
    }
  });

  // The header/footer pair frames the numbered list the `aplicaciones` command
  // prints, so the footer must tell the worker what the numbers are for.
  it('the applications list footer asks for the number', () => {
    expect(t('applications_footer', 'es')).toContain('numero');
    expect(t('applications_footer', 'en')).toContain('number');
  });

  // The keyword named in the empty/never-asked copy has to be one
  // isApplicationsCommand / isJobsKeyword actually accepts, or the escape
  // hatch is dead text.
  it('points at keywords the command parsers accept', () => {
    expect(t('applications_none', 'es')).toContain('trabajos');
    expect(t('applications_none', 'en')).toContain('jobs');
    expect(t('application_later_ack', 'es')).toContain('aplicaciones');
    expect(t('application_later_ack', 'en')).toContain('applications');
  });
});

describe('sprint 23: job_accepted is stage-1-only copy', () => {
  // Apply is now stage 1 alone: the employer sees the profile and prompt
  // answers, and the questionnaire/documents are requested later and only if
  // they want to move forward. The exact strings are asserted because the
  // seeded Twilio `application_update_*` bodies and the `aplicaciones` command
  // are written against this promise — a reworded confirmation that drops the
  // "we will ask you for more details" clause makes the later ping look
  // unsolicited.
  it('promises a later details request and names the aplicaciones command (ES)', () => {
    expect(t('job_accepted', 'es')).toBe(
      'Aplicacion enviada. El empleador ya ve tu perfil y tus respuestas. '
      + 'Si quiere avanzar contigo, te pediremos algunos datos mas por aqui. '
      + 'Escribe "aplicaciones" para ver tus solicitudes.',
    );
  });

  it('promises a later details request and names the applications command (EN)', () => {
    expect(t('job_accepted', 'en')).toBe(
      'Application sent. The employer can now see your profile and your answers. '
      + 'If they want to move forward, we will ask you for a few more details here. '
      + 'Reply "applications" to see your applications.',
    );
  });

  it('no longer claims the application is complete or mentions documents', () => {
    for (const lang of ['en', 'es'] as Lang[]) {
      expect(t('job_accepted', lang)).not.toMatch(/document|documento/i);
    }
  });
});

describe('sprint 23: help_menu advertises the aplicaciones command', () => {
  // buildHelpMenuInteractivePrompt uses this copy as the list picker's
  // fallbackBody, so a worker outside the list-picker path still has to be
  // told the command exists.
  it('lists Aplicaciones with its description in Spanish', () => {
    expect(t('help_menu', 'es')).toContain('Aplicaciones - Ver tus solicitudes');
  });

  it('lists Applications with its description in English', () => {
    expect(t('help_menu', 'en')).toContain('Applications - See your applications');
  });

  // The list picker's rows are ordered Jobs, Applications, Profile, Chats,
  // Help (scripts/seed-whatsapp-twilio-templates.mjs); the plain-text fallback
  // must not contradict that ordering.
  it('places the new row directly after the jobs row in both languages', () => {
    const es = t('help_menu', 'es');
    expect(es.indexOf('Trabajos')).toBeLessThan(es.indexOf('Aplicaciones'));
    expect(es.indexOf('Aplicaciones')).toBeLessThan(es.indexOf('Perfil'));

    const en = t('help_menu', 'en');
    expect(en.indexOf('Jobs')).toBeLessThan(en.indexOf('Applications'));
    expect(en.indexOf('Applications')).toBeLessThan(en.indexOf('Profile'));
  });
});

describe('sprint 24: help_menu advertises the interested verbs', () => {
  // Luis relabelled the Twilio job-alert buttons to "interested / not
  // interested"; the typed grammar in this copy has to say the same thing,
  // or the help menu teaches a verb the buttons no longer show.
  // parseTypedJobAction still accepts the old verbs -- only what we
  // ADVERTISE changes here.
  it('teaches "[numero] me interesa / info / no" in Spanish', () => {
    const es = t('help_menu', 'es');
    expect(es).toContain('[numero] me interesa - Aplicar');
    expect(es).toContain('[numero] info - Ver detalles');
    expect(es).toContain('[numero] no - Omitir');
    expect(es).not.toContain('[numero] aceptar');
  });

  it('teaches "[number] interested / info / no" in English', () => {
    const en = t('help_menu', 'en');
    expect(en).toContain('[number] interested - Apply');
    expect(en).toContain('[number] info - See details');
    expect(en).toContain('[number] no - Skip');
    expect(en).not.toContain('[number] accept');
  });
});
