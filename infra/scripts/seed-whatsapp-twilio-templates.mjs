import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_ID = 'jale/whatsapp/twilio';
const REGION = process.env.AWS_REGION ?? 'us-east-2';
const CONTENT_API_URL = 'https://content.twilio.com/v1/Content';

const HELP_MENU_LIST_DEFINITIONS = {
  help_menu_list_en: {
    language: 'en',
    body: 'What would you like to do?',
    button: 'View commands',
    items: [
      { id: 'command:jobs', item: 'Jobs', description: 'See opportunities' },
      { id: 'command:applications', item: 'Applications', description: 'See your applications' },
      { id: 'command:profile', item: 'Profile', description: 'See your profile' },
      { id: 'command:chats', item: 'Chats', description: 'Open employer chats' },
      { id: 'command:help', item: 'Help', description: 'Show these commands' },
    ],
  },
  help_menu_list_es: {
    language: 'es',
    body: '¿Qué te gustaría hacer?',
    button: 'Ver comandos',
    items: [
      { id: 'command:jobs', item: 'Trabajos', description: 'Ver oportunidades' },
      { id: 'command:applications', item: 'Aplicaciones', description: 'Ver tus solicitudes' },
      { id: 'command:profile', item: 'Perfil', description: 'Ver tu perfil' },
      { id: 'command:chats', item: 'Chats', description: 'Abrir chats con empleadores' },
      { id: 'command:help', item: 'Ayuda', description: 'Ver estos comandos' },
    ],
  },
};

/**
 * Sprint 23 application-stage templates. Bodies are BYTE-IDENTICAL to the
 * fallback bodies `buildApplicationStageMessage`
 * (lambda/lib/application-stage-notify.ts) produces, with its variables in
 * place: {{1}} job title, {{2}} company, {{3}} `app-<uuid>`, {{4}} the
 * worker's stage-2 URL. If either side is edited, edit both -- the template
 * is what a WhatsApp user sees outside the 24h session window and the
 * fallback body is what they see inside it.
 *
 * Only the `application_update_*` pair carries buttons; `application_hired_*`
 * is informational and there is nothing to tap. The button ids embed {{3}},
 * so a tap arrives as `application:start:app-<uuid>` and is parsed by
 * `parseApplicationButtonPayload` (whatsapp/lib/flows.ts).
 */
const QUICK_REPLY_DEFINITIONS = {
  application_update_es: {
    language: 'es',
    body:
      'Actualizacion de aplicacion: {{2}} quiere avanzar con tu aplicacion para {{1}} y necesita algunos datos mas. '
      + 'Escribe "aplicaciones" para responder aqui, o usa {{4}} para responder cuando quieras.',
    example: ['Acabador de concreto', 'Rucoba & Maya', 'app-123e4567-e89b-12d3-a456-426614174000', 'https://jaleapp.ai/es/worker/applications/123e4567-e89b-12d3-a456-426614174000'],
    actions: [
      { title: 'Empezar', id: 'application:start:{{3}}' },
      { title: 'Despues', id: 'application:later:{{3}}' },
    ],
  },
  application_update_en: {
    language: 'en',
    body:
      'Application update: {{2}} wants to move forward with your application for {{1}} and needs a few more details. '
      + 'Reply "applications" to answer here, or use {{4}} to respond when ready.',
    example: ['Concrete Finisher', 'Rucoba & Maya', 'app-123e4567-e89b-12d3-a456-426614174000', 'https://jaleapp.ai/en/worker/applications/123e4567-e89b-12d3-a456-426614174000'],
    actions: [
      { title: 'Start answering', id: 'application:start:{{3}}' },
      { title: 'Later', id: 'application:later:{{3}}' },
    ],
  },
  application_hired_es: {
    language: 'es',
    body:
      'Buenas noticias: {{2}} te selecciono para {{1}}. '
      + 'Referencia: {{3}}. Consulta {{4}} para ver los detalles y proximos pasos.',
    example: ['Acabador de concreto', 'Rucoba & Maya', 'app-123e4567-e89b-12d3-a456-426614174000', 'https://jaleapp.ai/es/worker/applications/123e4567-e89b-12d3-a456-426614174000'],
    actions: [],
  },
  application_hired_en: {
    language: 'en',
    body:
      'Good news: {{2}} selected you for {{1}}. '
      + 'Reference: {{3}}. Use {{4}} to view details and next steps.',
    example: ['Concrete Finisher', 'Rucoba & Maya', 'app-123e4567-e89b-12d3-a456-426614174000', 'https://jaleapp.ai/en/worker/applications/123e4567-e89b-12d3-a456-426614174000'],
    actions: [],
  },
};

