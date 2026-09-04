type CognitoLikeError = {
  code?: string;
  name?: string;
  message?: string;
};

export function authErrorKey(err: unknown): string {
  const authErr = err as CognitoLikeError;
  const code = authErr?.code ?? authErr?.name ?? '';
  const message = authErr?.message?.toLowerCase() ?? '';

  if (code === 'UsernameExistsException') return 'errors.account_exists';
  if (code === 'InvalidPasswordException') return 'errors.password_requirements';
  if (code === 'CodeMismatchException') return 'errors.invalid_code';
  if (code === 'ExpiredCodeException') return 'errors.expired_code';
  if (code === 'LimitExceededException' || code === 'TooManyRequestsException') return 'errors.too_many_attempts';
  if (message.includes('too many') || message.includes('rate limit')) return 'errors.too_many_attempts';
  if (message.includes('unable to send a verification code right now')) return 'errors.too_many_attempts';
  if (code === 'UserNotFoundException') return 'errors.account_not_found';
  if (code === 'NotAuthorizedException') return 'errors.invalid_credentials';
  // Cognito raises this when the credentials were right but the account was
  // never confirmed. `preventUserExistenceErrors: true` does NOT mask it, so it
  // reaches the browser and needs a sentence of its own — without one, a user
  // who simply missed the confirmation email was told "we could not create the
  // account", which describes nothing that happened.
  //
  // `EmployerAuthForm` intercepts this key to start its recovery flow instead
  // of rendering it, so the employer-side copy is a fallback; the worker form
  // renders it directly.
  if (code === 'UserNotConfirmedException') return 'errors.account_not_confirmed';

  if (code === 'InvalidParameterException') {
    if (message.includes('phone')) return 'errors.invalid_phone';
    if (message.includes('email')) return 'errors.invalid_email';
    if (message.includes('password')) return 'errors.password_requirements';
    return 'errors.invalid_signup';
  }

  return 'errors.signup_failed';
}

/**
 * Resend-confirmation-code failures, which reuse Cognito codes with different
 * meanings and so cannot go through `authErrorKey`:
 *
 * - `NotAuthorizedException` means "wrong password" on `authenticateUser` but
 *   "this account is already confirmed" on `resendConfirmationCode`. Cognito
 *   returns either that or `InvalidParameterException` for an already-confirmed
 *   user and does not document which, so both are handled here. Never branch on
 *   the message text: it is not a contract and it is not localised.
 * - `LimitExceededException` needs the resend cap wording (5 per user per hour)
 *   rather than the generic "wait a few minutes", which would send the user
 *   back to a button that stays refused.
 *
 * Anything else is a normal auth failure and defers to `authErrorKey`, so the
 * shared mapper stays narrow instead of growing resend-only branches that would
 * then also fire on sign-in and sign-up.
 */
export function resendErrorKey(err: unknown): string {
  const authErr = err as CognitoLikeError;
  const code = authErr?.code ?? authErr?.name ?? '';

  if (code === 'LimitExceededException' || code === 'TooManyRequestsException') return 'errors.resend_limit';
  if (code === 'InvalidParameterException' || code === 'NotAuthorizedException') return 'errors.already_confirmed';
  if (code === 'CodeDeliveryFailureException') return 'errors.code_delivery_failed';

  return authErrorKey(err);
}

/**
 * Confirm-sign-up failures. The same collision as the resend mapper above, for
 * the same reason and under the same rule about message text:
 *
 * - `NotAuthorizedException` means "wrong password" on `authenticateUser`, but
 *   `ConfirmSignUp` against an account that is ALREADY CONFIRMED rejects with
 *   it too ("User cannot be confirmed. Current status is CONFIRMED"). Sending
 *   that through `authErrorKey` printed "The email or password is incorrect"
 *   on a step that has no password field, so an employer who reached the
 *   confirm step with the wrong password had no way to read it as anything but
 *   an invitation to try the code again — and looped.
 *
 * Only that one code is remapped. `InvalidParameterException` is deliberately
 * NOT carried over from `resendErrorKey`: on a confirm it keeps its ordinary
 * bad-parameter meaning, and answering "already confirmed" there would just
 * swap one wrong sentence for another. Everything else — a mistyped or expired
 * code, the attempt cap — is an ordinary confirm failure and defers to
 * `authErrorKey`, keeping the shared mapper free of confirm-only branches that
 * would then also fire on sign-in.
 */
export function confirmErrorKey(err: unknown): string {
  const authErr = err as CognitoLikeError;
  const code = authErr?.code ?? authErr?.name ?? '';

  if (code === 'NotAuthorizedException') return 'errors.already_confirmed';

  return authErrorKey(err);
}

/**
 * Forgot-password failures. Not a code collision this time — a MESSAGE trap.
 *
 * Cognito refuses a reset for an account with no verified contact with
 * `InvalidParameterException` and the message "Cannot reset password for the
 * user as there is no registered/verified email or phone_number". That string
 * contains "phone", so `authErrorKey`'s message sniffing answered "Enter a
 * valid phone number" — on a step whose only field is an email address, about
 * a password the employer was trying to reset.
 *
 * The refusal is not an unlucky wording either: it is the whole story. The
 * employer pool recovers phone-first, and an UNCONFIRMED employer has no
 * verified email, so a reset can never succeed for them no matter how many
 * times they ask. The recovery that DOES work is the confirmation-code flow
 * `EmployerAuthForm` already runs for `UserNotConfirmedException`, which is
 * why this maps to the same key: the form intercepts it and starts that flow.
 *
 * Only the code decides. Nothing sent to `ForgotPassword` but the address can
 * be an invalid parameter (a malformed one comes back as
 * `UserNotFoundException`, or is masked by `preventUserExistenceErrors`), and
 * the message text is neither contractual nor localised. Everything else is an
 * ordinary auth failure and defers to `authErrorKey`, so the shared mapper
 * keeps reading messages on the call sites — signup, and the worker form —
 * whose screens actually have the fields those sentences name.
 */
export function forgotErrorKey(err: unknown): string {
  const authErr = err as CognitoLikeError;
  const code = authErr?.code ?? authErr?.name ?? '';

  if (code === 'InvalidParameterException') return 'errors.account_not_confirmed';

  return authErrorKey(err);
}
