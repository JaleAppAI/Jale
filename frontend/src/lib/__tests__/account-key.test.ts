import { describe, expect, it } from 'vitest';
import { accountKeyFromIdToken, accountScopedKey } from '@/lib/account-key';

/**
 * Browser storage is per browser, not per account, so anything remembered
 * about "this employer" has to carry the employer. This module is where that
 * identity comes from -- and every way of NOT having one has to end in null,
 * because the callers read null as "do not read and do not write" and an
 * unscoped fallback is the bug the scoping exists to remove.
 */

function idTokenFor(payload: Record<string, unknown>): string {
    const body = btoa(JSON.stringify(payload))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `header.${body}.signature`;
}

describe('accountKeyFromIdToken', () => {
    it('reads the subject out of an id token', () => {
        expect(accountKeyFromIdToken(idTokenFor({ sub: 'b1f2c3d4-0000-4aaa-9bbb-000000000001' })))
            .toBe('b1f2c3d4-0000-4aaa-9bbb-000000000001');
    });

    it('tells two accounts apart', () => {
        const first = accountKeyFromIdToken(idTokenFor({ sub: 'account-one' }));
        const second = accountKeyFromIdToken(idTokenFor({ sub: 'account-two' }));
        expect(first).not.toBe(second);
    });

    it('decodes a payload that is not pure ASCII', () => {
        // A real Cognito payload carries the account's name and email beside
        // the subject; latin-1 bytes would corrupt the JSON before it parses.
        expect(accountKeyFromIdToken(idTokenFor({ sub: 'acct-9', name: 'Construcción Ramírez' })))
            .toBe('acct-9');
    });

    it.each([
        ['no token', null],
        ['an empty token', ''],
        ['a token with no payload segment', 'not-a-jwt'],
        ['a payload that is not JSON', 'header.bm90LWpzb24.signature'],
    ])('returns null for %s', (_label, token) => {
        expect(accountKeyFromIdToken(token)).toBeNull();
    });

    it('returns null when the payload has no usable subject', () => {
        expect(accountKeyFromIdToken(idTokenFor({ email: 'someone@example.com' }))).toBeNull();
        expect(accountKeyFromIdToken(idTokenFor({ sub: '' }))).toBeNull();
        expect(accountKeyFromIdToken(idTokenFor({ sub: 42 }))).toBeNull();
    });

    it('strips anything that has no business in a storage key', () => {
        expect(accountKeyFromIdToken(idTokenFor({ sub: 'a/b c.d' }))).toBe('abcd');
        // And a subject made ENTIRELY of those is no identity at all.
        expect(accountKeyFromIdToken(idTokenFor({ sub: '///' }))).toBeNull();
    });
});

describe('accountScopedKey', () => {
    it('keeps the base key readable in storage', () => {
        expect(accountScopedKey('jale.employer.hero_seen', 'acct-1'))
            .toBe('jale.employer.hero_seen.acct-1');
    });
});
