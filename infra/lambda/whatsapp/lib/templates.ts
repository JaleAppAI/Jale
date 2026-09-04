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
  | 'start_prompt'
  | 'welcome_new_user'
  | 'welcome_existing_user'
  | 'otp_retry'
  | 'otp_timeout'
  | 'otp_expired'
  | 'otp_expired_retry'
  // Legal
  | 'legal_prompt'
  | 'legal_declined'
  // Profile builder
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
  | 'job_already_applied'
  | 'job_documents_required'
  | 'job_declined'
  | 'job_not_found'
  // ── Sprint 23: application stages ──
  | 'applications_header'
  | 'applications_footer'
  | 'applications_none'
  | 'application_not_requested_yet'
  | 'application_already_complete'
  | 'application_hired_info'
  | 'application_later_ack'
  // ── Sprint 24: typed codes (a job code / an application reference) ──
  | 'job_code_not_found'
  | 'application_ref_not_found'
  // Errors
  | 'unknown_message'
  | 'processing_error'
  // Media onboarding
  | 'ask_media_photo'
  | 'media_photo_invalid'
  | 'ask_media_photo_type'
  | 'ask_media_voice'
  | 'media_voice_invalid'
  | 'ai_processing_ack'
  | 'ai_processing_wait'
  | 'ai_extraction_summary'
  | 'ai_extraction_failed'
  // Support command
  | 'support_ack'
  | 'support_ack_existing'
  | 'support_needs_signup'
  // ── V2 workflow (additive; legacy keys above are unchanged) ──
  | 'v2_start_invitation'
  | 'v2_start_cooldown_note'
  | 'v2_otp_sent'
  | 'v2_otp_invalid'
  | 'v2_otp_expired'
  | 'v2_otp_locked'
  | 'v2_otp_resend_cooldown'
  | 'v2_otp_send_cap'
  | 'v2_otp_send_failed'
  | 'v2_legal_prompt'
  | 'v2_legal_declined'
  | 'v2_ask_name'
  | 'v2_name_invalid'
  | 'v2_ask_location'
  | 'v2_location_invalid'
  | 'v2_ask_trade'
  | 'v2_ask_custom_trade'
  | 'v2_custom_trade_invalid'
  | 'v2_gate_blocked'
  | 'v2_restarted'
  | 'v2_language_changed'
  | 'v2_ready'
  | 'v2_options_footer'
  // ── V2 voice (trust-question voice notes; Task 6 graceful-fallback copy) ──
  | 'v2_voice_ack'
  | 'v2_voice_failed'
  | 'v2_voice_not_supported'
  | 'v2_voice_invalid_type'
  | 'voice_note_not_supported'
  // ── V2 voice (Stream B: full voice profile intake, profile.voice_choice/
  //    profile.voice_processing). NOTE: a non-voice media file at
  //    profile.voice_choice deliberately reuses 'v2_voice_invalid_type'
  //    above rather than adding a near-duplicate key — both mean exactly
  //    "that file isn't a usable voice note", and the trust-question and
  //    profile-intake copy would otherwise diverge for no reason. ──
  | 'v2_voice_send_note'
  | 'v2_voice_processing_ack'
  | 'v2_voice_processing_wait'
  | 'v2_voice_summary'
  | 'v2_voice_fallback'
  | 'v2_voice_retry_offer'
  // ── V2 location (Task 6: bare-city inference confirmation) ──
  | 'v2_location_confirm';

