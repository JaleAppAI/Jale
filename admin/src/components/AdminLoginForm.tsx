'use client';

import { useState, type FormEvent } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { AdminAuthConfig } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-redirect';

type LoginStep = 'credentials' | 'mfa';

type AdminLoginFormProps = {
  config: AdminAuthConfig;
};

function getIdToken(session: CognitoUserSession): string {
  return session.getIdToken().getJwtToken();
}

export function AdminLoginForm({ config }: AdminLoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [step, setStep] = useState<LoginStep>('credentials');
  const [pendingUser, setPendingUser] = useState<CognitoUser | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function establishSession(session: CognitoUserSession) {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: getIdToken(session) }),
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
    }), {
      onSuccess: (session) => {
        void establishSession(session).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Sign-in failed.');
          setIsSubmitting(false);
        });
      },
      onFailure: (err) => {
        setError(err.message ?? 'Sign-in failed.');
        setIsSubmitting(false);
      },
      mfaRequired: (_challengeName, _challengeParameters) => {
        setIsSubmitting(false);
        handleChallenge(user, 'MFA');
      },
      totpRequired: (_challengeName, _challengeParameters) => {
        setIsSubmitting(false);
        handleChallenge(user, 'SOFTWARE_TOKEN_MFA');
      },
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
    pendingUser.sendMFACode(mfaCode.trim(), {
      onSuccess: (session) => {
        void establishSession(session).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Sign-in failed.');
          setIsSubmitting(false);
        });
      },
      onFailure: (err) => {
        setError(err.message ?? 'MFA verification failed.');
        setIsSubmitting(false);
      },
    }, 'SOFTWARE_TOKEN_MFA');
  }

  if (step === 'mfa') {
    return (
      <form className="stack-gap" onSubmit={submitMfa}>
        {status ? <p className="muted">{status}</p> : null}
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
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Verifying...' : 'Verify MFA'}
        </button>
        <button className="button ghost" onClick={() => setStep('credentials')} type="button">
          Back
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
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
