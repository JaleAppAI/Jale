import type { CustomMessageTriggerEvent } from 'aws-lambda';

import { KILL_SWITCH_ENV, handler } from '../../../../lambda/auth/employer-custom-message';
import * as template from '../../../../lambda/lib/employer-code-email-template';

/**
 * The handler's whole job is to fail OPEN: Cognito rejects the entire SignUp /
 * ForgotPassword API call with InvalidLambdaResponseException if emailMessage
 * loses the {####} placeholder or overruns 20 000 chars, so every doubt has to
 * end with the event returned untouched and Cognito's default email sent.
 *
 * The other invariant under test is the PII rule: event.userName IS the
 * employer's email address, and codeParameter / the rendered body are secrets.
 * None of the three may ever reach CloudWatch.
 *
 * jest.spyOn on the template module works here because tsconfig sets
 * module: commonjs — ts-jest emits a writable `exports.renderEmployerCodeEmail`
 * and compiles the handler's call site to a property lookup resolved at call
 * time. No jest.mock/requireActual factory is needed.
 */

const EMPLOYER_EMAIL = 'employer@example.com';
const PLACEHOLDER = '{####}';

type TriggerSource = CustomMessageTriggerEvent['triggerSource'];

function baseEvent(
  triggerSource: string,
  overrides: { request?: Record<string, unknown> } = {},
): CustomMessageTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_employer',
    // Cognito sets userName to the sign-in alias, which for the employer pool
    // is the email address. Never log it.
    userName: EMPLOYER_EMAIL,
    callerContext: { awsSdkVersion: '3', clientId: 'employer-web' },
    triggerSource: triggerSource as TriggerSource,
    request: {
      userAttributes: {
        email: EMPLOYER_EMAIL,
        'custom:user_type': 'employer',
      },
      codeParameter: PLACEHOLDER,
      linkParameter: '{##Click Here##}',
      usernameParameter: null,
      clientMetadata: {},
      ...overrides.request,
    } as any,
    response: {
      smsMessage: null,
      emailMessage: null,
      emailSubject: null,
    } as any,
  } as CustomMessageTriggerEvent;
}

const clone = (event: CustomMessageTriggerEvent) => JSON.parse(JSON.stringify(event));

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  // `= undefined` would store the STRING "undefined" and leak into later tests.
  delete process.env[KILL_SWITCH_ENV];
});

describe('employer-custom-message — branded path', () => {
  it('brands the SignUp email and leaves the request untouched', async () => {
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result.response.emailSubject).toBe(
      'Your Jale code: confirm your account · Confirme su cuenta de Jale',
    );
    expect(result.response.emailMessage).toContain('<!DOCTYPE html>');
    expect(result.response.emailMessage?.split(PLACEHOLDER)).toHaveLength(2);
    // The employer pool has no SMS channel; the trigger must not invent one.
    expect(result.response.smsMessage).toBeNull();
    // Compared against a pre-call clone, because result === event makes a
    // result-vs-event comparison vacuous.
    expect(result.request).toEqual(before.request);
  });

  it('brands the ResendCode email', async () => {
    const result = await handler(baseEvent('CustomMessage_ResendCode'));

    expect(result.response.emailSubject).toBe('Your new Jale code · Su nuevo código de Jale');
    expect(result.response.emailMessage).toContain('Here is your new code');
  });

  it('brands the ForgotPassword email with the shorter expiry', async () => {
    const result = await handler(baseEvent('CustomMessage_ForgotPassword'));

    expect(result.response.emailSubject).toBe(
      'Your Jale code: reset your password · Restablezca su contraseña de Jale',
    );
    expect(result.response.emailMessage).toContain('Expires in 1 hour · Vence en 1 hora');
    expect(result.response.emailMessage).not.toContain('Expires in 24 hours');
  });

  it.each(['CustomMessage_UpdateUserAttribute', 'CustomMessage_VerifyUserAttribute'])(
    '%s gets the neutral verification subject',
    async (source) => {
      const result = await handler(baseEvent(source));

      expect(result.response.emailSubject).toBe('Your Jale code · Su código de Jale');
      expect(result.response.emailMessage).toContain('Your Jale verification code');
    },
  );

  it('preserves non-ASCII in the subject it hands back to Cognito', async () => {
    const result = await handler(baseEvent('CustomMessage_ResendCode'));

    expect(result.response.emailSubject).toContain('ó');
  });

  it('logs nothing at all on the happy path', async () => {
    await handler(baseEvent('CustomMessage_SignUp'));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ignores usernameParameter — no {username} may reach the body', async () => {
    const result = await handler(
      baseEvent('CustomMessage_SignUp', { request: { usernameParameter: 'someone' } }),
    );

    expect(result.response.emailMessage).not.toContain('{username}');
    expect(result.response.emailMessage).not.toContain('someone');
  });

  it('ignores clientMetadata locale — v1 is bilingual in one body', async () => {
    const withLocale = await handler(
      baseEvent('CustomMessage_SignUp', { request: { clientMetadata: { locale: 'es' } } }),
    );
    const withoutLocale = await handler(baseEvent('CustomMessage_SignUp'));

    expect(withLocale.response.emailMessage).toBe(withoutLocale.response.emailMessage);
    expect(withLocale.response.emailSubject).toBe(withoutLocale.response.emailSubject);
  });
});

