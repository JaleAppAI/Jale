/**
 * Bilingual (EN/ES) worker-facing copy for the WhatsApp application-fill
 * flow -- the bot conversation that collects a job's `required_fields`
 * answers (see `../../lib/application-answers.ts` for the per-key answer
 * shapes) and `required_docs` uploads after a worker accepts a job.
 *
 * This is the single home for that copy. Later tasks (the fill-flow state
 * machine and its handlers) import `fieldQuestion`, `fieldRetryHint`,
 * `docPrompt`, and `fillMessage` by name -- do not duplicate this copy
 * elsewhere.
 *
 * Style, matching `./templates.ts`: Spanish uses informal "tu" (never
 * "usted"), no accents and no inverted punctuation (the WhatsApp keyboards
 * this audience uses often drop/mangle them), and numbered-option prompts
 * end with a "Responde con 1 o 2." (etc.) footer, one option per line.
 */

import { REQUIRED_FIELD_TYPES, DOC_TYPES } from '../../lib/job-fields';
import { Lang } from './templates';

export type FillFieldKey = (typeof REQUIRED_FIELD_TYPES)[number];
// 'ssn' is excluded by DOC_TYPES itself (see job-fields.ts) -- no new
// upload or job requirement may select it.
export type CollectableDocType = (typeof DOC_TYPES)[number];

export type FillMessageKey =
  | 'intro'
  | 'confirm_footer'
  | 'entry_another'
  | 'completion'
  | 'canceled'
  | 'doc_invalid_type'
  | 'doc_too_large'
  | 'doc_take_first'
  | 'doc_step_media_pending'
  | 'field_step_media'
  | 'cert_cap'
  | 'extraction_failed'
  | 'answer_too_long'
  | 'doc_download_failed'
  | 'web_handoff'
  | 'switched_job'
  | 'continue_other'
  | 'exit_job_inactive'
  | 'exit_application_gone'
  | 'exit_application_closed'
  // Sprint 23: the fill lane's stage gate. NOT terminal -- the employer
  // simply has not asked for details yet.
  | 'exit_details_not_requested'
  | 'guard_error'
  | 'reconfirm'
  // Sprint 23 prompt lane (application-prompts.ts). Kept in THIS module,
  // not templates.ts, because the prompt lane is part of the application
  // flow and reuses `fillMessage`'s `{{var}}` substitution.
  | 'prompt_ask'
  | 'prompt_text_only'
  | 'prompt_too_long'
  | 'prompt_canceled'
  // Sprint 24 L3 -- the reuse-transparency lane. The 2026-09-04 incident was
  // invisible to the worker: profile answers were reused and a vault
  // document was attached with nothing said, and the fill then completed in
  // the same turn. These six keys are what the worker now sees instead.
  | 'intro_profile_check'
  | 'reuse_fields_line'
  | 'reuse_docs_line'
  | 'reuse_change_footer'
  | 'confirm_all_prefilled'
  | 'change_menu_header'
  | 'change_menu_invalid'
  | 'change_nothing';

interface Bilingual {
  en: string;
  es: string;
}

// ── Field questions & retry hints ──────────────────────────────────────
//
// Each question is written against the per-key validator shape in
// application-answers.ts (FIELD_VALIDATORS) so the accepted answer format
// actually matches what the worker is asked for. Array-key fields
// (work_history, references) ask for ONE entry per turn, not the whole
// list -- the state machine loops the question via 'entry_another'.

