import { describe, expect, it } from 'vitest';
import { authErrorKey, resendErrorKey } from '@/lib/auth-errors';

/**
 * `authErrorKey` is the single place where a Cognito failure becomes a
 * sentence the user reads, and it had no coverage at all. Every branch is
 * pinned here, because a silently mis-mapped code is indistinguishable from a
 * working app until a real user is stuck on it.
 *
 * Both shapes are exercised: amazon-cognito-identity-js populates `code` on
 * the errors it surfaces from the service, but some paths only carry `name`,
 * and the mapper reads `code ?? name`.
 */

/** A Cognito-shaped error carrying `code` (the common case). */
const withCode = (code: string, message = '') => ({ code, message, name: code });
/** A Cognito-shaped error carrying only `name` (the fallback path). */
const withNameOnly = (name: string, message = '') => ({ name, message });

describe('authErrorKey', () => {
    it('maps an unconfirmed account to its own key instead of the generic failure', () => {
        expect(authErrorKey(withCode('UserNotConfirmedException'))).toBe('errors.account_not_confirmed');
    });

    it('maps an unconfirmed account when only `name` is set', () => {
        expect(authErrorKey(withNameOnly('UserNotConfirmedException'))).toBe('errors.account_not_confirmed');
    });

    it.each([
        ['UsernameExistsException', 'errors.account_exists'],
        ['InvalidPasswordException', 'errors.password_requirements'],
        ['CodeMismatchException', 'errors.invalid_code'],
        ['ExpiredCodeException', 'errors.expired_code'],
        ['LimitExceededException', 'errors.too_many_attempts'],
        ['TooManyRequestsException', 'errors.too_many_attempts'],
        ['UserNotFoundException', 'errors.account_not_found'],
        ['NotAuthorizedException', 'errors.invalid_credentials'],
    ])('maps %s to %s', (code, expected) => {
        expect(authErrorKey(withCode(code))).toBe(expected);
    });

    describe('InvalidParameterException', () => {
        it('reads the message to blame the phone field', () => {
            expect(authErrorKey(withCode('InvalidParameterException', 'Invalid phone number format')))
                .toBe('errors.invalid_phone');
        });

        it('reads the message to blame the email field', () => {
            expect(authErrorKey(withCode('InvalidParameterException', 'Invalid email address')))
                .toBe('errors.invalid_email');
        });

        it('reads the message to blame the password', () => {
            expect(authErrorKey(withCode('InvalidParameterException', 'Password did not conform')))
                .toBe('errors.password_requirements');
        });

        it('matches the message case-insensitively', () => {
            expect(authErrorKey(withCode('InvalidParameterException', 'Invalid PHONE number')))
                .toBe('errors.invalid_phone');
        });

        it('falls back to the generic signup message when the message names no field', () => {
            expect(authErrorKey(withCode('InvalidParameterException', 'Something else entirely')))
                .toBe('errors.invalid_signup');
        });

        it('falls back to the generic signup message when there is no message at all', () => {
            expect(authErrorKey({ code: 'InvalidParameterException' })).toBe('errors.invalid_signup');
        });
    });

    describe('inputs that are not Cognito errors', () => {
        it.each([
            ['an unknown code', withCode('SomeBrandNewException')],
            ['a plain Error', new Error('boom')],
            ['null', null],
            ['undefined', undefined],
            ['a string', 'boom'],
            ['an empty object', {}],
        ])('maps %s to the generic signup failure', (_label, input) => {
            expect(authErrorKey(input)).toBe('errors.signup_failed');
        });
    });
});

/**
 * The resend call re-uses Cognito codes with different meanings, so it needs
 * its own mapper rather than a widened `authErrorKey`. The two collisions that
 * matter: `NotAuthorizedException` means "wrong password" on sign-in but
 * "already confirmed" on a resend, and `LimitExceededException` needs the
 * resend-specific hour-long cap wording rather than the generic
 * "wait a few minutes".
 */
describe('resendErrorKey', () => {
    it.each([
        ['LimitExceededException', 'errors.resend_limit'],
        ['TooManyRequestsException', 'errors.resend_limit'],
    ])('maps %s to the resend-specific limit message', (code, expected) => {
        expect(resendErrorKey(withCode(code))).toBe(expected);
    });

    it.each([
        // Cognito returns either of these for a resend against an account that
        // is already confirmed, and which one is not contractual.
        ['InvalidParameterException', 'errors.already_confirmed'],
        ['NotAuthorizedException', 'errors.already_confirmed'],
    ])('maps %s to already-confirmed', (code, expected) => {
        expect(resendErrorKey(withCode(code))).toBe(expected);
    });

    it('does not sniff the message text when deciding already-confirmed', () => {
        // The generic mapper would call this `errors.invalid_email`; on a
        // resend the code alone decides, so the message must not steer it.
        expect(resendErrorKey(withCode('InvalidParameterException', 'Invalid email address')))
            .toBe('errors.already_confirmed');
    });

    it('maps a delivery failure to its own key', () => {
        expect(resendErrorKey(withCode('CodeDeliveryFailureException'))).toBe('errors.code_delivery_failed');
    });

    it('maps an already-confirmed error carrying only `name`', () => {
        expect(resendErrorKey(withNameOnly('NotAuthorizedException'))).toBe('errors.already_confirmed');
    });

    it.each([
        ['UserNotFoundException', 'errors.account_not_found'],
        ['CodeMismatchException', 'errors.invalid_code'],
    ])('defers to authErrorKey for unrelated code %s', (code, expected) => {
        expect(resendErrorKey(withCode(code))).toBe(expected);
    });

    it('defers to authErrorKey for an unknown code', () => {
        expect(resendErrorKey(withCode('SomeBrandNewException'))).toBe('errors.signup_failed');
    });

    it('defers to authErrorKey for a non-Cognito input', () => {
        expect(resendErrorKey(null)).toBe('errors.signup_failed');
    });
});
