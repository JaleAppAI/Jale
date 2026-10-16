'use client';

import { useEffect, useReducer, useRef, useState, type FormEvent, type Ref } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type IAuthenticationCallback,
} from 'amazon-cognito-identity-js';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { adminFetchJson } from '@/lib/admin-fetch';
import type { AdminClientAuthConfig } from '@/lib/auth';
import {
  SESSION_FAILED_MESSAGE,
  TRUST_BROWSER_HELP,
  TRUST_BROWSER_LABEL,
  cachedDeviceOf,
  completeSignIn,
  initialLoginState,
  loginReducer,
  showTrustCheckbox,
  type LoginStep,
  type RestartReason,
  type SessionNext,
  type TrustChoice,
} from '@/lib/login-flow';
import { buildOtpauthUri } from '@/lib/otpauth';

type AdminLoginFormProps = {
  authConfig: AdminClientAuthConfig;
  deviceTrustEnabled: boolean;
};

/** POST /api/session's answer (K1.2). */
type SessionResponse = { ok?: boolean; error?: string };

const LABEL = 'text-sm font-semibold text-[var(--jale-ink)]';
const FIELD = 'flex flex-col gap-1.5';
const CODE_INPUT = 'text-center text-xl font-semibold tracking-[0.4em] tabular-nums';

function StepHeading({ title, prompt, promptId }: { title: string; prompt?: string; promptId?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-2xl font-extrabold tracking-tight text-[var(--jale-ink)]">{title}</h2>
      {prompt ? <p className="text-sm text-[var(--jale-ink-2)]" id={promptId}>{prompt}</p> : null}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <Button onClick={onBack} type="button" variant="secondary">Back to sign in</Button>;
}

function ErrorLine({ error }: { error?: string }) {
  return error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null;
}

export type CredentialsStepProps = {
  email: string;
  password: string;
  submitting: boolean;
  notice?: string;
  error?: string;
  firstFieldRef?: Ref<HTMLInputElement>;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function CredentialsStep({
  email, password, submitting, notice, error, firstFieldRef, onEmailChange, onPasswordChange, onSubmit,
}: CredentialsStepProps) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <StepHeading title="Sign in" />
      {notice ? <InlineFeedback tone="info">{notice}</InlineFeedback> : null}
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-email">Work email</label>
        <Input
          autoComplete="username"
          id="login-email"
          name="email"
          onChange={(event) => onEmailChange(event.target.value)}
          ref={firstFieldRef}
          required
          spellCheck={false}
          type="email"
          value={email}
        />
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-password">Password</label>
        <Input
          autoComplete="current-password"
          id="login-password"
          name="password"
          onChange={(event) => onPasswordChange(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      <ErrorLine error={error} />
      <Button loading={submitting} loadingLabel="Signing in…" type="submit">Continue</Button>
    </form>
  );
}

export type NewPasswordStepProps = {
  prompt?: string;
  newPassword: string;
  confirmNewPassword: string;
  submitting: boolean;
  error?: string;
  firstFieldRef?: Ref<HTMLInputElement>;
  onNewPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
};

export function NewPasswordStep({
  prompt, newPassword, confirmNewPassword, submitting, error, firstFieldRef,
  onNewPasswordChange, onConfirmChange, onSubmit, onBack,
}: NewPasswordStepProps) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <StepHeading prompt={prompt} promptId="login-new-password-prompt" title="Set a new password" />
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-new-password">New password</label>
        <Input
          aria-describedby={prompt ? 'login-new-password-prompt' : undefined}
          autoComplete="new-password"
          id="login-new-password"
          minLength={14}
          onChange={(event) => onNewPasswordChange(event.target.value)}
          ref={firstFieldRef}
          required
          type="password"
          value={newPassword}
        />
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-confirm-password">Confirm new password</label>
        <Input
          autoComplete="new-password"
          id="login-confirm-password"
          minLength={14}
          onChange={(event) => onConfirmChange(event.target.value)}
          required
          type="password"
          value={confirmNewPassword}
        />
      </div>
      <ErrorLine error={error} />
      <Button loading={submitting} loadingLabel="Updating password…" type="submit">Set new password</Button>
      <BackButton onBack={onBack} />
    </form>
  );
}