describe('employer-custom-message — sources this trigger does not own', () => {
  it.each([
    'CustomMessage_AdminCreateUser',
    'CustomMessage_Authentication',
    'CustomMessage_SomethingCognitoAddedLater',
  ])('%s falls through to the Cognito default untouched', async (source) => {
    const event = baseEvent(source);
    const before = clone(event);

    const result = await handler(event);

    expect(result).toBe(event);
    expect(result).toEqual(before);
    expect(result.response.emailSubject).toBeNull();
    expect(result.response.emailMessage).toBeNull();
    expect(result.response.smsMessage).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('employer-custom-message — fail-open guards', () => {
  it('falls open when the renderer throws', async () => {
    jest.spyOn(template, 'renderEmployerCodeEmail').mockImplementation(() => {
      throw new Error('boom');
    });
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result).toEqual(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('CustomMessage_SignUp');
    expect(logged).toContain('boom');
    // The three things that must never reach CloudWatch.
    expect(logged).not.toContain(EMPLOYER_EMAIL);
    expect(logged).not.toContain(PLACEHOLDER);
    expect(logged).not.toContain('<html');
  });

  it('falls open when the rendered body lost the code placeholder', async () => {
    jest.spyOn(template, 'renderEmployerCodeEmail').mockReturnValue({
      subject: 'Your Jale code · Su código de Jale',
      html: '<!DOCTYPE html><html lang="en"><body>no code here</body></html>',
    });
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result).toEqual(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('<html');
  });

  it('falls open when the rendered body duplicates the code placeholder', async () => {
    jest.spyOn(template, 'renderEmployerCodeEmail').mockReturnValue({
      subject: 'Your Jale code · Su código de Jale',
      html: `<b>${PLACEHOLDER}</b><i>${PLACEHOLDER}</i>`,
    });
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result).toEqual(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls open when the rendered body overruns the Cognito hard cap', async () => {
    const oversized = PLACEHOLDER + 'x'.repeat(template.CODE_EMAIL_MAX_CHARS + 1 - PLACEHOLDER.length);
    expect(oversized).toHaveLength(20001);
    jest.spyOn(template, 'renderEmployerCodeEmail').mockReturnValue({
      subject: 'Your Jale code · Su código de Jale',
      html: oversized,
    });
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result).toEqual(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('20001');
    expect(logged).not.toContain(PLACEHOLDER);
  });

  it('falls open when codeParameter is missing', async () => {
    const event = baseEvent('CustomMessage_SignUp', { request: { codeParameter: undefined } });
    const before = clone(event);

    const result = await handler(event);

    expect(result).toEqual(before);
    expect(result.response.emailMessage).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(EMPLOYER_EMAIL);
  });

  it('falls open when codeParameter is an empty string', async () => {
    const event = baseEvent('CustomMessage_SignUp', { request: { codeParameter: '' } });

    const result = await handler(event);

    expect(result.response.emailMessage).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls open when the whole request object is missing', async () => {
    const event = baseEvent('CustomMessage_SignUp');
    delete (event as any).request;

    const result = await handler(event);

    expect(result.response.emailMessage).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('employer-custom-message — kill switch', () => {
  it('hands Cognito its default template when the switch is on', async () => {
    process.env[KILL_SWITCH_ENV] = 'true';
    const renderSpy = jest.spyOn(template, 'renderEmployerCodeEmail');
    const event = baseEvent('CustomMessage_SignUp');
    const before = clone(event);

    const result = await handler(event);

    expect(result).toBe(event);
    expect(result).toEqual(before);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays branded for any other value of the switch', async () => {
    process.env[KILL_SWITCH_ENV] = 'false';

    const result = await handler(baseEvent('CustomMessage_SignUp'));

    expect(result.response.emailSubject).toContain('Confirme su cuenta de Jale');
  });
});
