/**
 * Bilingual message templates (EN/ES) for the WhatsApp processor.
 *
 * SESSION messages (sent in reply to a user-initiated message within 24h) are
 * plain strings — we send them via Twilio's free-form message API.
 *
 * TEMPLATE messages (business-initiated outside the session window — job alerts,
 * profile reminders, welcome re-engagement) are identified by their HX SID
 * from Twilio Content Template Builder. Those SIDs live in the Twilio secret
 * under `.templates.{name}` and are NOT in this file.
 *
 * Source: docs/superpowers/specs/2026-04-09-whatsapp-v1-profile-builder-design.md
 *         docs/superpowers/specs/2026-04-07-whatsapp-integration-design.md
 */

export type Lang = 'en' | 'es';

/** All plain-text message keys used by the processor state machine. */
export type TemplateKey =
  // Onboarding
  | 'welcome_new_user'
  | 'welcome_existing_user'
  | 'otp_retry'
  | 'otp_timeout'
  | 'otp_expired'
  | 'otp_expired_retry'
  // Legal
  | 'legal_prompt'
  | 'legal_accepted'
  | 'legal_declined'
  // Profile builder
  | 'profile_intro'
  | 'ask_name'
  | 'ask_city'
  | 'ask_trade'
  | 'ask_trade_freetext'
  | 'ask_experience'
  | 'ask_transportation'
  | 'ask_availability'
  | 'profile_complete'
  | 'profile_reprompt'
  | 'profile_jobs_blocked'
  // Idle / job responses
  | 'idle_help'
  | 'jobs_none'
  | 'job_accepted'
  | 'job_declined'
  | 'job_not_found'
  // Errors
  | 'unknown_message';