export type TotpSetupStepProps = {
  prompt?: string;
  totpSecret: string;
  qrDataUrl?: string;
  code: string;
  submitting: boolean;
  error?: string;
  firstFieldRef?: Ref<HTMLInputElement>;
  onCodeChange: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
};

/** First-time authenticator setup. No device exists yet, so there is no trust box here. */
export function TotpSetupStep({
  prompt, totpSecret, qrDataUrl, code, submitting, error, firstFieldRef, onCodeChange, onSubmit, onBack,
}: TotpSetupStepProps) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <StepHeading prompt={prompt} promptId="login-setup-prompt" title="Set up your authenticator app" />
      {qrDataUrl ? (
        // The QR stays a data: image (CSP img-src 'self' data:), on white so it scans in either theme.
        <div className="self-center rounded-xl bg-white p-2">
          <img alt="Scan this QR code with your authenticator app" height={200} src={qrDataUrl} width={200} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--jale-ink-2)]">Can&apos;t scan? Enter this code manually:</span>
        <span className="font-mono [overflow-wrap:anywhere]" translate="no"><code>{totpSecret}</code></span>
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-setup-code">Authenticator code</label>
        <Input
          aria-describedby={prompt ? 'login-setup-prompt' : undefined}
          autoComplete="one-time-code"
          className={CODE_INPUT}
          id="login-setup-code"
          inputMode="numeric"
          maxLength={6}
          name="totp"
          onChange={(event) => onCodeChange(event.target.value)}
          pattern="[0-9]{6}"
          ref={firstFieldRef}
          required
          spellCheck={false}
          type="text"
          value={code}
        />
      </div>
      <ErrorLine error={error} />
      <Button loading={submitting} loadingLabel="Verifying…" type="submit">Finish authenticator setup</Button>
      <BackButton onBack={onBack} />
    </form>
  );
}

export type MfaCodeStepProps = {
  prompt?: string;
  code: string;
  /** Whether the trust box is on screen (showTrustCheckbox). */
  showTrust: boolean;
  trustBrowser: boolean;
  submitting: boolean;
  error?: string;
  firstFieldRef?: Ref<HTMLInputElement>;
  onCodeChange: (code: string) => void;
  onTrustChange: (checked: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
};

export function MfaCodeStep({
  prompt, code, showTrust, trustBrowser, submitting, error, firstFieldRef,
  onCodeChange, onTrustChange, onSubmit, onBack,
}: MfaCodeStepProps) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <StepHeading prompt={prompt} promptId="login-code-prompt" title="Enter your code" />
      <div className={FIELD}>
        <label className={LABEL} htmlFor="login-code">Authenticator code</label>
        <Input
          aria-describedby={prompt ? 'login-code-prompt' : undefined}
          autoComplete="one-time-code"
          className={CODE_INPUT}
          id="login-code"
          inputMode="numeric"
          maxLength={6}
          name="mfa"
          onChange={(event) => onCodeChange(event.target.value)}
          pattern="[0-9]{6}"
          ref={firstFieldRef}
          required
          spellCheck={false}
          type="text"
          value={code}
        />
      </div>
      {showTrust ? (
        // The whole box is the hit target; the label text names the box and the help describes it.
        <label
          className="flex cursor-pointer items-start gap-3 rounded-xl bg-[var(--jale-blue-50)] p-3.5 has-[:focus-visible]:shadow-[var(--shadow-focus)]"
          htmlFor="login-trust-browser"
        >
          <input
            aria-describedby="login-trust-browser-help"
            aria-labelledby="login-trust-browser-label"
            checked={trustBrowser}
            className="mt-0.5 size-5 shrink-0 accent-[var(--jale-blue-500)]"
            id="login-trust-browser"
            name="trustBrowser"
            onChange={(event) => onTrustChange(event.target.checked)}
            type="checkbox"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-[var(--jale-blue-700)]" id="login-trust-browser-label">
              {TRUST_BROWSER_LABEL}
            </span>
            <span className="text-xs leading-relaxed text-[var(--jale-ink-2)]" id="login-trust-browser-help">
              {TRUST_BROWSER_HELP}
            </span>
          </span>
        </label>
      ) : null}
      <ErrorLine error={error} />
      <Button loading={submitting} loadingLabel="Verifying…" type="submit">Verify and sign in</Button>
      <BackButton onBack={onBack} />
    </form>
  );
}

