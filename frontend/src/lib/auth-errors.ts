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

  if (code === 'InvalidParameterException') {
    if (message.includes('phone')) return 'errors.invalid_phone';
    if (message.includes('email')) return 'errors.invalid_email';
    if (message.includes('password')) return 'errors.password_requirements';
    return 'errors.invalid_signup';
  }

  return 'errors.signup_failed';
}
