import type { ProfileField } from './flows';
import { t, type Lang } from './templates';

export interface InteractivePrompt {
  templateName: string;
  variables: Record<string, string>;
  fallbackBody: string;
}

const PROFILE_PROMPT_TEMPLATE: Partial<Record<ProfileField, { en: string; es: string }>> = {
  main_trade: {
    en: 'onboarding_trade_en',
    es: 'onboarding_trade_es',
  },
  years_experience: {
    en: 'onboarding_experience_en',
    es: 'onboarding_experience_es',
  },
  has_transportation: {
    en: 'onboarding_transportation_en',
    es: 'onboarding_transportation_es',
  },
  availability: {
    en: 'onboarding_availability_en',
    es: 'onboarding_availability_es',
  },
};

const PROFILE_PROMPT_KEY: Partial<Record<ProfileField, Parameters<typeof t>[0]>> = {
  main_trade: 'ask_trade',
  years_experience: 'ask_experience',
  has_transportation: 'ask_transportation',
  availability: 'ask_availability',
};

export function buildLegalInteractivePrompt(lang: Lang, tosUrl: string): InteractivePrompt {
  return {
    templateName: `onboarding_legal_${lang}`,
    variables: { '1': tosUrl },
    fallbackBody: t('legal_prompt', lang, { tos_url: tosUrl }),
  };
}

export function buildProfileInteractivePrompt(
  field: ProfileField,
  lang: Lang,
): InteractivePrompt | null {
  const templateName = PROFILE_PROMPT_TEMPLATE[field]?.[lang];
  const promptKey = PROFILE_PROMPT_KEY[field];
  if (!templateName || !promptKey) return null;

  return {
    templateName,
    variables: {},
    fallbackBody: t(promptKey, lang),
  };
}

export type MediaInteractivePrompt = 'photo_skip' | 'photo_type' | 'voice_choice';

const MEDIA_PROMPT_TEMPLATE: Record<MediaInteractivePrompt, { en: string; es: string }> = {
  photo_skip: {
    en: 'onboarding_photo_skip_en',
    es: 'onboarding_photo_skip_es',
  },
  photo_type: {
    en: 'onboarding_photo_type_en',
    es: 'onboarding_photo_type_es',
  },
  voice_choice: {
    en: 'onboarding_voice_choice_en',
    es: 'onboarding_voice_choice_es',
  },
};

const MEDIA_FALLBACK_KEY: Record<MediaInteractivePrompt, Parameters<typeof t>[0]> = {
  photo_skip: 'ask_media_photo',
  photo_type: 'ask_media_photo_type',
  voice_choice: 'ask_media_voice',
};

export function buildMediaInteractivePrompt(
  prompt: MediaInteractivePrompt,
  lang: Lang,
): InteractivePrompt {
  return {
    templateName: MEDIA_PROMPT_TEMPLATE[prompt][lang],
    variables: {},
    fallbackBody: t(MEDIA_FALLBACK_KEY[prompt], lang),
  };
}

export function buildHelpMenuInteractivePrompt(lang: Lang): InteractivePrompt {
  return {
    templateName: lang === 'es' ? 'help_menu_list_es' : 'help_menu_list_en',
    variables: {},
    fallbackBody: t('help_menu', lang),
  };
}

// ── V2 workflow builders (additive; legacy builders above are unchanged) ──

/**
 * Reviewed bilingual fallback set used when the question generator fails.
 *
 * Sprint 22 R1-A: Q1 used to ask how many years the worker had been in the
 * trade — a duplicate of `users.years_experience`, already collected at
 * `profile.experience`, and a one-word answer the AI scorer cannot grade. It
 * is now a broad, trade-agnostic OPEN question about the work itself. ASCII
 * only on both sides, matching every other string in this module.
 */
export const V2_FALLBACK_TRUST_QUESTIONS: ReadonlyArray<{ en: string; es: string }> = [
  {
    en: 'What do you actually do on a typical day in your trade? Tell us about the work itself.',
    es: 'Que haces realmente en un dia tipico en tu oficio? Cuentanos del trabajo en si.',
  },
  {
    en: 'What tools or equipment do you bring to a job?',
    es: 'Que herramientas o equipo llevas a un trabajo?',
  },
  {
    en: 'Describe a job you finished that you are proud of.',
    es: 'Describe un trabajo que terminaste y del que estas orgulloso.',
  },
];