export function AdminLoginForm({ authConfig, deviceTrustEnabled }: AdminLoginFormProps) {
  const [state, dispatch] = useReducer(loginReducer, undefined, initialLoginState);
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpQrDataUrl, setTotpQrDataUrl] = useState<string | undefined>();
  const [requiredAttributes, setRequiredAttributes] = useState<Record<string, unknown>>({});
  const [pendingUser, setPendingUser] = useState<CognitoUser | undefined>();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const shownStep = useRef<LoginStep>(state.step);

  useEffect(() => {
    if (!totpSecret) {
      setTotpQrDataUrl(undefined);
      return;
    }

    let cancelled = false;

    QRCode.toDataURL(buildOtpauthUri(totpSecret, state.email), { width: 200, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) {
          setTotpQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTotpQrDataUrl(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [totpSecret, state.email]);

  // A new step takes focus to its first field: the control that moved the
  // admin on is gone from the page.
  useEffect(() => {
    if (shownStep.current === state.step) return;
    shownStep.current = state.step;
    firstFieldRef.current?.focus();
  }, [state.step]);

  function choiceFor(step: LoginStep): TrustChoice {
    return { step, trustChecked: step === 'mfa' && state.trustBrowser, deviceTrustEnabled };
  }

  function restart(reason?: RestartReason) {
    setPendingUser(undefined);
    setRequiredAttributes({});
    setTotpSecret('');
    setMfaCode('');
    setPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    dispatch({ type: 'restarted', reason });
  }

  async function establishSession(session: CognitoUserSession, user: CognitoUser, choice: TrustChoice) {
    let next: SessionNext;
    try {
      next = await completeSignIn({
        session,
        device: cachedDeviceOf(user),
        choice,
        search: window.location.search,
        post: (body) => adminFetchJson<SessionResponse>('/api/session', { method: 'POST', body, redirectOn401: false }),
      });
    } catch {
      next = { kind: 'restart', reason: { message: SESSION_FAILED_MESSAGE, tone: 'error' } };
    }
    if (next.kind === 'navigate') {
      window.location.assign(next.href);
      return;
    }
    restart(next.reason);
  }

  function buildUser(username: string): CognitoUser {
    const pool = new CognitoUserPool({
      UserPoolId: authConfig.userPoolId,
      ClientId: authConfig.clientId,
    });

    return new CognitoUser({
      Username: username,
      Pool: pool,
    });
  }

  function failed(err: unknown, fallback: string) {
    dispatch({ type: 'submit_failed', message: err instanceof Error ? err.message : fallback });
  }

  function beginSoftwareTokenSetup(user: CognitoUser) {
    setPendingUser(user);
    user.associateSoftwareToken({
      associateSecretCode: (secretCode) => {
        setTotpSecret(secretCode);
        setMfaCode('');
        dispatch({ type: 'totp_setup_started' });
      },
      onFailure: (err) => failed(err, 'Authenticator setup could not be started.'),
    });
  }

  function authenticationCallbacks(user: CognitoUser, choice: TrustChoice): IAuthenticationCallback {
    return {
      // Only the session is read. Whether this browser becomes trusted is the
      // server's call, made from the POST below (K1.2).
      onSuccess: (session) => {
        void establishSession(session, user, choice);
      },
      onFailure: (err) => failed(err, 'Sign-in failed.'),
      newPasswordRequired: (userAttributes, requiredAttributeNames) => {
        const requiredAttributeSet = new Set(requiredAttributeNames ?? []);
        const acceptedAttributes = Object.fromEntries(
          Object.entries(userAttributes ?? {}).filter(([key]) => requiredAttributeSet.has(key)),
        );

        setPendingUser(user);
        setRequiredAttributes(acceptedAttributes);
        setNewPassword('');
        setConfirmNewPassword('');
        dispatch({ type: 'new_password_required' });
      },
      mfaRequired: () => {
        setPendingUser(user);
        setMfaCode('');
        dispatch({ type: 'code_required', challenge: 'other' });
      },
      totpRequired: () => {
        setPendingUser(user);
        setMfaCode('');
        dispatch({ type: 'code_required', challenge: 'totp' });
      },
      mfaSetup: () => beginSoftwareTokenSetup(user),
    };
  }

  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting) return;

    if (!authConfig.userPoolId || !authConfig.clientId) {
      dispatch({ type: 'submit_failed', message: 'Admin Cognito configuration is missing.' });
      return;
    }

    dispatch({ type: 'submit_started' });
    const username = state.email.trim();
    const user = buildUser(username);

    user.authenticateUser(new AuthenticationDetails({
      Username: username,
      Password: password,
    }), authenticationCallbacks(user, choiceFor('credentials')));
  }

  function submitNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting) return;

    if (!pendingUser) {
      restart({ message: 'Start sign-in again before replacing the temporary password.', tone: 'error' });
      return;
    }

    if (newPassword !== confirmNewPassword) {
      dispatch({ type: 'submit_failed', message: 'The new passwords do not match.' });
      return;
    }

    dispatch({ type: 'submit_started' });
    pendingUser.completeNewPasswordChallenge(
      newPassword,
      requiredAttributes,
      authenticationCallbacks(pendingUser, choiceFor('new-password')),
    );
  }

  function submitTotpSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting) return;

    if (!pendingUser || !totpSecret) {
      restart({ message: 'Restart sign-in before setting up the authenticator.', tone: 'error' });
      return;
    }

    dispatch({ type: 'submit_started' });
    const user = pendingUser;
    const choice = choiceFor('mfa-setup');
    user.verifySoftwareToken(mfaCode.trim(), 'Jale Admin', {
      onSuccess: (session) => {
        void establishSession(session, user, choice);
      },
      onFailure: (err) => failed(err, 'Authenticator setup failed.'),
    });
  }

  function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting) return;

    if (!pendingUser) {
      restart({ message: 'Start sign-in again before entering MFA.', tone: 'error' });
      return;
    }

    dispatch({ type: 'submit_started' });
    pendingUser.sendMFACode(
      mfaCode.trim(),
      authenticationCallbacks(pendingUser, choiceFor('mfa')),
      'SOFTWARE_TOKEN_MFA',
    );
  }

  if (state.step === 'new-password') {
    return (
      <NewPasswordStep
        confirmNewPassword={confirmNewPassword}
        error={state.error}
        firstFieldRef={firstFieldRef}
        newPassword={newPassword}
        onBack={() => restart()}
        onConfirmChange={setConfirmNewPassword}
        onNewPasswordChange={setNewPassword}
        onSubmit={submitNewPassword}
        prompt={state.prompt}
        submitting={state.submitting}
      />
    );
  }

  if (state.step === 'mfa-setup') {
    return (
      <TotpSetupStep
        code={mfaCode}
        error={state.error}
        firstFieldRef={firstFieldRef}
        onBack={() => restart()}
        onCodeChange={setMfaCode}
        onSubmit={submitTotpSetup}
        prompt={state.prompt}
        qrDataUrl={totpQrDataUrl}
        submitting={state.submitting}
        totpSecret={totpSecret}
      />
    );
  }

  if (state.step === 'mfa') {
    return (
      <MfaCodeStep
        code={mfaCode}
        error={state.error}
        firstFieldRef={firstFieldRef}
        onBack={() => restart()}
        onCodeChange={setMfaCode}
        onSubmit={submitMfa}
        onTrustChange={(checked) => dispatch({ type: 'trust_changed', checked })}
        prompt={state.prompt}
        showTrust={showTrustCheckbox(state.step, deviceTrustEnabled)}
        submitting={state.submitting}
        trustBrowser={state.trustBrowser}
      />
    );
  }

  return (
    <CredentialsStep
      email={state.email}
      error={state.error}
      firstFieldRef={firstFieldRef}
      notice={state.notice}
      onEmailChange={(email) => dispatch({ type: 'email_changed', email })}
      onPasswordChange={setPassword}
      onSubmit={submitCredentials}
      password={password}
      submitting={state.submitting}
    />
  );
}