const FIELD_QUESTIONS: Record<FillFieldKey, Bilingual> = {
  work_authorization: {
    en: 'Are you authorized to work in the United States?\n\n1. Yes\n2. No\n\nReply with 1 or 2.',
    es: 'Estas autorizado para trabajar en Estados Unidos?\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
  },
  date_available: {
    en: 'What date can you start working? Reply like this: 2026-09-01 (year-month-day).',
    es: 'En que fecha puedes empezar a trabajar? Responde asi: 2026-09-01 (AAAA-MM-DD).',
  },
  desired_pay: {
    en: 'What pay are you looking for? Reply with an amount and how often you want to be paid: hourly, daily, weekly, monthly, or a fixed amount. For example: 25 an hour.',
    es: 'Cual es el pago que buscas? Responde con una cantidad y con que frecuencia: por hora, por dia, por semana, por mes, o un pago fijo. Por ejemplo: 25 por hora.',
  },
  home_address: {
    en: 'What is your home address? Reply with street, city, state, and zip code, like this: 123 Main St, Springfield, IL 62704.',
    es: 'Cual es tu direccion de casa? Responde con calle, ciudad, estado y codigo postal, asi: 123 Main St, Springfield, IL 62704.',
  },
  date_of_birth: {
    en: 'What is your date of birth? Reply like this: 1990-04-03 (year-month-day).',
    es: 'Cual es tu fecha de nacimiento? Responde asi: 1990-04-03 (AAAA-MM-DD).',
  },
  emergency_contact: {
    en: 'Who is your emergency contact? Reply with their name and phone number, like this: Maria Lopez, 555-123-4567.',
    es: 'Quien es tu contacto de emergencia? Responde con su nombre y numero de telefono, asi: Maria Lopez, 555-123-4567.',
  },
  worked_here_before: {
    en: 'Have you worked here before?\n\n1. Yes\n2. No\n\nReply with 1 or 2. If yes, you can also tell us when.',
    es: 'Has trabajado aqui antes?\n\n1. Si\n2. No\n\nResponde con 1 o 2. Si dijiste que si, tambien puedes decirnos cuando.',
  },
  education: {
    en: 'What is your highest level of education?\n\n1. None\n2. Primary school\n3. High school\n4. GED\n5. Some college\n6. College degree\n7. Trade school\n\nReply with 1, 2, 3, 4, 5, 6, or 7.',
    es: 'Cual es tu nivel de educacion mas alto?\n\n1. Ninguno\n2. Primaria\n3. Preparatoria\n4. GED\n5. Universidad incompleta\n6. Universidad completa\n7. Escuela tecnica\n\nResponde con 1, 2, 3, 4, 5, 6 o 7.',
  },
  references: {
    en: 'Give me one work reference: their name, relationship to you, and phone number, like this: Juan Perez, former supervisor, 555-123-4567.',
    es: 'Dame una referencia de trabajo: su nombre, su relacion contigo y su numero de telefono, asi: Juan Perez, supervisor anterior, 555-123-4567.',
  },
  work_history: {
    en: 'Tell me about your most recent job: company and job title (dates and duties help too, but are optional).',
    es: 'Cuentame de tu trabajo mas reciente: empresa y puesto (fechas y tareas ayudan, pero son opcionales).',
  },
  military_service: {
    en: 'Have you served in the military?\n\n1. Yes\n2. No\n\nReply with 1 or 2.',
    es: 'Has servido en las fuerzas armadas?\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
  },
};

// ── Field LABELS (sprint 24 L3) ─────────────────────────────────────────
//
// SHORT noun phrases, for naming a field in a list rather than asking it:
// the `reuse_fields_line` summary ("De tu perfil usamos: ...") and the
// numbered CAMBIAR menu. FIELD_QUESTIONS above cannot serve -- those are
// full questions, several of them multi-line with a numbered footer.
//
// DEVIATION FROM THE L3 BRIEF, recorded deliberately: the brief said to
// reuse an existing bilingual field-label map. There is none on the lambda
// side (only these questions and their retry hints). The canonical short
// labels live in the FRONTEND message catalogs
// (frontend/src/messages/{en,es}.json -> job_requirements.fields), so these
// are derived from those rather than invented -- re-worded only where this
// module's own conventions require it: no accents, no question marks, and
// tu rather than the web copy's impersonal/usted phrasing ("Si trabajaste
// aqui antes", not "Ha trabajado aqui antes?"). Keep the two in sync by
// hand; nothing enforces it, exactly like REQUIRED_FIELD_TYPES and its
// 073 CHECK.
const FIELD_LABELS: Record<FillFieldKey, Bilingual> = {
  work_authorization: { en: 'Work authorization', es: 'Autorizacion de trabajo' },
  date_available: { en: 'Date available', es: 'Fecha de disponibilidad' },
  desired_pay: { en: 'Desired pay', es: 'Pago deseado' },
  home_address: { en: 'Home address', es: 'Direccion de casa' },
  date_of_birth: { en: 'Date of birth', es: 'Fecha de nacimiento' },
  emergency_contact: { en: 'Emergency contact', es: 'Contacto de emergencia' },
  worked_here_before: { en: 'Worked here before', es: 'Si trabajaste aqui antes' },
  education: { en: 'Education', es: 'Educacion' },
  references: { en: 'References', es: 'Referencias' },
  work_history: { en: 'Work history', es: 'Historial de trabajo' },
  military_service: { en: 'Military service', es: 'Servicio militar' },
};

