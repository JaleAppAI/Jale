// The admin sign-in steps as plain functions, so the form's decisions can be
// checked without a browser (scripts/check-ui-login-form.mjs). The form
// (components/AdminLoginForm.tsx) holds the state, talks to Cognito and calls
// these. Nothing here remembers a device: the server decides whether this
// browser is trusted (K1.2).
import { safeNextPath } from './safe-redirect';

export type LoginStep = 'credentials' | 'new-password' | 'mfa-setup' | 'mfa';

export const TRUST_BROWSER_LABEL = 'Trust this browser for 7 days';
export const TRUST_BROWSER_HELP =
  "You won't be asked for a code on this browser for 7 days. Don't use this on a shared computer.";
export const DEVICE_TRUST_EXPIRED_NOTICE = 'For your security, enter a code from your authenticator app again.';
/** The form's existing message when the console session cannot be made. */
export const SESSION_FAILED_MESSAGE = 'Admin session could not be established.';

export const LOGIN_PROMPTS = {
  newPassword: 'Replace the temporary password to continue.',
  totpSetup: 'Add Jale Admin to your authenticator app, then enter the six-digit code.',
  totpCode: 'From your authenticator app.',
  otherCode: 'Enter your MFA code.',
} as const;

/**
 * The trust box shows on the code step only, and only while the server allows
 * trust. First-time authenticator setup registers no device, so it has none.
 */
export function showTrustCheckbox(step: LoginStep, deviceTrustEnabled: boolean): boolean {
  return deviceTrustEnabled && step === 'mfa';
}

// --- The steps ---------------------------------------------------------------

export type LoginState = {
  step: LoginStep;
  /** Kept when the sign-in starts again. */
  email: string;
  /** The trust box: unticked whenever a step is entered. */
  trustBrowser: boolean;
  submitting: boolean;
  /** One line under the step heading. */
  prompt?: string;
  /** Why the admin is back at the first step, shown there. */
  notice?: string;
  error?: string;
};

export type RestartReason = { message: string; tone: 'notice' | 'error' };

export type LoginEvent =
  | { type: 'email_changed'; email: string }
  | { type: 'submit_started' }
  | { type: 'submit_failed'; message: string }
  | { type: 'new_password_required' }
  | { type: 'totp_setup_started' }
  | { type: 'code_required'; challenge: 'totp' | 'other' }
  | { type: 'trust_changed'; checked: boolean }
  | { type: 'restarted'; reason?: RestartReason };

export function initialLoginState(): LoginState {
  return { step: 'credentials', email: '', trustBrowser: false, submitting: false };
}

function enter(state: LoginState, step: LoginStep, prompt: string): LoginState {
  return { step, email: state.email, trustBrowser: false, submitting: false, prompt };
}

export function loginReducer(state: LoginState, event: LoginEvent): LoginState {
  switch (event.type) {
    case 'email_changed':
      return { ...state, email: event.email };
    case 'submit_started':
      return { ...state, submitting: true, error: undefined, notice: undefined };
    case 'submit_failed':
      return { ...state, submitting: false, error: event.message };
    case 'new_password_required':
      return enter(state, 'new-password', LOGIN_PROMPTS.newPassword);
    case 'totp_setup_started':
      return enter(state, 'mfa-setup', LOGIN_PROMPTS.totpSetup);
    case 'code_required':
      return enter(state, 'mfa', event.challenge === 'totp' ? LOGIN_PROMPTS.totpCode : LOGIN_PROMPTS.otherCode);
    case 'trust_changed':
      return state.step === 'mfa' ? { ...state, trustBrowser: event.checked } : state;
    case 'restarted':
      return {
        step: 'credentials',
        email: state.email,
        trustBrowser: false,
        submitting: false,
        ...(event.reason?.tone === 'notice' ? { notice: event.reason.message } : {}),
        ...(event.reason?.tone === 'error' ? { error: event.reason.message } : {}),
      };
  }
}

// --- The sign-in POST and its answer ------------------------------------------

export type SessionTokens = { idToken: string; accessToken: string };
/** K1.2: exactly these keys, in this order. */
export type SessionRequestBody = { idToken: string; accessToken: string; trustDevice: boolean };
/** What the form knew when Cognito handed it a session. */
export type TrustChoice = { step: LoginStep; trustChecked: boolean; deviceTrustEnabled: boolean };

export function buildSessionBody(tokens: SessionTokens, choice: TrustChoice): SessionRequestBody {
  return {
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    // A box that was not on screen cannot have been ticked.
    trustDevice: showTrustCheckbox(choice.step, choice.deviceTrustEnabled) && choice.trustChecked,
  };
}

/** adminFetchJson's answer for POST /api/session, by shape. */
export type SessionPostOutcome =
  | { kind: 'ok'; status: number; data: unknown }
  | { kind: 'error'; status: number; data: unknown }
  | { kind: 'redirecting' }
  | { kind: 'network' };

/** The browser library's own record of this browser as a device. */
export type CachedDevice = { clearCachedDeviceKeyAndPassword(): void };

export type SessionNext = { kind: 'navigate'; href: string } | { kind: 'restart'; reason: RestartReason };

function errorCode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as { error?: unknown }).error;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where an answer from POST /api/session leads (K1.2). A trust the server has
 * ended also drops the device the library cached, so the next sign-in asks
 * for a code and registers this browser afresh.
 */
export function resolveSessionOutcome(
  outcome: SessionPostOutcome,
  context: { search: string; device: CachedDevice },
): SessionNext {
  if (outcome.kind === 'ok') {
    return { kind: 'navigate', href: safeNextPath(new URLSearchParams(context.search).get('next')) };
  }
  if (outcome.kind === 'error' && outcome.status === 401 && errorCode(outcome.data) === 'device_trust_expired') {
    context.device.clearCachedDeviceKeyAndPassword();
    return { kind: 'restart', reason: { message: DEVICE_TRUST_EXPIRED_NOTICE, tone: 'notice' } };
  }
  return { kind: 'restart', reason: { message: SESSION_FAILED_MESSAGE, tone: 'error' } };
}

/** The two tokens of a Cognito session, by shape. */
export type SignInSession = {
  getIdToken(): { getJwtToken(): string };
  getAccessToken(): { getJwtToken(): string };
};

/** Sends the session to the console and says what the form does next. */
export async function completeSignIn(input: {
  session: SignInSession;
  device: CachedDevice;
  choice: TrustChoice;
  search: string;
  post: (body: SessionRequestBody) => Promise<SessionPostOutcome>;
}): Promise<SessionNext> {
  const body = buildSessionBody(
    {
      idToken: input.session.getIdToken().getJwtToken(),
      accessToken: input.session.getAccessToken().getJwtToken(),
    },
    input.choice,
  );
  let outcome: SessionPostOutcome;
  try {
    outcome = await input.post(body);
  } catch {
    outcome = { kind: 'network' };
  }
  return resolveSessionOutcome(outcome, { search: input.search, device: input.device });
}

/**
 * The library's device cache on this user. Its typings may omit the method, so
 * it is looked up, and a library without it fails loudly rather than leaving
 * the device in place.
 */
export function cachedDeviceOf(user: object): CachedDevice {
  return {
    clearCachedDeviceKeyAndPassword() {
      const clear = (user as { clearCachedDeviceKeyAndPassword?: unknown }).clearCachedDeviceKeyAndPassword;
      if (typeof clear !== 'function') {
        throw new Error('The sign-in library cannot clear its cached device.');
      }
      clear.call(user);
    },
  };
}
