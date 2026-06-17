import { handler } from '../../../../lambda/auth/verify-auth-challenge';
import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('VerifyAuthChallenge Lambda', () => {
  const baseEvent = (
    storedOtp: string | undefined,
    userAnswer: string,
  ): VerifyAuthChallengeResponseTriggerEvent => ({
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    userName: 'test-user',
    callerContext: { awsSdkVersion: '1', clientId: 'client-id' },
    triggerSource: 'VerifyAuthChallengeResponse_Authentication',
    request: {
      userAttributes: { phone_number: '+15125551234' },
      privateChallengeParameters: storedOtp ? { otp: storedOtp } : {},
      challengeAnswer: userAnswer,
    } as any,
    response: {} as any,
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
});