// Each hint names the problem before repeating the accepted format, per the
// house convention (full-sentence errors: problem + accepted format + next
// action -- see FILL_MESSAGES.doc_invalid_type for the model this follows).
const FIELD_RETRY_HINTS: Record<FillFieldKey, Bilingual> = {
  work_authorization: {
    en: "That's not a valid answer. Reply with 1 for Yes or 2 for No.",
    es: 'Esa no es una respuesta valida. Responde con 1 para Si o 2 para No.',
  },
  date_available: {
    en: "That's not a valid date. Use the format YYYY-MM-DD, for example 2026-09-01.",
    es: 'Esa no es una fecha valida. Usa el formato AAAA-MM-DD, por ejemplo 2026-09-01.',
  },
  desired_pay: {
    en: "That's not a valid amount. Include a number and how often (hourly, daily, weekly, monthly, or fixed), for example: 25 an hour.",
    es: 'Eso no es un pago valido. Incluye un numero y la frecuencia (por hora, por dia, por semana, por mes o fijo), por ejemplo: 25 por hora.',
  },
  home_address: {
    en: "That's not a valid address. Include street, city, the 2-letter state abbreviation, and a 5-digit zip code, like: 123 Main St, Springfield, IL 62704.",
    es: 'Esa no es una direccion valida. Incluye calle, ciudad, la abreviatura del estado de 2 letras y un codigo postal de 5 digitos, como: 123 Main St, Springfield, IL 62704.',
  },
  date_of_birth: {
    en: "That's not a valid date of birth. Use the format YYYY-MM-DD, for example 1990-04-03. It must be a real date, not in the future, and after 1906.",
    es: 'Esa no es una fecha de nacimiento valida. Usa el formato AAAA-MM-DD, por ejemplo 1990-04-03. Debe ser una fecha real, no en el futuro y despues de 1906.',
  },
  emergency_contact: {
    en: "That's not a valid answer. Include both a name and a phone number (7 to 20 digits), like: Maria Lopez, 555-123-4567.",
    es: 'Esa no es una respuesta valida. Incluye un nombre y un numero de telefono (7 a 20 digitos), como: Maria Lopez, 555-123-4567.',
  },
  worked_here_before: {
    en: "That's not a valid answer. Reply with 1 for Yes or 2 for No.",
    es: 'Esa no es una respuesta valida. Responde con 1 para Si o 2 para No.',
  },
  education: {
    en: "That's not a valid answer. Reply with a number from 1 to 7 for your education level.",
    es: 'Esa no es una respuesta valida. Responde con un numero del 1 al 7 para tu nivel de educacion.',
  },
  references: {
    en: "That's not a valid reference. Include a name, a relationship (like coworker or supervisor), and a phone number, like: Juan Perez, former supervisor, 555-123-4567.",
    es: 'Esa no es una referencia valida. Incluye un nombre, una relacion (como companero o supervisor) y un numero de telefono, como: Juan Perez, supervisor anterior, 555-123-4567.',
  },
  work_history: {
    en: "That's not a valid answer. Include at least a company name and job title, like: ABC Construction, Carpenter.",
    es: 'Esa no es una respuesta valida. Incluye al menos el nombre de la empresa y el puesto, como: Construccion ABC, Carpintero.',
  },
  military_service: {
    en: "That's not a valid answer. Reply with 1 for Yes or 2 for No.",
    es: 'Esa no es una respuesta valida. Responde con 1 para Si o 2 para No.',
  },
};

