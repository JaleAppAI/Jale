import type { CustomMessageTriggerEvent } from 'aws-lambda';

import {
  CODE_EMAIL_MAX_CHARS,
  codeEmailTriggerFor,
  renderEmployerCodeEmail,
} from '../lib/employer-code-email-template';

/**
 * CustomMessage trigger for the employer user pool: replaces Cognito's default
 * plain-text verification email with the branded bilingual code email.
 *
 * FAIL OPEN, ALWAYS. This trigger runs inside SignUp, ResendConfirmationCode
 * and ForgotPassword. If it throws, times out, or returns an `emailMessage`
 * that has lost the `{####}` placeholder or exceeds 20 000 characters, Cognito
 * fails the ENTIRE API call with InvalidLambdaResponseException — the employer
 * cannot sign up or reset their password at all. A cosmetic template is never
 * worth that, so every uncertain path returns the event untouched and lets
 * Cognito send its own default copy. The rendered body is therefore
 * self-checked BEFORE anything is assigned to `event.response`.
 *
 * PII: `event.userName` on this pool IS the employer's email address. It, the
 * `codeParameter`, and the rendered message body must never be logged. The
 * warnings below carry only the trigger source, a length, and a clipped error
 * message — matching the precedent in verify-auth-challenge.ts. The happy path
 * logs nothing at all, because a log line per verification email is a log line
 * per employer sign-up.
 */

/**
 * Emergency lever: set to 'true' via `aws lambda update-function-configuration`
 * to fall back to Cognito's default template without touching the user pool or
 * waiting on a deploy. The next CDK deploy clears it.
 *
 * Read per invocation, never at module scope — a module-scope read would pin
 * the value to the first cold start of the execution environment and ignore
 * the very update the lever exists to deliver.
 */
export const KILL_SWITCH_ENV = 'EMPLOYER_CUSTOM_MESSAGE_DISABLED';

export const handler = async (
  event: CustomMessageTriggerEvent,
): Promise<CustomMessageTriggerEvent> => {
  try {
    if (process.env[KILL_SWITCH_ENV] === 'true') {
      return event;
    }

    const trigger = codeEmailTriggerFor(event.triggerSource);
    if (trigger === null) {
      // AdminCreateUser, Authentication, or a source AWS added after this was
      // written. Cognito's default copy is correct for all of them.
      return event;
    }

    const codeParameter = event.request?.codeParameter;
    if (typeof codeParameter !== 'string' || codeParameter.length === 0) {
      console.warn('[employer-custom-message] missing codeParameter; using Cognito default', {
        triggerSource: event.triggerSource,
      });
      return event;
    }

    const { subject, html } = renderEmployerCodeEmail(trigger, codeParameter);

    // The two conditions Cognito rejects the whole API call over. Checked here
    // rather than trusted from the template, so a future template edit that
    // drops or duplicates the placeholder degrades to the default email
    // instead of breaking sign-up.
    if (html.split(codeParameter).length !== 2 || html.length > CODE_EMAIL_MAX_CHARS) {
      console.warn('[employer-custom-message] rendered body failed its self-check; using Cognito default', {
        triggerSource: event.triggerSource,
        htmlLength: html.length,
      });
      return event;
    }

    event.response.emailSubject = subject;
    event.response.emailMessage = html;
    // smsMessage is deliberately left untouched: the employer pool has no SMS
    // channel, and a non-null value here would be a message nobody can receive.
    return event;
  } catch (err) {
    console.warn('[employer-custom-message] render failed; using Cognito default', {
      triggerSource: event?.triggerSource,
      err: String((err as Error)?.message ?? err).slice(0, 200),
    });
    return event;
  }
};
