/**
 * Bilingual message templates (EN/ES) for the WhatsApp processor.
 *
 * Session messages are sent as plain WhatsApp text in response to a user.
 * Business-initiated template messages live in Twilio Content Template Builder
 * and are referenced by HX SID from the Twilio secret.
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
  // Commands / idle / jobs
  | 'idle_help'
  | 'help_menu'
  | 'profile_not_ready'
  | 'jobs_none'
  | 'job_accepted'
  | 'job_declined'
  | 'job_not_found'
  // Errors
  | 'unknown_message';

const templates: Record<TemplateKey, Record<Lang, string>> = {
  welcome_new_user: {
    es: 'Bienvenido a Jale.\n\nTe enviamos un codigo de verificacion por WhatsApp. Responde aqui con el codigo.',
    en: 'Welcome to Jale.\n\nWe sent you a verification code on WhatsApp. Reply here with the code.',
  },
  welcome_existing_user: {
    es: 'Hola de nuevo.\n\nTe enviamos un codigo de verificacion por WhatsApp. Responde aqui con el codigo.',
    en: 'Welcome back.\n\nWe sent you a verification code on WhatsApp. Reply here with the code.',
  },
  otp_retry: {
    es: 'Ese codigo no funciono. Intenta de nuevo.',
    en: 'That code did not work. Try again.',
  },
  otp_timeout: {
    es: 'Hubo demasiados intentos.\n\nEnvia "Hola" para empezar de nuevo.',
    en: 'There were too many attempts.\n\nSend "Hi" to start again.',
  },
  otp_expired: {
    es: 'Tu codigo expiro.\n\nEnvia "Hola" para recibir uno nuevo.',
    en: 'Your code expired.\n\nSend "Hi" to receive a new one.',
  },
  otp_expired_retry: {
    es: 'Tu codigo expiro.\n\nTe enviamos uno nuevo por WhatsApp. Responde aqui con el codigo.',
    en: 'Your code expired.\n\nWe sent a new one on WhatsApp. Reply here with the code.',
  },

  legal_prompt: {
    es: 'Cuenta verificada.\n\nAntes de enviarte trabajos, acepta los terminos:\n{{tos_url}}\n\nResponde "Acepto" o "No acepto".',
    en: 'Account verified.\n\nBefore we send jobs, accept the terms:\n{{tos_url}}\n\nReply "Accept" or "Decline".',
  },
  legal_accepted: {
    es: 'Listo. Vamos a crear tu perfil para enviarte mejores trabajos.',
    en: 'Done. Let\'s build your profile so we can send better jobs.',
  },
  legal_declined: {
    es: 'Entendido. No podemos enviarte trabajos hasta que aceptes los terminos.\n\nEnvia "Hola" cuando quieras empezar de nuevo.',
    en: 'Understood. We cannot send jobs until you accept the terms.\n\nSend "Hi" when you want to start again.',
  },

  profile_intro: {
    es: 'Vamos a crear tu perfil para enviarte mejores trabajos.',
    en: 'Let\'s build your profile so we can send better jobs.',
  },
  ask_name: {
    es: 'Perfil\n\nCual es tu nombre completo?',
    en: 'Profile\n\nWhat is your full name?',
  },
  ask_city: {
    es: 'Perfil\n\nEn que ciudad o codigo postal trabajas?',
    en: 'Profile\n\nWhat city or zip code do you work in?',
  },
  ask_trade: {
    es: 'Perfil\n\nCual es tu oficio principal?\n1. Electricista\n2. Plomero\n3. Carpintero\n4. Concreto\n5. Pintura\n6. Otro\n\nResponde con el numero.',
    en: 'Profile\n\nWhat is your main trade?\n1. Electrician\n2. Plumber\n3. Carpenter\n4. Concrete\n5. Painting\n6. Other\n\nReply with the number.',
  },
  ask_trade_freetext: {
    es: 'Perfil\n\nCual es tu oficio?',
    en: 'Profile\n\nWhat is your trade?',
  },
  ask_experience: {
    es: 'Perfil\n\nCuantos anos de experiencia tienes?\n1. 0-1 anos\n2. 2-4 anos\n3. 5-9 anos\n4. 10+ anos\n\nResponde con el numero.',
    en: 'Profile\n\nHow many years of experience do you have?\n1. 0-1 years\n2. 2-4 years\n3. 5-9 years\n4. 10+ years\n\nReply with the number.',
  },
  ask_transportation: {
    es: 'Perfil\n\nTienes transporte propio?\n1. Si\n2. No\n\nResponde con el numero.',
    en: 'Profile\n\nDo you have your own transportation?\n1. Yes\n2. No\n\nReply with the number.',
  },
  ask_availability: {
    es: 'Perfil\n\nCual es tu disponibilidad?\n1. Tiempo completo\n2. Medio tiempo\n3. Fines de semana\n4. Flexible\n\nResponde con el numero.',
    en: 'Profile\n\nWhat is your availability?\n1. Full-time\n2. Part-time\n3. Weekends\n4. Flexible\n\nReply with the number.',
  },
  profile_complete: {
    es: 'Tu perfil esta listo.\n\nEnvia "Ayuda" para ver comandos o "Trabajos" para ver oportunidades.',
    en: 'Your profile is ready.\n\nSend "Help" to see commands or "Jobs" to see opportunities.',
  },
  profile_reprompt: {
    es: 'Terminemos tu perfil primero.\n\n{{question}}',
    en: 'Let\'s finish your profile first.\n\n{{question}}',
  },
  profile_jobs_blocked: {
    es: 'Podras ver trabajos cuando termines tu perfil.\n\n{{question}}',
    en: 'You can view jobs after your profile is complete.\n\n{{question}}',
  },

  idle_help: {
    es: 'No entendi ese mensaje.\n\nEnvia "Ayuda" para ver comandos.',
    en: 'I did not understand that message.\n\nSend "Help" to see commands.',
  },
  help_menu: {
    es: 'Comandos\n\nTrabajos - Ver oportunidades\nPerfil - Ver tu perfil\nAyuda - Ver estos comandos\n\nEn una alerta de trabajo, usa los botones.\n\nSi ves una lista numerada, responde con el numero del trabajo:\n[numero] aceptar - Aplicar\n[numero] info - Ver detalles\n[numero] no - Omitir',
    en: 'Commands\n\nJobs - See opportunities\nProfile - See your profile\nHelp - Show these commands\n\nOn a job alert, use the buttons.\n\nIf you see a numbered list, reply with the job number:\n[number] accept - Apply\n[number] info - See details\n[number] no - Skip',
  },
  profile_not_ready: {
    es: 'Tu perfil aun no esta listo.\n\nTermina las preguntas primero. Envia "Ayuda" para ver comandos.',
    en: 'Your profile is not ready yet.\n\nFinish the questions first. Send "Help" to see commands.',
  },
  jobs_none: {
    es: 'No hay trabajos disponibles ahora.\n\nTe avisaremos cuando lleguen oportunidades.',
    en: 'No jobs are available right now.\n\nWe will let you know when opportunities come in.',
  },
  job_accepted: {
    es: 'Aplicacion enviada.\n\nEl empleador recibira tu informacion.',
    en: 'Application sent.\n\nThe employer will receive your information.',
  },
  job_declined: {
    es: 'Entendido. Seguiremos buscando trabajos para ti.',
    en: 'Got it. We will keep looking for jobs for you.',
  },
  job_not_found: {
    es: 'Ese trabajo ya no esta disponible.\n\nEnvia "Trabajos" para ver opciones actuales.',
    en: 'That job is no longer available.\n\nSend "Jobs" to see current options.',
  },

  unknown_message: {
    es: 'No entendi ese mensaje.\n\nEnvia "Ayuda" para ver comandos.',
    en: 'I did not understand that message.\n\nSend "Help" to see commands.',
  },
};

/**
 * Get a bilingual template, optionally substituting `{{placeholder}}` values.
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
 */
export function detectLanguage(text: string): Lang {
  const normalized = text.trim().toLowerCase();
  if (/^(hello|hi|hey)\b/.test(normalized)) return 'en';
  return 'es';
}