const templates: Record<TemplateKey, Record<Lang, string>> = {
  // ── Onboarding ────────────────────────────────────────────────
  welcome_new_user: {
    es: '¡Bienvenido a Jale! Te enviamos un código por SMS. Envíalo aquí:',
    en: 'Welcome to Jale! We sent you a verification code by SMS. Send it here:',
  },
  welcome_existing_user: {
    es: '¡Hola! Verificaremos tu cuenta. Te enviamos un código por SMS:',
    en: 'Hello! We will verify your account. We sent you a code by SMS:',
  },
  otp_retry: {
    es: 'Código incorrecto. Intenta de nuevo:',
    en: 'Incorrect code. Please try again:',
  },
  otp_timeout: {
    es: 'Demasiados intentos. Escríbenos de nuevo más tarde.',
    en: 'Too many attempts. Message us again later.',
  },
  otp_expired: {
    es: 'Tu código expiró. Envía "Hola" para recibir uno nuevo.',
    en: 'Your code expired. Send "Hi" to receive a new one.',
  },
  // Used when the Cognito session timed out (~3 min) while the worker was still
  // entering a code. The processor issues a fresh InitiateAuth (→ new Twilio
  // SMS) and keeps the worker in awaiting_otp — NOT a failed attempt.
  otp_expired_retry: {
    es: 'Tu código expiró. Te enviamos uno nuevo por SMS — envíalo aquí:',
    en: 'Your code expired. We sent a new one by SMS — send it here:',
  },

  // ── Legal ─────────────────────────────────────────────────────
  legal_prompt: {
    es: 'Cuenta verificada. Revisa nuestros Términos: {{tos_url}}\n¿Aceptas? Responde "Acepto" o "No acepto".',
    en: 'Account verified. Review our Terms: {{tos_url}}\nDo you accept? Reply "Accept" or "Decline".',
  },
  legal_accepted: {
    es: '¡Perfecto! Vamos a crear tu perfil para enviarte los trabajos correctos. Toma como 3 minutos.',
    en: 'Perfect! Let\'s build your profile so we send you the right jobs. Takes about 3 minutes.',
  },
  legal_declined: {
    es: 'No podemos enviarte alertas sin aceptar. Escríbenos cuando quieras.',
    en: "We can't send you alerts without your acceptance. Message us anytime.",
  },

  // ── Profile builder (from 2026-04-09 spec §Bilingual Templates) ─
  profile_intro: {
    es: 'Vamos a crear tu perfil para enviarte los trabajos correctos. Toma como 3 minutos.',
    en: "Let's build your profile so we send you the right jobs. Takes about 3 minutes.",
  },
  ask_name: {
    es: '¿Cuál es tu nombre completo?',
    en: 'What is your full name?',
  },
  ask_city: {
    es: '¿En qué ciudad o código postal estás?',
    en: 'What city or zip code are you in?',
  },
  ask_trade: {
    es: '¿Cuál es tu oficio principal? Responde con el número:\n1) Electricista\n2) Plomero\n3) Carpintero\n4) Concreto\n5) Pintura\n6) Otro',
    en: 'What is your main trade? Reply with the number:\n1) Electrician\n2) Plumber\n3) Carpenter\n4) Concrete\n5) Painting\n6) Other',
  },
  ask_trade_freetext: {
    es: '¿Cuál es tu oficio?',
    en: 'What is your trade?',
  },
  ask_experience: {
    es: '¿Cuántos años de experiencia tienes? Responde con el número:\n1) 0-1 años\n2) 2-4 años\n3) 5-9 años\n4) 10+ años',
    en: 'How many years of experience? Reply with the number:\n1) 0-1 years\n2) 2-4 years\n3) 5-9 years\n4) 10+ years',
  },
  ask_transportation: {
    es: '¿Tienes transporte propio? Responde:\n1) Sí\n2) No',
    en: 'Do you have your own transportation? Reply:\n1) Yes\n2) No',
  },
  ask_availability: {
    es: '¿Cuál es tu disponibilidad? Responde con el número:\n1) Tiempo completo\n2) Medio tiempo\n3) Fines de semana\n4) Flexible',
    en: 'What is your availability? Reply with the number:\n1) Full-time\n2) Part-time\n3) Weekends\n4) Flexible',
  },
  profile_complete: {
    es: '¡Tu perfil está listo! Ahora recibirás alertas de trabajo. Envía "Trabajos" para ver oportunidades disponibles.',
    en: 'Your profile is ready! You\'ll now receive job alerts. Send "Jobs" to see available opportunities.',
  },
  profile_reprompt: {
    es: 'Terminemos tu perfil primero. {{question}}',
    en: "Let's finish your profile first. {{question}}",
  },
  profile_jobs_blocked: {
    es: '¡Recibirás alertas de trabajo cuando completes tu perfil! {{question}}',
    en: "You'll get job alerts once your profile is complete! {{question}}",
  },

  // ── Idle / job responses ──────────────────────────────────────
  idle_help: {
    es: 'Envía "Trabajos" para ver oportunidades disponibles.',
    en: 'Send "Jobs" to see available opportunities.',
  },
  jobs_none: {
    es: 'No hay trabajos disponibles ahora mismo. Te avisaremos cuando lleguen oportunidades.',
    en: 'No jobs available right now. We\'ll let you know when opportunities come in.',
  },
  job_accepted: {
    es: '✅ ¡Aplicación enviada! El empleador recibirá tu información.',
    en: '✅ Application sent! The employer will receive your information.',
  },
  job_declined: {
    es: 'Entendido. ¡Seguiremos buscando para ti! 👍',
    en: "Got it. We'll keep looking for you! 👍",
  },
  job_not_found: {
    es: 'Este trabajo ya no está disponible.',
    en: 'This job is no longer available.',
  },

  // ── Errors ────────────────────────────────────────────────────
  unknown_message: {
    es: 'No entendí eso. Envía "Trabajos" para ver oportunidades.',
    en: "I didn't understand that. Send \"Jobs\" to see opportunities.",
  },
};

/**
 * Get a bilingual template, optionally substituting `{{placeholder}}` values.
 *
 * @param key  Template key
 * @param lang 'en' or 'es'
 * @param vars Map of placeholder names → values (e.g. { tos_url: 'https://...' })
 */
export function t(
  key: TemplateKey,
  lang: Lang,
  vars?: Record<string, string>,
): string {
  let s = templates[key][lang];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    }
  }
  return s;
}

/**
 * Detect language from the user's greeting. Falls back to Spanish.
 *
 * Matches the 2026-04-07 spec: "Hola" → es, "Hello"/"Hi" → en, anything else → es.
 */
export function detectLanguage(text: string): Lang {
  const normalized = text.trim().toLowerCase();
  if (/^(hello|hi|hey)\b/.test(normalized)) return 'en';
  return 'es';
}