// ── Document prompts ─────────────────────────────────────────────────────

const DOC_PROMPTS: Record<CollectableDocType, Bilingual> = {
  resume: {
    en: 'Send your resume. You can upload a photo (JPG or PNG) or a PDF file, up to 10MB.',
    es: 'Manda tu curriculum. Puedes subir una foto (JPG o PNG) o un archivo PDF, hasta 10MB.',
  },
  driver_license: {
    en: "Send a photo of your driver's license (front side). Photo in JPG or PNG, or a PDF, up to 10MB.",
    es: 'Manda una foto de tu licencia de conducir (el lado de enfrente). Foto en JPG o PNG, o un PDF, hasta 10MB.',
  },
  work_auth_doc: {
    en: 'Send your work authorization document (like a permit or visa). Photo in JPG or PNG, or a PDF, up to 10MB.',
    es: 'Manda tu documento de autorizacion de trabajo (como un permiso o visa). Foto en JPG o PNG, o un PDF, hasta 10MB.',
  },
  certification_doc: {
    en: 'Send your certification document. Photo in JPG or PNG, or a PDF, up to 10MB. You can send up to 5 certifications.',
    es: 'Manda tu documento de certificacion. Foto en JPG o PNG, o un PDF, hasta 10MB. Puedes mandar hasta 5 certificaciones.',
  },
};

// ── Flow-level messages ──────────────────────────────────────────────────

