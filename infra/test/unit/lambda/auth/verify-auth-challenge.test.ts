// ── Mocks (must come before the handler import) ─────────────────────────
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminUpdateUserAttributesCommand: jest.fn((args) => ({ input: args, __type: 'AdminUpdateUserAttributes' })),
}));

jest.mock('../../../../lambda/lib/db');

import { handler } from '../../../../lambda/auth/verify-auth-challenge';
import { getDbPool } from '../../../../lambda/lib/db';
import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('VerifyAuthChallenge Lambda', () => {
  const baseEvent = (
    storedOtp: string | undefined,
    userAnswer: string,
    userAttributes: Record<string, string> = { phone_number: '+15125551234', sub: 'worker-sub' },
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
    mockQuery.mockReset().mockResolvedValue({});
    mockRelease.mockReset();
    mockGetDbPool.mockReset().mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      }),
    });
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
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('skips the flip when the account is already verified', async () => {
    const result = await handler(baseEvent('123456', '123456', {
      phone_number: '+15125551234',
      phone_number_verified: 'true',
      sub: 'worker-sub',
    }));

    expect(result.response.answerCorrect).toBe(true);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('a flip failure never fails a correct login (best-effort)', async () => {
    mockCognitoSend.mockRejectedValueOnce(new Error('cognito hiccup'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await handler(baseEvent('123456', '123456'));

    expect(result.response.answerCorrect).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ── pending name promotion (migration 052) ────────────────────────────
  //
  // A name staged at signup (stage_worker_pending_name) is only ever
  // promoted into users.full_name on the first correct OTP — the same
  // event, and the same phone_number_verified gate, as the flip above.

  it('promotes the pending name on a correct answer when not yet verified', async () => {
    const result = await handler(baseEvent('123456', '123456', {
      phone_number: '+15125551234',
      sub: 'worker-sub',
    }));

    expect(result.response.answerCorrect).toBe(true);
    expect(mockGetDbPool).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith('SELECT promote_worker_pending_name($1)', ['worker-sub']);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('does not promote the pending name on a wrong answer', async () => {
    await handler(baseEvent('123456', '654321', {
      phone_number: '+15125551234',
      sub: 'worker-sub',
    }));

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not promote the pending name when already verified', async () => {
    await handler(baseEvent('123456', '123456', {
      phone_number: '+15125551234',
      phone_number_verified: 'true',
      sub: 'worker-sub',
    }));

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a database error during promotion never fails a correct login (best-effort)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT promote_worker_pending_name($1)') {
        throw new Error('db hiccup');
      }
      return {};
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await handler(baseEvent('123456', '123456', {
      phone_number: '+15125551234',
      sub: 'worker-sub',
    }));

    expect(result.response.answerCorrect).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
