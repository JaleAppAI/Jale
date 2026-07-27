// ── Mocks (must come before the handler import) ─────────────────────────
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminUpdateUserAttributesCommand: jest.fn((args) => ({ input: args, __type: 'AdminUpdateUserAttributes' })),
}));

import { handler } from '../../../../lambda/auth/verify-auth-challenge';
import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('VerifyAuthChallenge Lambda', () => {
  const baseEvent = (
    storedOtp: string | undefined,
    userAnswer: string,
    userAttributes: Record<string, string> = { phone_number: '+15125551234' },
  ): VerifyAuthChallengeResponseTriggerEvent => ({
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    userName: 'test-user',
    callerContext: { awsSdkVersion: '1', clientId: 'client-id' },
    triggerSource: 'VerifyAuthChallengeResponse_Authentication',
    request: {
      userAttributes,
      privateChallengeParameters: storedOtp ? { otp: storedOtp } : {},
      challengeAnswer: userAnswer,
    } as any,
    response: {} as any,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCognitoSend.mockResolvedValue({});
  });

  it('sets answerCorrect=true when user answer matches stored OTP', async () => {
    const result = await handler(baseEvent('123456', '123456'));
    expect(result.response.answerCorrect).toBe(true);
  });

  it('sets answerCorrect=false when user answer does not match', async () => {
    const result = await handler(baseEvent('123456', '654321'));
    expect(result.response.answerCorrect).toBe(false);
  });

  it('sets answerCorrect=false when stored OTP is missing', async () => {
    const result = await handler(baseEvent(undefined, '123456'));
    expect(result.response.answerCorrect).toBe(false);
  });

  it('sets answerCorrect=false for empty answer', async () => {
    const result = await handler(baseEvent('123456', ''));
    expect(result.response.answerCorrect).toBe(false);
  });

  it('is case/whitespace sensitive (exact match required)', async () => {
    // OTPs are numeric only, but verify the check is strict
    const r1 = await handler(baseEvent('123456', ' 123456'));
    const r2 = await handler(baseEvent('123456', '123456 '));
    expect(r1.response.answerCorrect).toBe(false);
    expect(r2.response.answerCorrect).toBe(false);
  });

  it('uses a constant-time OTP comparison', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../lambda/auth/verify-auth-challenge.ts'),
      'utf8',
    );
    expect(source).toContain('timingSafeEqual');
  });

  // ── phone_number_verified flip (2026-07-26 hardening) ────────────────
  //
  // Signup paths create workers with phone_number_verified='false'; a
  // correct OTP here is the ONLY event allowed to flip it to 'true'.

  it('flips phone_number_verified to true on a correct answer', async () => {
    const result = await handler(baseEvent('123456', '123456'));

    expect(result.response.answerCorrect).toBe(true);
    expect(mockCognitoSend).toHaveBeenCalledTimes(1);
    expect(mockCognitoSend.mock.calls[0][0].input).toEqual({
      UserPoolId: 'us-east-1_abc',
      Username: 'test-user',
      UserAttributes: [{ Name: 'phone_number_verified', Value: 'true' }],
    });
  });

  it('never touches attributes on a wrong answer', async () => {
    const result = await handler(baseEvent('123456', '654321'));

    expect(result.response.answerCorrect).toBe(false);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('skips the flip when the account is already verified', async () => {
    const result = await handler(baseEvent('123456', '123456', {
      phone_number: '+15125551234',
      phone_number_verified: 'true',
    }));

    expect(result.response.answerCorrect).toBe(true);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('a flip failure never fails a correct login (best-effort)', async () => {
    mockCognitoSend.mockRejectedValueOnce(new Error('cognito hiccup'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await handler(baseEvent('123456', '123456'));

    expect(result.response.answerCorrect).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