const FILL_MESSAGES: Record<FillMessageKey, Bilingual> = {
  // Sprint 23: this intro is now sent ONLY at the stage-2 arm (armFill), so
  // it names the employer who asked -- the worker may have several open
  // applications and needs to know which one this is.
  intro: {
    en: "{{company}} wants to move forward with your application and needs a few details. There are {{n_fields}} questions and {{n_docs}} documents left. Let's start:",
    es: '{{company}} quiere avanzar con tu aplicacion y necesita algunos datos. Faltan {{n_fields}} preguntas y {{n_docs}} documentos. Empezamos:',
  },
  confirm_footer: {
    en: '1. Yes\n2. No\nReply with 1 or 2.',
    es: '1. Si\n2. No\nResponde con 1 o 2.',
  },
  entry_another: {
    en: 'Do you want to add another one?\n\n1. Yes\n2. No\n\nReply with 1 or 2.',
    es: 'Quieres agregar otro?\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
  },
  completion: {
    en: 'Done, we sent your details to {{company}}. We will let you know when there is news.',
    es: 'Listo, enviamos tus datos a {{company}}. Te avisaremos cuando haya novedades.',
  },
  // spec 6.2: canceling the fill flow does NOT promise the website -- the
  // only way back in is re-accepting the job. Tu-preterite ("cancelaste"),
  // matching completaste/cambiaste elsewhere in this file -- the brief's
  // sample copy used the usted-imperative "cancele", which contradicts the
  // file's own tu convention (review ruling: the binding convention
  // governs over the brief's sample text).
  canceled: {
    en: 'Done, I canceled the form. Reply "applications" when you want to continue.',
    es: 'Listo, cancelaste el formulario. Escribe "aplicaciones" cuando quieras continuar.',
  },
  doc_invalid_type: {
    en: 'That file is not a valid format. Please send a photo in JPG or PNG, or a PDF file.',
    es: 'Ese archivo no es un formato valido. Manda una foto en JPG o PNG, o un archivo PDF.',
  },
  doc_too_large: {
    en: 'That file is too large. The limit is 10MB. Please send a smaller file.',
    es: 'Ese archivo es muy grande. El limite es 10MB. Manda un archivo mas pequeno.',
  },
  doc_take_first: {
    en: 'We received multiple files. We only use the first one. If you need to send another document, send it separately.',
    es: 'Recibimos varios archivos. Solo usamos el primero. Si necesitas mandar otro documento, hazlo por separado.',
  },
  doc_step_media_pending: {
    en: 'We are waiting for the document. Send a photo or a PDF to continue.',
    es: 'Estamos esperando el documento. Manda una foto o un PDF para continuar.',
  },
  field_step_media: {
    en: 'At this step we need your answer in text. Please type your answer to continue.',
    es: 'En este paso necesitamos tu respuesta en texto. Escribe tu respuesta para continuar.',
  },
  cert_cap: {
    en: 'You have reached the limit of 5 certifications. We cannot save more files in this category.',
    es: 'Ya llegaste al limite de 5 certificaciones. No podemos guardar mas archivos en esta categoria.',
  },
  extraction_failed: {
    en: "We could not read the information from that file. Let's continue with the next question.",
    es: 'No pudimos leer la informacion de ese archivo. Vamos a continuar con la siguiente pregunta.',
  },
  answer_too_long: {
    en: 'Your answer is too long. Please write a shorter answer and try again.',
    es: 'Tu respuesta es muy larga. Escribe una respuesta mas corta e intenta de nuevo.',
  },
  doc_download_failed: {
    en: 'We could not download that file. Please try sending it again.',
    es: 'No pudimos descargar ese archivo. Intenta mandarlo de nuevo.',
  },
  // The document can only be finished with the employer or on the website
  // -- unlike 'canceled', this key legitimately points at the website
  // because it names a specific document the WhatsApp flow cannot collect.
  web_handoff: {
    en: 'The {{doc}} document can only be completed with the employer or on the website: {{url}}',
    es: 'El documento {{doc}} solo se puede completar con el empleador o en el sitio web: {{url}}',
  },
  switched_job: {
    en: "You switched to a different job application. Let's continue with the questions for this new job.",
    es: 'Cambiaste a otra aplicacion de trabajo. Seguimos con las preguntas de este nuevo empleo.',
  },
  continue_other: {
    en: 'You have another unfinished application for {{job_title}}. Do you want to continue it?\n\n1. Yes\n2. No\n\nReply with 1 or 2.',
    es: 'Tienes otra aplicacion sin terminar para {{job_title}}. Quieres continuarla?\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
  },
  exit_job_inactive: {
    en: 'This job is no longer active. We cannot continue with your application.',
    es: 'Este empleo ya no esta activo. No podemos seguir con tu aplicacion.',
  },
  exit_application_gone: {
    en: 'Your application no longer exists. If you would like, apply to the job again.',
    es: 'Tu aplicacion ya no existe. Si quieres, aplica de nuevo al empleo.',
  },
  exit_application_closed: {
    en: 'Your application is already closed. The employer has already made a decision.',
    es: 'Tu aplicacion ya esta cerrada. El empleador ya tomo una decision.',
  },
  guard_error: {
    en: 'Something went wrong with your application. Please try again in a few minutes.',
    es: 'Algo salio mal con tu aplicacion. Intenta de nuevo en unos minutos.',
  },
  reconfirm: {
    en: "Are you still there? Let's confirm your last answer.\n\n1. Yes\n2. No\n\nReply with 1 or 2.",
    es: 'Sigues ahi? Confirmamos tu ultima respuesta.\n\n1. Si\n2. No\n\nResponde con 1 o 2.',
  },
  exit_details_not_requested: {
    en: 'We have not asked you for extra details on this application yet. We will let you know here when the employer asks. Reply "applications" to see your applications.',
    es: 'Todavia no te pedimos datos adicionales para esta aplicacion. Te avisaremos aqui cuando el empleador los pida. Escribe "aplicaciones" para ver tus solicitudes.',
  },
  prompt_ask: {
    en: 'Question {{i}} of {{n}}: {{text}}',
    es: 'Pregunta {{i}} de {{n}}: {{text}}',
  },
  prompt_text_only: {
    en: 'For this question we need your answer in text. Type your answer to continue.',
    es: 'Para esta pregunta necesitamos tu respuesta en texto. Escribe tu respuesta para continuar.',
  },
  prompt_too_long: {
    en: 'Your answer is too long. The limit is 1000 characters. Please write a shorter answer.',
    es: 'Tu respuesta es muy larga. El limite es 1000 caracteres. Escribe una respuesta mas corta.',
  },
  prompt_canceled: {
    en: 'Done, we will leave the questions for now. Your application is still sent. Reply "applications" when you want to continue.',
    es: 'Listo, dejamos las preguntas por ahora. Tu aplicacion sigue enviada. Escribe "aplicaciones" cuando quieras continuar.',
  },
  // Sprint 24 L3, transparency decision: sent BEFORE anything is reused, so
  // the worker knows a profile lookup is about to happen rather than being
  // handed a fait accompli.
  intro_profile_check: {
    en: "First I'll check your profile for details we already have, then ask only what's missing.",
    es: 'Primero reviso tu perfil para usar los datos que ya tenemos y solo te pregunto lo que falta.',
  },
  // Three separate keys, not one paragraph: a job may reuse fields with no
  // documents, or attach a document with no reused fields, and a summary
  // that says "Documentos adjuntados de tu boveda: ." is worse than saying
  // nothing. `armFill` composes whichever lines apply and always ends with
  // the footer, so the way out is never missing.
  reuse_fields_line: {
    en: 'From your profile we used: {{labels}}.',
    es: 'De tu perfil usamos: {{labels}}.',
  },
  // "boveda" without the accent, like every other es string in this module
  // (see the style note in the header) -- the label list substituted into
  // {{docLabels}} comes from `localizeDocList` and DOES carry accents, so
  // this one line can read mixed. Deliberate: those labels are already sent
  // accented by the `web_handoff` note this lane and processor.ts share, and
  // re-spelling them here would fork copy other lanes send.
  reuse_docs_line: {
    en: 'Documents attached from your vault: {{docLabels}}.',
    es: 'Documentos adjuntados de tu boveda: {{docLabels}}.',
  },
  reuse_change_footer: {
    en: 'Reply CHANGE if you want to fix any of them.',
    es: 'Responde CAMBIAR si quieres corregir alguno.',
  },
  // THE FIX for the incident's last step: with everything pre-filled the
  // flow used to report "0 questions and 0 documents" and fire the
  // completion message in the SAME turn, so the worker's details went to the
  // employer without them ever answering, reviewing or agreeing to
  // anything. Now nothing is sent until they say LISTO/DONE.
  confirm_all_prefilled: {
    en: 'We already have everything we need. Reply DONE to send your application, or CHANGE to fix something.',
    es: 'Ya tenemos todo lo necesario. Responde LISTO para enviar tu solicitud o CAMBIAR para corregir algo.',
  },
  change_menu_header: {
    en: 'Here is what we used from your profile. Reply with the number of what you want to fix:',
    es: 'Esto es lo que usamos de tu perfil. Responde con el numero de lo que quieres corregir:',
  },
  change_menu_invalid: {
    en: 'That number is not on the list. Reply with one of the numbers on the list.',
    es: 'Ese numero no esta en la lista. Responde con uno de los numeros de la lista.',
  },
  change_nothing: {
    en: 'We did not use anything from your profile on this application, so there is nothing to fix here.',
    es: 'No usamos ningun dato de tu perfil en esta solicitud, asi que no hay nada que corregir aqui.',
  },
};

/** Substitute `{{name}}` placeholders. Copies the `$`-safe approach in
 * `./templates.ts`'s `t()`: a replacer function, not a string, so a
 * literal `$` in the substituted value is never treated as a special
 * pattern ($&, $1, $\`, ...). */
function substitute(s: string, vars?: Record<string, string>): string {
  if (!vars) return s;
  let out = s;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), () => v);
  }
  return out;
}

export function fieldQuestion(key: FillFieldKey, lang: Lang): string {
  return FIELD_QUESTIONS[key][lang];
}

export function fieldRetryHint(key: FillFieldKey, lang: Lang): string {
  return FIELD_RETRY_HINTS[key][lang];
}

/** Short noun-phrase name for a field -- for the reuse summary and the
 * numbered CAMBIAR menu, never for asking (see FIELD_LABELS). */
export function fieldLabel(key: FillFieldKey, lang: Lang): string {
  return FIELD_LABELS[key][lang];
}

export function docPrompt(docType: CollectableDocType, lang: Lang): string {
  return DOC_PROMPTS[docType][lang];
}

export function fillMessage(key: FillMessageKey, lang: Lang, vars?: Record<string, string>): string {
  return substitute(FILL_MESSAGES[key][lang], vars);
}
