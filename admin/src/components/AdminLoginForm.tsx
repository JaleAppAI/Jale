'use client';

import { useState, type FormEvent } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type IAuthenticationCallback,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { AdminAuthConfig } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-redirect';

type LoginStep = 'credentials' | 'new-password' | 'mfa-setup' | 'mfa';

type AdminLoginFormProps = {
  config: AdminAuthConfig;
};

function getIdToken(session: CognitoUserSession): string {
  return session.getIdToken().getJwtToken();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function AdminLoginForm({ config }: AdminLoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [requiredAttributes, setRequiredAttributes] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState<LoginStep>('credentials');
  const [pendingUser, setPendingUser] = useState<CognitoUser | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function establishSession(session: CognitoUserSession) {
    const body = JSON.stringify({ idToken: getIdToken(session) });
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-content-sha256': await sha256Hex(body),
      },
      body,
    });

    if (!response.ok) {
      throw new Error('Admin session could not be established.');
    }

    const next = new URLSearchParams(window.location.search).get('next');
    window.location.assign(safeNextPath(next));
  }

  function buildUser(username: string): CognitoUser {
    const pool = new CognitoUserPool({
      UserPoolId: config.userPoolId,
      ClientId: config.clientId,
    });

    return new CognitoUser({
      Username: username,
      Pool: pool,
    });
  }

  function handleChallenge(user: CognitoUser, challengeName: string) {
    setPendingUser(user);
    setStep('mfa');
    setStatus(challengeName === 'SOFTWARE_TOKEN_MFA'
      ? 'Enter your authenticator app code.'
      : 'Enter your MFA code.');
  }

  function handleAuthFailure(err: unknown, fallback: string) {
    setError(err instanceof Error ? err.message : fallback);
    setIsSubmitting(false);
  }

  function beginSoftwareTokenSetup(user: CognitoUser) {
    setPendingUser(user);
    setIsSubmitting(false);
    setStatus('Add Jale Admin to your authenticator app, then enter the six-digit code.');

    user.associateSoftwareToken({
      associateSecretCode: (secretCode) => {
        setTotpSecret(secretCode);
        setMfaCode('');
        setStep('mfa-setup');
      },
      onFailure: (err) => handleAuthFailure(err, 'Authenticator setup could not be started.'),
    });
  }

  function authenticationCallbacks(user: CognitoUser): IAuthenticationCallback {
    return {
      onSuccess: (session) => {
        void establishSession(session).catch((err: unknown) => {
          handleAuthFailure(err, 'Sign-in failed.');
        });
      },
      onFailure: (err) => handleAuthFailure(err, 'Sign-in failed.'),
      newPasswordRequired: (userAttributes, requiredAttributeNames) => {
        const requiredAttributeSet = new Set(requiredAttributeNames ?? []);
        const acceptedAttributes = Object.fromEntries(
          Object.entries(userAttributes ?? {}).filter(([key]) => requiredAttributeSet.has(key)),
        );

        setPendingUser(user);
        setRequiredAttributes(acceptedAttributes);
        setNewPassword('');
        setConfirmNewPassword('');
        setError(undefined);
        setStatus('Replace the temporary password to continue.');
        setStep('new-password');
        setIsSubmitting(false);
      },
      mfaRequired: () => {
        setIsSubmitting(false);
        handleChallenge(user, 'MFA');
      },
      totpRequired: () => {
        setIsSubmitting(false);
        handleChallenge(user, 'SOFTWARE_TOKEN_MFA');
      },
      mfaSetup: () => beginSoftwareTokenSetup(user),
    };
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);

    if (!config.userPoolId || !config.clientId) {
      setError('Admin Cognito configuration is missing.');
      return;
    }

    setIsSubmitting(true);
    const user = buildUser(email.trim());

    user.authenticateUser(new AuthenticationDetails({
      Username: email.trim(),
      Password: password,
    }), authenticationCallbacks(user));
  }

  async function submitNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);

    if (!pendingUser) {
      setError('Start sign-in again before replacing the temporary password.');
      setStep('credentials');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setError('The new passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    pendingUser.completeNewPasswordChallenge(
      newPassword,
      requiredAttributes,
      authenticationCallbacks(pendingUser),
    );
  }

  async function submitTotpSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);

    if (!pendingUser || !totpSecret) {
      setError('Restart sign-in before setting up the authenticator.');
      setStep('credentials');
      return;
    }

    setIsSubmitting(true);
    pendingUser.verifySoftwareToken(mfaCode.trim(), 'Jale Admin', {
      onSuccess: (session) => {
        void establishSession(session).catch((err: unknown) => {
          handleAuthFailure(err, 'Authenticator setup failed.');
        });
      },
      onFailure: (err) => handleAuthFailure(err, 'Authenticator setup failed.'),
    });
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);

    if (!pendingUser) {
      setError('Start sign-in again before entering MFA.');
      setStep('credentials');
      return;
    }

    setIsSubmitting(true);
    pendingUser.sendMFACode(
      mfaCode.trim(),
      authenticationCallbacks(pendingUser),
      'SOFTWARE_TOKEN_MFA',
    );
  }

  function restartSignIn() {
    setPendingUser(undefined);
    setRequiredAttributes({});
    setTotpSecret('');
    setMfaCode('');
    setNewPassword('');
    setConfirmNewPassword('');
    setStatus(undefined);
    setError(undefined);
    setIsSubmitting(false);
    setStep('credentials');
  }

  if (step === 'new-password') {
    return (
      <form className="stack-gap" onSubmit={submitNewPassword}>
        {status ? <p aria-live="polite" className="muted" role="status">{status}</p> : null}
        <label className="field">
          <span>New password</span>
          <input
            autoComplete="new-password"
            minLength={14}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            type="password"
            value={newPassword}
          />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            autoComplete="new-password"
            minLength={14}
            onChange={(event) => setConfirmNewPassword(event.target.value)}
            required
            type="password"
            value={confirmNewPassword}
          />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Updating password...' : 'Set new password'}
        </button>
        <button className="button secondary" onClick={restartSignIn} type="button">
          Back to sign in
        </button>
      </form>
    );
  }

  if (step === 'mfa-setup') {
    return (
      <form className="stack-gap" onSubmit={submitTotpSetup}>
        {status ? <p aria-live="polite" className="muted" role="status">{status}</p> : null}
        <div className="setup-code" aria-label="Authenticator setup key">
          <span className="muted">Setup key</span>
          <code>{totpSecret}</code>
        </div>
        <label className="field">
          <span>Authenticator code</span>
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            name="totp"
            onChange={(event) => setMfaCode(event.target.value)}
            pattern="[0-9]{6}"
            required
            type="text"
            value={mfaCode}
          />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Verifying...' : 'Finish authenticator setup'}
        </button>
        <button className="button secondary" onClick={restartSignIn} type="button">
          Back to sign in
        </button>
      </form>
    );
  }

  if (step === 'mfa') {
    return (
      <form className="stack-gap" onSubmit={submitMfa}>
        {status ? <p aria-live="polite" className="muted" role="status">{status}</p> : null}
        <label className="field">
          <span>MFA code</span>
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            name="mfa"
            onChange={(event) => setMfaCode(event.target.value)}
            required
            type="text"
            value={mfaCode}
          />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Verifying...' : 'Verify MFA'}
        </button>
        <button className="button secondary" onClick={restartSignIn} type="button">
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form className="stack-gap" onSubmit={submitCredentials}>
      <div className="form-grid">
        <label className="field">
          <span>Email</span>
          <input
            autoComplete="username"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            autoComplete="current-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