const templates: Record<TemplateKey, Record<Lang, string>> = {
  start_prompt: {
    es: 'Envia "Hola" o "Hello" para empezar.',
    en: 'Send "Hola" or "Hello" to get started.',
  },
  welcome_new_user: {
    es: 'Bienvenido a Jale.\n\nTe enviamos un codigo de verificacion por SMS. Revisa los mensajes de texto de tu telefono y responde aqui con el codigo.',
    en: 'Welcome to Jale.\n\nWe sent you a verification code by SMS. Check your phone text messages and reply here with the code.',
  },
  welcome_existing_user: {
    es: 'Hola de nuevo.\n\nTe enviamos un codigo de verificacion por SMS. Revisa los mensajes de texto de tu telefono y responde aqui con el codigo.',
    en: 'Welcome back.\n\nWe sent you a verification code by SMS. Check your phone text messages and reply here with the code.',
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
    es: 'Tu codigo expiro.\n\nTe enviamos uno nuevo por SMS. Revisa los mensajes de texto de tu telefono y responde aqui con el codigo.',
    en: 'Your code expired.\n\nWe sent a new one by SMS. Check your phone text messages and reply here with the code.',
  },

  legal_prompt: {
    es: 'Cuenta verificada.\n\nAntes de enviarte trabajos, acepta los terminos:\n{{tos_url}}\n\nResponde "Acepto" o "No acepto".',
    en: 'Account verified.\n\nBefore we send jobs, accept the terms:\n{{tos_url}}\n\nReply "Accept" or "Decline".',
  },
  legal_declined: {
    es: 'Entendido. No podemos enviarte trabajos hasta que aceptes los terminos.\n\nEnvia "Hola" cuando quieras empezar de nuevo.',
    en: 'Understood. We cannot send jobs until you accept the terms.\n\nSend "Hi" when you want to start again.',
  },

  ask_name: {
    es: 'Para empezar, cual es tu nombre completo?',
    en: 'To get started, what is your full name?',
  },
  ask_city: {
    es: 'En que ciudad o codigo postal trabajas?',
    en: 'What city or zip code do you work in?',
  },
  ask_trade: {
    es: 'Cual es tu oficio principal?\n\n1. Electricista\n2. Plomero\n3. Carpintero\n4. Concreto\n5. Pintura\n6. Otro\n\nResponde con 1, 2, 3, 4, 5 o 6.',
    en: 'What is your main trade?\n\n1. Electrician\n2. Plumber\n3. Carpenter\n4. Concrete\n5. Painting\n6. Other\n\nReply with 1, 2, 3, 4, 5, or 6.',
  },
  ask_trade_freetext: {
    es: 'Cual es tu oficio?',
    en: 'What is your trade?',
  },
  ask_experience: {
    es: 'Cuantos anos de experiencia tienes?\n\n1. 0-1 anos\n2. 2-4 anos\n3. 5-9 anos\n4. 10+ anos\n\nResponde con 1, 2, 3 o 4.',
    en: 'How many years of experience do you have?\n\n1. 0-1 years\n2. 2-4 years\n3. 5-9 years\n4. 10+ years\n\nReply with 1, 2, 3, or 4.',
  },
  ask_transportation: {
    es: 'Tienes transporte propio?\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
    en: 'Do you have your own transportation?\n\n1. Yes\n2. No\n\nReply with 1 or 2.',
  },
  ask_availability: {
    es: 'Cual es tu disponibilidad?\n\n1. Tiempo completo\n2. Medio tiempo\n3. Fines de semana\n4. Flexible\n\nResponde con 1, 2, 3 o 4.',
    en: 'What is your availability?\n\n1. Full-time\n2. Part-time\n3. Weekends\n4. Flexible\n\nReply with 1, 2, 3, or 4.',
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
    es: 'Comandos\n\nTrabajos - Ver oportunidades\nAplicaciones - Ver tus solicitudes\nPerfil - Ver tu perfil\nChats - Abrir tus chats con empleadores\nCerrar - Cerrar el chat actual\nAyuda - Ver estos comandos\n\nEn una alerta de trabajo, usa los botones.\n\nSi ves una lista numerada, responde con el numero del trabajo:\n[numero] me interesa - Aplicar\n[numero] info - Ver detalles\n[numero] no - Omitir',
    en: 'Commands\n\nJobs - See opportunities\nApplications - See your applications\nProfile - See your profile\nChats - Open your employer chats\nClose - Close the current chat\nHelp - Show these commands\n\nOn a job alert, use the buttons.\n\nIf you see a numbered list, reply with the job number:\n[number] interested - Apply\n[number] info - See details\n[number] no - Skip',
  },
  profile_not_ready: {
    es: 'Tu perfil aun no esta listo.\n\nTermina las preguntas primero. Envia "Ayuda" para ver comandos.',
    en: 'Your profile is not ready yet.\n\nFinish the questions first. Send "Help" to see commands.',
  },
  jobs_none: {
    es: 'No hay trabajos disponibles ahora.\n\nTe avisaremos cuando lleguen oportunidades.',
    en: 'No jobs are available right now.\n\nWe will let you know when opportunities come in.',
  },
  // Sprint 23: apply is stage 1 only. The employer sees the profile and the
  // prompt answers now; the questionnaire/documents are asked for later, and
  // only if the employer wants to move forward.
  job_accepted: {
    es: 'Aplicacion enviada. El empleador ya ve tu perfil y tus respuestas. Si quiere avanzar contigo, te pediremos algunos datos mas por aqui. Escribe "aplicaciones" para ver tus solicitudes.',
    en: 'Application sent. The employer can now see your profile and your answers. If they want to move forward, we will ask you for a few more details here. Reply "applications" to see your applications.',
  },
  job_already_applied: {
    es: 'Ya aplicaste a este trabajo.\n\nTe avisaremos cuando el empleador actualice tu solicitud.',
    en: 'You already applied to this job.\n\nWe will let you know when the employer updates your application.',
  },
  job_documents_required: {
    es: 'Este trabajo requiere estos documentos antes de aplicar: {{missing_docs}}.\n\nSubelos en Jale y vuelve a intentar.',
    en: 'This job requires these documents before you can apply: {{missing_docs}}.\n\nUpload them in Jale and try again.',
  },
  job_declined: {
    es: 'Entendido. Seguiremos buscando trabajos para ti.',
    en: 'Got it. We will keep looking for jobs for you.',
  },
  job_not_found: {
    es: 'Ese trabajo ya no esta disponible.\n\nEnvia "Trabajos" para ver opciones actuales.',
    en: 'That job is no longer available.\n\nSend "Jobs" to see current options.',
  },

  // ── Sprint 23: application stages ──
  applications_header: {
    es: 'Tus solicitudes',
    en: 'Your applications',
  },
  applications_footer: {
    es: 'Responde con el numero para completar tus datos.',
    en: 'Reply with the number to complete your details.',
  },
  applications_none: {
    es: 'Todavia no tienes solicitudes.\n\nEscribe "trabajos" para ver oportunidades.',
    en: 'You do not have any applications yet.\n\nReply "jobs" to see opportunities.',
  },
  application_not_requested_yet: {
    es: 'Todavia no te pedimos datos adicionales para esa solicitud. Te avisaremos aqui cuando el empleador los pida.',
    en: 'We have not asked you for extra details on that application yet. We will let you know here when the employer asks.',
  },
  application_already_complete: {
    es: 'Ya enviamos tus datos para esa solicitud. No falta nada por ahora.',
    en: 'We already sent your details for that application. Nothing is missing right now.',
  },
  application_hired_info: {
    es: 'Ya te contrataron para ese trabajo. El empleador te va a contactar para los siguientes pasos.',
    en: 'You were already hired for that job. The employer will contact you about next steps.',
  },
  application_later_ack: {
    es: 'Sin problema. Escribe "aplicaciones" cuando quieras continuar.',
    en: 'No problem. Reply "applications" when you want to continue.',
  },

  // ── Sprint 24 C4: a typed code that resolved to nothing ──
  //
  // Each reply names the command that DOES work (TRABAJOS/JOBS,
  // APLICACIONES/APPLICATIONS -- both accepted by their parsers in flows.ts)
  // so a dead code is never a dead end. Unaccented ASCII, like every other
  // string in this module.
  job_code_not_found: {
    es: 'No encontramos ese codigo de trabajo. Revisa que este completo o escribe TRABAJOS para ver ofertas.',
    en: 'We could not find that job code. Check that it is complete, or reply JOBS to see openings.',
  },
  application_ref_not_found: {
    es: 'No encontramos esa solicitud en tu cuenta. Escribe APLICACIONES para ver tus solicitudes.',
    en: 'We could not find that application in your account. Reply APPLICATIONS to see your applications.',
  },
  unknown_message: {
    es: 'No entendi ese mensaje.\n\nEnvia "Ayuda" para ver comandos.',
    en: 'I did not understand that message.\n\nSend "Help" to see commands.',
  },

  // Lane-neutral safety net: sent by the processor's error fallback when a
  // message handler throws and the whole turn rolls back (the queued reply
  // included). Keywords must match isSupportCommand (flows.ts): SOPORTE /
  // SUPPORT.
  processing_error: {
    es: 'Lo sentimos, algo salio mal al procesar tu mensaje. Intenta de nuevo en unos minutos.\n\nSi el problema continua, escribe "Soporte" para hablar con nuestro equipo.',
    en: 'Sorry, something went wrong while processing your message. Please try again in a few minutes.\n\nIf the problem continues, reply "Support" to talk to our team.',
  },

  ask_media_photo: {
    es: 'Foto para tu perfil\n\nPuedes usar una foto tuya para tu perfil o una foto de tu trabajo para mostrar experiencia.\n\nManda la foto ahora, o toca Saltar si quieres hacerlo despues.',
    en: 'Profile photo\n\nYou can use a photo of yourself for your profile or a photo of your work to show job experience.\n\nSend the photo now, or tap Skip if you want to do this later.',
  },
  media_photo_invalid: {
    es: 'Ese archivo no se pudo guardar. Manda una foto en formato JPEG, PNG o WebP, o escribe "Saltar".',
    en: 'That file could not be saved. Please send a photo in JPEG, PNG, or WebP format, or type "Skip".',
  },
  ask_media_photo_type: {
    es: 'Es esta foto de tu perfil o una muestra de tu trabajo?\n1. Foto de perfil\n2. Muestra de trabajo\n\nResponde con el numero.',
    en: 'Is this a profile photo or a work sample?\n1. Profile photo\n2. Work sample\n\nReply with the number.',
  },
  ask_media_voice: {
    es: 'Como quieres crear tu perfil?\n\nPuedes mandar una nota de voz ahora y nosotros llenamos tu perfil con lo que digas.\n\nEn la nota dinos: tu oficio, ciudad donde trabajas, anos de experiencia, si tienes transporte, tu disponibilidad, herramientas o certificaciones, y ejemplos de trabajos que has hecho.\n\nTambien puedes contestar por texto si prefieres.',
    en: 'How do you want to create your profile?\n\nYou can send a voice note now and we will fill out your profile from what you say.\n\nIn the note, tell us: your trade, the city where you work, years of experience, whether you have transportation, your availability, tools or certifications, and examples of jobs you have done.\n\nYou can also answer by text if you prefer.',
  },
  media_voice_invalid: {
    es: 'Ese audio no se pudo guardar. Manda un mensaje de voz, o escribe "Saltar" para continuar con preguntas.',
    en: 'That audio could not be saved. Please send a voice message, or type "Skip" to continue with questions.',
  },
  ai_processing_ack: {
    es: 'Recibido. Estamos analizando tu mensaje de voz...\n\nTe responderemos en unos momentos.',
    en: 'Got it. We are analyzing your voice message...\n\nWe will reply in a moment.',
  },
  ai_processing_wait: {
    es: 'Todavia estamos procesando tu mensaje de voz. Te avisamos enseguida.',
    en: 'We are still processing your voice message. We will let you know shortly.',
  },
  ai_extraction_summary: {
    es: 'Perfil creado.\n\n{{summary}}\n\nVamos a completar los datos que falten.',
    en: 'Profile created.\n\n{{summary}}\n\nLet\'s fill in any missing details.',
  },
  ai_extraction_failed: {
    es: 'No pudimos procesar tu mensaje de voz. Continuemos con algunas preguntas rapidas.',
    en: 'We could not process your voice message. Let\'s continue with a few quick questions.',
  },
  support_ack: {
    es: 'Recibido. Nuestro equipo te contactara pronto por WhatsApp.',
    en: 'Got it. Our team will contact you soon on WhatsApp.',
  },
  support_ack_existing: {
    es: 'Ya tenemos tu solicitud de ayuda. Te contactaremos pronto.',
    en: 'We already have your help request. We will contact you soon.',
  },
  support_needs_signup: {
    es: 'Para pedir ayuda, primero termina tu registro. Envia "Hola" para empezar.',
    en: 'To request help, please finish signing up first. Send "Hello" to get started.',
  },

  v2_start_invitation: {
    es: 'Jale: trabajo en construccion por WhatsApp.\n\nResponde EMPEZAR para continuar en espanol, o START to continue in English.',
    en: 'Jale: construction work over WhatsApp.\n\nReply START to continue in English, o responde EMPEZAR para continuar en espanol.',
  },
  v2_start_cooldown_note: {
    es: 'Ya te enviamos una invitacion hace poco. Espera unos minutos e intenta de nuevo.',
    en: 'We already sent you an invitation recently. Please wait a few minutes and try again.',
  },
  v2_otp_sent: {
    es: 'Te enviamos un codigo por SMS. Responde aqui con el codigo. Vence en {{minutes}} minutos.',
    en: 'We sent you a code by SMS. Reply here with the code. It expires in {{minutes}} minutes.',
  },
  v2_otp_invalid: {
    es: 'Ese codigo no es correcto. Te quedan {{attempts}} intentos.',
    en: 'That code is not correct. You have {{attempts}} attempts left.',
  },
  v2_otp_expired: {
    es: 'Ese codigo ya vencio. Responde REENVIAR para recibir uno nuevo.',
    en: 'That code has expired. Reply RESEND to get a new one.',
  },
  v2_otp_locked: {
    es: 'Demasiados intentos. Intenta de nuevo en {{minutes}} minutos.',
    en: 'Too many attempts. Try again in {{minutes}} minutes.',
  },
  v2_otp_resend_cooldown: {
    es: 'Espera {{seconds}} segundos antes de pedir otro codigo.',
    en: 'Please wait {{seconds}} seconds before requesting another code.',
  },
  v2_otp_send_cap: {
    es: 'Pediste demasiados codigos. Intenta de nuevo mas tarde.',
    en: 'You requested too many codes. Please try again later.',
  },
  // Sprint 24 A3: the SMS itself could not be sent (Twilio rejected the
  // destination, e.g. error 21408 for an unenabled region). Names the
  // channel that failed, offers both recoveries the worker actually has,
  // and blames nothing on them. Unaccented ASCII like every other string in
  // this module -- a non-ASCII byte reaches Twilio as a GSM-7 escape and
  // silently re-segments the message.
  v2_otp_send_failed: {
    es: 'No pudimos enviarte el codigo por SMS a este numero. Intenta de nuevo en unos minutos o escribenos desde otro numero.',
    en: "We couldn't send your code by SMS to this number. Try again in a few minutes or message us from another number.",
  },
  v2_legal_prompt: {
    es: 'Antes de continuar, revisa nuestros Terminos ({{tos_url}}) y nuestro Aviso de Privacidad ({{privacy_url}}). Responde ACEPTAR para continuar, RECHAZAR para detenerte, o REVISAR TERMINOS para verlos otra vez.',
    en: 'Before we continue, please review our Terms ({{tos_url}}) and Privacy Policy ({{privacy_url}}). Reply ACCEPT to continue, DECLINE to stop, or REVIEW TERMS to see them again.',
  },
  v2_legal_declined: {
    es: 'Entendido. No podemos continuar sin tu aceptacion. Responde REVISAR TERMINOS cuando quieras verlos otra vez.',
    en: 'Understood. We cannot continue without your acceptance. Reply REVIEW TERMS whenever you want to see them again.',
  },
  v2_ask_name: {
    es: 'Como te llamas? Escribe tu nombre completo.',
    en: 'What is your name? Send your full name.',
  },
  v2_name_invalid: {
    es: 'Necesitamos un nombre de 2 a 100 caracteres. Intenta de nuevo.',
    en: 'We need a name between 2 and 100 characters. Please try again.',
  },
  v2_ask_location: {
    es: 'En que ciudad trabajas? Envia tu codigo postal o Ciudad, ST.',
    en: 'Where do you work? Send your ZIP code or City, ST.',
  },
  v2_location_invalid: {
    es: 'No reconocimos esa ubicacion. Envia un codigo postal de 5 digitos o Ciudad, ST.',
    en: 'We did not recognize that location. Send a 5-digit ZIP code or City, ST.',
  },
  v2_ask_trade: {
    es: 'Cual es tu oficio principal?',
    en: 'What is your main trade?',
  },
  v2_ask_custom_trade: {
    es: 'Cual es tu oficio? Escribelo en pocas palabras.',
    en: 'What is your trade? Describe it in a few words.',
  },
  v2_custom_trade_invalid: {
    es: 'Necesitamos el nombre de tu oficio. Intenta de nuevo.',
    en: 'We need the name of your trade. Please try again.',
  },
  v2_gate_blocked: {
    es: 'Primero terminemos tu registro. Responde a la pregunta de arriba para continuar.',
    en: 'Let us finish signing you up first. Answer the question above to continue.',
  },
  v2_restarted: {
    es: 'Listo, empezamos de nuevo. Vamos a repetir las preguntas de tu perfil.',
    en: 'Okay, starting over. Let\'s go through your profile questions again.',
  },
  v2_language_changed: {
    es: 'Listo, seguimos en espanol.',
    en: 'Done, we will continue in English.',
  },
  v2_ready: {
    es: 'Tu perfil esta listo. Te avisaremos cuando haya trabajo para ti.',
    en: 'Your profile is ready. We will let you know when there is work for you.',
  },
  v2_options_footer: {
    es: 'Responde con el numero.',
    en: 'Reply with the number.',
  },
  v2_voice_ack: {
    es: 'Recibimos tu nota de voz. Estamos transcribiendo tu respuesta.',
    en: 'Got your voice note. We are transcribing your answer now.',
  },
  v2_voice_failed: {
    es: 'No pudimos procesar esa nota de voz. Escribe tu respuesta o intenta grabar otra.',
    en: 'We could not process that voice note. Type your answer or try recording another.',
  },
  v2_voice_not_supported: {
    es: 'Notas de voz no estan disponibles en este paso todavia. Escribe tu respuesta.',
    en: 'Voice notes are not available at this step yet. Please type your answer.',
  },
  v2_voice_invalid_type: {
    es: 'Ese archivo no es una nota de voz. Manda un mensaje de voz o escribe tu respuesta.',
    en: 'That file is not a voice note. Send a voice message or type your answer.',
  },
  voice_note_not_supported: {
    es: 'Notas de voz no estan disponibles aqui. Escribe TRABAJOS o AYUDA.',
    en: 'Voice notes are not supported here. Type JOBS or HELP.',
  },
  v2_voice_send_note: {
    es: 'Cuando estes listo, manda tu nota de voz. Cuentanos tu nombre, ciudad, oficio, anos de experiencia, si tienes transporte propio, y tu disponibilidad.',
    en: 'Whenever you are ready, send your voice note. Tell us your name, city, trade, years of experience, whether you have your own transportation, and your availability.',
  },
  v2_voice_processing_ack: {
    es: 'Recibimos tu nota de voz. Estamos armando tu perfil...\n\nTe avisamos en un momento.',
    en: 'Got your voice note. We are building your profile...\n\nWe will let you know shortly.',
  },
  v2_voice_processing_wait: {
    es: 'Todavia estamos procesando tu nota de voz. Te avisamos en cuanto termine.',
    en: 'We are still processing your voice note. We will let you know as soon as it is done.',
  },
  v2_voice_summary: {
    es: 'Esto es lo que entendimos:\n\n{{summary}}',
    en: 'Here is what we understood:\n\n{{summary}}',
  },
  v2_voice_fallback: {
    es: 'No pudimos terminar de armar tu perfil con la nota de voz. Sigamos con unas preguntas rapidas.',
    en: 'We could not finish building your profile from the voice note. Let\'s continue with a few quick questions.',
  },
  v2_voice_retry_offer: {
    es: 'No pudimos procesar tu nota de voz. Intenta de nuevo con otra nota de voz, o escribe cualquier mensaje para continuar con preguntas rapidas.',
    en: 'We could not process your voice note. Try again with another voice note, or type any message to continue with quick questions.',
  },
  v2_location_confirm: {
    es: 'Te refieres a {{city}}, {{state}}?\n1. Si\n2. No\nResponde con 1 o 2.',
    en: 'Did you mean {{city}}, {{state}}?\n1. Yes\n2. No\nReply with 1 or 2.',
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
      // Use a replacer function, not a string, so the value is inserted
      // literally. A string replacement treats $&, $1, $` etc. inside the
      // VALUE as special patterns, which would silently corrupt any
      // model-produced text containing a literal `$` (e.g. the {{summary}}
      // slot below).
      s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), () => v);
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
