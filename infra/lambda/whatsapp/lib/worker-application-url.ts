/**
 * worker-application-url.ts -- the link to a worker's own page for one
 * application, and nothing else.
 *
 * A leaf (it imports nothing at runtime) so that every module that names the
 * link can import it: `application-fill.ts` (the bot's `web_handoff` note and
 * fill prompts) and `lib/application-web-completion-copy.ts` (the web
 * completion line), which cannot import `application-fill.ts` without an
 * import cycle through `onboarding-renderers.ts`.
 */
import type { PreferredLanguage } from './onboarding-types';

/**
 * The worker's own stage-2 page for THIS application.
 * `PUBLIC_SITE_BASE_URL` is wired onto the processor Lambda by
 * whatsapp-stack.ts; the literal fallback keeps unit tests and any
 * un-migrated environment producing a real link rather than
 * "undefined/es/worker/...".
 */
export function workerApplicationUrl(lang: PreferredLanguage, applicationId: string): string {
  const base = (process.env.PUBLIC_SITE_BASE_URL ?? 'https://jaleapp.ai').replace(/\/+$/, '');
  return `${base}/${lang}/worker/applications/${applicationId}`;
}