/**
 * Template names that must be RE-CREATED even when the secret already holds
 * a ContentSid for them. A Twilio Content resource is immutable, so a change
 * to a list's items (sprint 23 adds the Aplicaciones row) can only ship as a
 * new Content -- the skip-if-present rule the other definitions use would
 * silently keep serving the old menu forever.
 */
const FORCE_RECREATE = new Set(['help_menu_list_en', 'help_menu_list_es']);

const NEW_TEMPLATES = {
  onboarding_voice_choice_es: 'HXc5c30aac43f61d77aed3cb7578106947',
  onboarding_voice_choice_en: 'HX5722c3b606311e688308320f2c9bdc0c',
  onboarding_photo_type_es: 'HXaf78fd6b485523fcf96d739da5f78320',
  onboarding_photo_type_en: 'HX6e1f86a6032b876b5b1c9359adf8a080',
  onboarding_photo_skip_es: 'HX6534a7132d334a5ad03bde8142d6961e',
  onboarding_photo_skip_en: 'HXfc65b30cdada3cae815436b1f80b8ca5',
  onboarding_availability_es: 'HX07a3cb3d9a522a317bd0289c33457ee7',
  onboarding_availability_en: 'HX81a27a7572343576a46db4009f15cfc4',
  onboarding_experience_es: 'HX1ca983ca5d7975a122f9b26dbb27bac9',
  onboarding_experience_en: 'HXa85d15d0c553a72236886aa037da1501',
  onboarding_transportation_es: 'HX532e5cbbc7ea076b584a2ad05f9a283e',
  onboarding_transportation_en: 'HXd64cfab2b317e21c2461cd42b2983b6f',
  onboarding_trade_en: 'HX5de9da29c61f41a3580d8d4832cfad41',
  onboarding_trade_es: 'HXd2e03da923913d234e5a82d4949c8993',
  onboarding_legal_es: 'HX6e8f6ae97297c17176301919f705a840',
  onboarding_legal_en: 'HX30852732ef43c3c67d0901667f74b965',
  v2_onboarding_start_en: 'HX55261189f81c6e51e3bc34b8ffce68db',
  v2_onboarding_start_es: 'HX788ae14739642dd64a9e40c33dd41ea6',
  v2_onboarding_otp_en: 'HX8ae5ac4cb88606eb178a62ef25220910',
  v2_onboarding_otp_es: 'HX38aedd30576e64d518a1b2eede73cd2d',
  employer_message_invite_en: 'HXdb0d6516df17379835c8b669cf66e2c6',
  employer_message_invite_es: 'HX0c2d10546a96bfe3453e3b76f9432231',
  employer_message_resume_en: 'HXf6f08652c231c555ed7e755b77740672',
  employer_message_resume_es: 'HX2966e5a109ca7035f78aef898eda7db3',
};

function parseSecret(secretString) {
  try {
    return JSON.parse(secretString);
  } catch (err) {
    throw new Error(`Failed to parse Twilio secret JSON: ${err.message}`);
  }
}

function mergeTemplates(existing, additional) {
  const templates = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...NEW_TEMPLATES,
    ...additional,
  };
  return templates;
}

/**
 * Create a `twilio/list-picker` Content definition and return its ContentSid.
 * Used for templates that don't have a hardcoded SID because they aren't
 * pre-created in the Twilio console (unlike the quick-reply NEW_TEMPLATES
 * above, which were created manually via Content Template Builder).
 */
