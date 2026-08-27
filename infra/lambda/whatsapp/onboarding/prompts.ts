/**
 * WhatsApp v2 onboarding router — prompt construction: single source of
 * truth for "what does the current step ask?" Moved verbatim out of
 * `../onboarding-v2.ts` (pure move, no behavior change).
 */

import { t, type Lang } from '../lib/templates';
import {
  buildV2StartInvitationPrompt,
  buildV2OtpPrompt,
  buildV2LegalPrompt,
  buildV2TradePrompt,
  buildProfileInteractivePrompt,
  buildMediaInteractivePrompt,
  V2_FALLBACK_TRUST_QUESTIONS,
  type InteractivePrompt,
} from '../lib/interactive-templates';
import type { OnboardingV2Deps } from './types';
import { TRADE_ORDER, TRADE_LABELS, type BilingualQuestion } from './constants';

export function buildPromptForStep(
  stepKey: string,
  lang: Lang,
  deps: OnboardingV2Deps,
  stateContext?: Record<string, unknown>,
): InteractivePrompt {
  switch (stepKey) {
    case 'start.choose_language':
      return buildV2StartInvitationPrompt(lang);
    case 'identity.verify_otp':
      return buildV2OtpPrompt(lang, '5');
    case 'legal.review':
      return buildV2LegalPrompt(lang, deps.tosUrl, deps.privacyUrl);
    case 'profile.voice_choice':
      // Reuses V1's approved 'onboarding_voice_choice_*' content template
      // and 'media:voice:text' payload dialect verbatim — no new template,
      // no new payload shape.
      return buildMediaInteractivePrompt('voice_choice', lang);
    case 'profile.voice_processing':
      // No interactive template — this is a holding step, never the target
      // of a fresh prompt send (only cooldown-guarded "please wait" replies
      // from handleVoiceProcessingStep), but buildPromptForStep must still be
      // total for the default reprompt/gate-blocked machinery to work.
      return { templateName: '', variables: {}, fallbackBody: t('v2_voice_processing_wait', lang) };
    case 'profile.name':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_name', lang) };
    case 'profile.location': {
      // A pending bare-city confirm (v2LocationPendingConfirm, set by
      // handleProfileLocation) must survive gate interruptions (help/back/
      // greeting/media all repeat the prompt via this function) — otherwise
      // the worker sees the generic "where do you work?" ask while their
      // retyped city lands in the pending-confirm branch, a wedge loop.
      const pending = stateContext?.v2LocationPendingConfirm as
        | { city: string; state: string }
        | null
        | undefined;
      if (pending) {
        return {
          templateName: '',
          variables: {},
          fallbackBody: t('v2_location_confirm', lang, { city: pending.city, state: pending.state }),
        };
      }
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_location', lang) };
    }
    case 'profile.trade': {
      const options = TRADE_ORDER.map((trade) => TRADE_LABELS[trade][lang]);
      return buildV2TradePrompt(lang, t('v2_ask_trade', lang), options);
    }
    case 'profile.custom_trade':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_custom_trade', lang) };
    case 'profile.experience':
      return (
        buildProfileInteractivePrompt('years_experience', lang)
        ?? { templateName: '', variables: {}, fallbackBody: t('ask_experience', lang) }
      );
    case 'profile.transportation':
      return (
        buildProfileInteractivePrompt('has_transportation', lang)
        ?? { templateName: '', variables: {}, fallbackBody: t('ask_transportation', lang) }
      );
    case 'profile.availability':
      return (
        buildProfileInteractivePrompt('availability', lang)
        ?? { templateName: '', variables: {}, fallbackBody: t('ask_availability', lang) }
      );
    case 'trust.question.1':
    case 'trust.question.2':
    case 'trust.question.3':
      return { templateName: '', variables: {}, fallbackBody: buildTrustQuestionBody(stepKey, lang, stateContext) };
    default:
      return { templateName: '', variables: {}, fallbackBody: t('v2_gate_blocked', lang) };
  }
}

/** Reads the run's in-progress trust-question set from the session's scratch
 * context (`v2TrustQuestions`, seeded by `profile.trade`/`profile.custom_trade`);
 * falls back to the reviewed bilingual fallback set if the context is
 * missing (e.g. a stale reprompt after a redeploy). */
function buildTrustQuestionBody(stepKey: string, lang: Lang, stateContext?: Record<string, unknown>): string {
  const idx = Number(stepKey.split('.').pop()) - 1;
  const questions = (stateContext?.v2TrustQuestions as BilingualQuestion[] | undefined) ?? V2_FALLBACK_TRUST_QUESTIONS;
  const q = questions[idx] ?? questions[0];
  return lang === 'en' ? q.en : q.es;
}
