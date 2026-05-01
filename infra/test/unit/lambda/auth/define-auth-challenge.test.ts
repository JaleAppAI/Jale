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