async function createListPickerContent(name, definition, accountSid, authToken) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(CONTENT_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      friendly_name: name,
      language: definition.language,
      types: {
        'twilio/list-picker': {
          body: definition.body,
          button: definition.button,
          items: definition.items,
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio Content API create failed for ${name}: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  if (!json.sid) {
    throw new Error(`Twilio Content API create for ${name} returned no sid`);
  }
  return json.sid;
}

/**
 * Create a `twilio/quick-reply` Content definition and return its ContentSid.
 * The sibling of `createListPickerContent` for the sprint-23 stage templates,
 * which (unlike the hardcoded NEW_TEMPLATES SIDs) are not pre-created in the
 * Twilio console. A definition with no `actions` is sent as a plain
 * `twilio/text` Content -- Twilio rejects a quick-reply with an empty button
 * list.
 */
async function createQuickReplyContent(name, definition, accountSid, authToken) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const types = definition.actions.length > 0
    ? {
        'twilio/quick-reply': {
          body: definition.body,
          actions: definition.actions.map((action) => ({
            type: 'QUICK_REPLY',
            title: action.title,
            id: action.id,
          })),
        },
      }
    : { 'twilio/text': { body: definition.body } };

  const res = await fetch(CONTENT_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    // Content API's top-level variable values are the WhatsApp approval
    // samples. Type-level `examples` is not a Content API field and is
    // discarded by Twilio before it reaches Meta.
    body: JSON.stringify({
      friendly_name: name,
      language: definition.language,
      variables: Object.fromEntries(definition.example.map((value, index) => [String(index + 1), value])),
      types,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio Content API create failed for ${name}: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  if (!json.sid) {
    throw new Error(`Twilio Content API create for ${name} returned no sid`);
  }
  return json.sid;
}

/**
 * WhatsApp approval for the sprint-23 application templates.
 *
 * Creating a Content resource is not enough: Meta must approve a template
 * before Twilio will send it OUTSIDE the 24-hour session window, which is
 * exactly when an employer-triggered stage notification arrives. Until then
 * the sender falls back to the plain body and Meta rejects it -- nothing
 * reaches the worker. So every application_* template is submitted for
 * approval here, once: a template whose approval status is anything other than
 * `unsubmitted` (received / pending / approved / rejected / paused / disabled)
 * is left alone and only reported.
 *
 * Category is UTILITY for all four: they are transactional updates about an
 * application the worker already made. The help-menu list pickers are session
 * messages (always inside the window) and need no approval.
 */
const WHATSAPP_APPROVAL_CATEGORY = 'UTILITY';

function twilioAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

async function whatsappApprovalStatus(sid, accountSid, authToken) {
  const res = await fetch(`${CONTENT_API_URL}/${sid}/ApprovalRequests`, {
    headers: { Authorization: twilioAuthHeader(accountSid, authToken) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio approval status read failed for ${sid}: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  return json?.whatsapp?.status ?? 'unsubmitted';
}

async function requestWhatsAppApproval(sid, name, accountSid, authToken) {
  const res = await fetch(`${CONTENT_API_URL}/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: {
      Authorization: twilioAuthHeader(accountSid, authToken),
      'Content-Type': 'application/json',
    },
    // `name` must be lowercase letters, digits and underscores -- every
    // application_* key already is.
    body: JSON.stringify({ name, category: WHATSAPP_APPROVAL_CATEGORY }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio approval request failed for ${name} (${sid}): HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  return json?.status ?? 'received';
}

/**
 * Submit every application_* template that has never been submitted; report
 * the WhatsApp approval status of all of them. Returns `{ name: status }`.
 */
async function ensureWhatsAppApprovals(templates, accountSid, authToken) {
  const report = {};
  for (const name of Object.keys(QUICK_REPLY_DEFINITIONS)) {
    const sid = templates?.[name];
    if (!sid) continue;
    let status = await whatsappApprovalStatus(sid, accountSid, authToken);
    if (status === 'unsubmitted') {
      status = await requestWhatsAppApproval(sid, name, accountSid, authToken);
    }
    report[name] = status;
  }
  return report;
}

async function createMissingListPickerTemplates(existingTemplates, accountSid, authToken) {
  const created = {};
  for (const [name, definition] of Object.entries(HELP_MENU_LIST_DEFINITIONS)) {
    // FORCE_RECREATE: a Content resource is immutable, so a changed item list
    // has to become a new one even though a SID is already stored.
    if (existingTemplates?.[name] && !FORCE_RECREATE.has(name)) continue;
    created[name] = await createListPickerContent(name, definition, accountSid, authToken);
  }
  return created;
}

async function createMissingQuickReplyTemplates(existingTemplates, accountSid, authToken) {
  const created = {};
  for (const [name, definition] of Object.entries(QUICK_REPLY_DEFINITIONS)) {
    const existingSid = existingTemplates?.[name];
    // Meta cannot approve a variable-bearing template without a sample body
    // example. Recreate a previously rejected immutable Content resource so
    // this corrected definition can be submitted under the same template name.
    if (existingSid && !FORCE_RECREATE.has(name)) {
      const status = await whatsappApprovalStatus(existingSid, accountSid, authToken);
      if (status !== 'rejected') continue;
    }
    created[name] = await createQuickReplyContent(name, definition, accountSid, authToken);
  }
  return created;
}

async function main() {
  const client = new SecretsManagerClient({ region: REGION });

  const current = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!current.SecretString) {
    throw new Error(`Secret ${SECRET_ID} is empty`);
  }

  const secret = parseSecret(current.SecretString);

  const createdListPickers = await createMissingListPickerTemplates(
    secret.templates,
    secret.accountSid,
    secret.authToken,
  );
  const createdQuickReplies = await createMissingQuickReplyTemplates(
    secret.templates,
    secret.accountSid,
    secret.authToken,
  );
  const createdContent = { ...createdListPickers, ...createdQuickReplies };
  const expectedTemplates = { ...NEW_TEMPLATES, ...createdContent };

  const templates = mergeTemplates(secret.templates, createdContent);
  const nextSecret = { ...secret, templates };

  const verifyBeforeWrite = Object.fromEntries(
    Object.entries(expectedTemplates).filter(([key, value]) => templates[key] !== value),
  );
  if (Object.keys(verifyBeforeWrite).length > 0) {
    throw new Error(`Template merge failed before write: ${Object.keys(verifyBeforeWrite).join(', ')}`);
  }

  const nextSecretString = JSON.stringify(nextSecret);
  if (nextSecretString !== current.SecretString) {
    await client.send(
      new UpdateSecretCommand({
        SecretId: SECRET_ID,
        SecretString: nextSecretString,
      }),
    );
  }

  const verified = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const verifiedSecret = parseSecret(verified.SecretString ?? '{}');
  const missing = Object.entries(expectedTemplates)
    .filter(([key, value]) => verifiedSecret.templates?.[key] !== value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Secret update did not persist these template keys: ${missing.join(', ')}`);
  }

  const templateCount = Object.keys(verifiedSecret.templates ?? {}).length;
  console.log(`Updated ${SECRET_ID} in ${REGION}; verified ${Object.keys(expectedTemplates).length} onboarding SIDs and ${templateCount} total template entries.`);
  if (Object.keys(createdListPickers).length > 0) {
    console.log(`Created list-picker Content templates: ${Object.keys(createdListPickers).join(', ')}`);
  }
  if (Object.keys(createdQuickReplies).length > 0) {
    console.log(`Created quick-reply Content templates: ${Object.keys(createdQuickReplies).join(', ')}`);
  }

  const approvals = await ensureWhatsAppApprovals(
    verifiedSecret.templates,
    secret.accountSid,
    secret.authToken,
  );
  for (const [name, status] of Object.entries(approvals)) {
    console.log(`WhatsApp approval ${name}: ${status}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