export function buildV2StartInvitationPrompt(lang: Lang): InteractivePrompt {
  return {
    templateName: `v2_onboarding_start_${lang}`,
    variables: {},
    fallbackBody: t('v2_start_invitation', lang),
  };
}

/**
 * One variable: `{{1}}` is the expiry in minutes. The resend button's payload
 * (`otp:resend`, matched verbatim in handleOtpStep) and its label are static
 * per-language properties of the approved template, not variables — there is a
 * separate template per language, so nothing about the button varies at send
 * time. Keeping the count at one is what makes `v2_onboarding_otp_*` safe to
 * register: a registered template invoked with the wrong variable count is a
 * Twilio 400, and outbox.ts's `__fallback_body` rescue only covers a MISSING
 * ContentSid, so it cannot save a rejected payload.
 */
export function buildV2OtpPrompt(lang: Lang, minutes: string): InteractivePrompt {
  return {
    templateName: `v2_onboarding_otp_${lang}`,
    variables: { '1': minutes },
    fallbackBody: t('v2_otp_sent', lang, { minutes }),
  };
}

/**
 * Reuses V1's registered `onboarding_legal_*` template rather than the
 * never-registered `v2_onboarding_legal_*`. v2 is a backend refactor, so the
 * worker sees the same approved legal prompt V1 has always sent.
 *
 * The variable shape is V1's contract, not a choice: `buildLegalInteractivePrompt`
 * sends exactly one variable (the ToS URL), and a registered template invoked
 * with the wrong variable count is a Twilio 400 that `__fallback_body` does NOT
 * rescue (outbox.ts only falls back when the ContentSid is absent). The three
 * button payloads v2 used to pass as variables are baked into the approved
 * template — and it emits `legal:accept`/`legal:decline`, exactly what
 * `handleLegalStep` already parses (see parseLegalReplyPayload, flows.ts).
 *
 * `privacyUrl` survives only in the plain-text fallback: the approved template
 * carries the ToS link alone, matching V1's UX.
 */
export function buildV2LegalPrompt(
  lang: Lang,
  tosUrl: string,
  privacyUrl: string,
): InteractivePrompt {
  return {
    templateName: `onboarding_legal_${lang}`,
    variables: { '1': tosUrl },
    fallbackBody: t('v2_legal_prompt', lang, { tos_url: tosUrl, privacy_url: privacyUrl }),
  };
}

/**
 * Trade picker for `profile.trade`, on V1's registered `onboarding_trade_*`
 * template. v2's TRADE_ORDER is identical to V1's `main_trade` options
 * (electrician, plumber, carpenter, concrete, painting, other), so the approved
 * template asks for exactly the data v2 needs — no UX change, no new template.
 *
 * Zero variables, matching `buildProfileInteractivePrompt`'s contract for this
 * template. Its taps arrive as `profile:main_trade:<trade>`, which
 * `parseTradeChoice` accepts alongside the numbered replies used when the
 * template is unavailable and the fallback body renders instead.
 */
export function buildV2TradePrompt(
  lang: Lang,
  question: string,
  options: readonly string[],
): InteractivePrompt {
  return {
    templateName: `onboarding_trade_${lang}`,
    variables: {},
    fallbackBody: buildNumberedOptionsBody(lang, question, options),
  };
}

export function buildV2NumberedOptionsPrompt(
  lang: Lang,
  question: string,
  options: readonly string[],
): InteractivePrompt {
  return {
    templateName: `v2_onboarding_options_${lang}`,
    variables: {},
    fallbackBody: buildNumberedOptionsBody(lang, question, options),
  };
}

function buildNumberedOptionsBody(
  lang: Lang,
  question: string,
  options: readonly string[],
): string {
  const lines = options.map((o, i) => `${i + 1}. ${o}`);
  return [question, ...lines, t('v2_options_footer', lang)].join('\n');
}
