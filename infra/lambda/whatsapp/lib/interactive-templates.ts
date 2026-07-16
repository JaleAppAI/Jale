import {
  buildTrustQuestion,
  getTrustOptions,
  type ProfileField,
} from './flows';
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

export function buildHelpMenuInteractivePrompt(lang: Lang): InteractivePrompt {
  return {
    templateName: `help_menu_list_${lang}`,
    variables: {},
    fallbackBody: t('help_menu', lang),
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

export function buildTrustInteractivePrompt(
  step: number,
  trade: string,
  lang: Lang,
): InteractivePrompt {
  const options = getTrustOptions(step, trade);
  const body = trustQuestionBody(step, lang);
  return {
    templateName: `trust_choice_${lang}`,
    variables: {
      '1': body,
      '2': options[0] ?? '',
      '3': options[1] ?? '',
      '4': options[2] ?? '',
      '5': `trust:${step}:0`,
      '6': `trust:${step}:1`,
      '7': `trust:${step}:2`,
    },
    fallbackBody: buildTrustQuestion(step, trade, lang),
  };
}

function trustQuestionBody(step: number, lang: Lang): string {
  if (step === 0) {
    return lang === 'es'
      ? 'Una pregunta mas para recomendarte mejores trabajos.\n\nEn que te especializas?'
      : 'One more question so we can recommend better jobs.\n\nWhat is your specialty?';
  }
  if (step === 1) {
    return lang === 'es' ? 'Cual es tu nivel?' : 'What is your level?';
  }
  return lang === 'es' ? 'Que trabajo haces mas?' : 'What work do you do most?';
}
