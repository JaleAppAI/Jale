import { handler } from '../../../../lambda/auth/define-auth-challenge';
import type { DefineAuthChallengeTriggerEvent } from 'aws-lambda';

describe('DefineAuthChallenge Lambda', () => {
  const baseEvent = (session: any[]): DefineAuthChallengeTriggerEvent => ({
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    userName: 'test-user',
    callerContext: { awsSdkVersion: '1', clientId: 'client-id' },
    triggerSource: 'DefineAuthChallenge_Authentication',
    request: {
      userAttributes: { phone_number: '+15125551234' },
      session,
      userNotFound: false,
    } as any,
    response: {
      challengeName: undefined,
      issueTokens: undefined,
      failAuthentication: undefined,
    } as any,
  });

  it('issues CUSTOM_CHALLENGE on first call (empty session)', async () => {
    const event = baseEvent([]);
    const result = await handler(event);

    expect(result.response.challengeName).toBe('CUSTOM_CHALLENGE');
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(false);
  });

  // `preventUserExistenceErrors: true` (lib/constructs/cognito-pool.ts) makes
  // Cognito run this trigger for an UNKNOWN phone too, with `userNotFound:
  // true` and empty userAttributes. It must fail authentication right here:
  // letting it fall through to CUSTOM_CHALLENGE invoked CreateAuthChallenge,
  // which threw on the missing phone_number attribute and paged
  // WorkerOtpSendErrors (2026-09-22).
  it('fails authentication immediately, with no challenge, when the user does not exist', async () => {
    const event = baseEvent([]);
    (event.request as any).userNotFound = true;
    (event.request as any).userAttributes = {};

    const result = await handler(event);

    expect(result.response.failAuthentication).toBe(true);
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.challengeName).toBeUndefined();
  });

  it('userNotFound wins even when a session is present (never issues tokens or a retry challenge for a missing user)', async () => {
    const event = baseEvent([
      { challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: '123456' },
    ]);
    (event.request as any).userNotFound = true;

    const result = await handler(event);

    expect(result.response.failAuthentication).toBe(true);
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.challengeName).toBeUndefined();
  });

  it('issues tokens when last challenge succeeded', async () => {
    const event = baseEvent([
      {
        challengeName: 'CUSTOM_CHALLENGE',
        challengeResult: true,
        challengeMetadata: '123456',
      },
    ]);
    const result = await handler(event);

    expect(result.response.issueTokens).toBe(true);
    expect(result.response.failAuthentication).toBe(false);
  });

  it('fails authentication after 3 failed attempts', async () => {
    const failedAttempt = {
      challengeName: 'CUSTOM_CHALLENGE',
      challengeResult: false,
      challengeMetadata: '123456',
    };
    const event = baseEvent([failedAttempt, failedAttempt, failedAttempt]);
    const result = await handler(event);

    expect(result.response.failAuthentication).toBe(true);
    expect(result.response.issueTokens).toBe(false);
  });

  it('issues another CUSTOM_CHALLENGE on 1st failure (under retry limit)', async () => {
    const event = baseEvent([
      {
        challengeName: 'CUSTOM_CHALLENGE',
        challengeResult: false,
        challengeMetadata: '123456',
      },
    ]);
    const result = await handler(event);

    expect(result.response.challengeName).toBe('CUSTOM_CHALLENGE');
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(false);
  });

  it('issues another CUSTOM_CHALLENGE on 2nd failure (still under retry limit)', async () => {
    const failedAttempt = {
      challengeName: 'CUSTOM_CHALLENGE',
      challengeResult: false,
      challengeMetadata: '123456',
    };
    const event = baseEvent([failedAttempt, failedAttempt]);
    const result = await handler(event);

    expect(result.response.challengeName).toBe('CUSTOM_CHALLENGE');
    expect(result.response.failAuthentication).toBe(false);
  });
});
