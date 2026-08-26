import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Employer auth recovery (resend confirmation code, unconfirmed sign-in
 * routing) adds a batch of message keys. `messages-parity.test.ts` only
 * catches a key present in ONE locale and missing from the other — it stays
 * green when a key is missing from BOTH, which is exactly what a typo'd path
 * or a forgotten key looks like.
 *
 * `errors.account_not_confirmed` is the reason this matters here: `authErrorKey`
 * is shared with `WorkerAuthForm`, so the key has to exist under
 * `auth.worker.errors` as well as `auth.employer.errors`. Adding it to only the
 * employer namespace would leave a worker on either locale staring at a raw key
 * path, and parity alone would never notice.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "auth.employer.resend_code") against a message tree. */
function resolve(tree: MessageNode, path: string): string | undefined {
    const segments = path.split('.');
    let node: MessageNode = tree;
    for (const segment of segments) {
        if (typeof node === 'string') return undefined;
        if (!(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

/** Full list of key paths added for the employer auth-recovery task. */
const ADDED_KEY_PATHS = [
    // auth.employer — resend affordance on the confirm step
    'auth.employer.resend_code',
    'auth.employer.resend_cooldown',
    'auth.employer.code_sent',
    'auth.employer.check_spam',

    // auth.employer — confirm step shows which address the code went to
    // (ported from PR #49's version of the resend feature)
    'auth.employer.confirm_subtitle',

    // auth.employer — recovery-origin confirm step heading
    'auth.employer.recovery_title',
    'auth.employer.recovery_subtitle',

    // auth.employer — always-available entry point from login / forgot-password
    'auth.employer.never_received_code',

    // auth.employer — acknowledgement after a recovery confirm with no password
    'auth.employer.confirmed_sign_in',

    // auth.employer.errors — resend call-site mapping
    'auth.employer.errors.account_not_confirmed',
    'auth.employer.errors.already_confirmed',
    'auth.employer.errors.resend_limit',
    'auth.employer.errors.code_delivery_failed',

    // auth.employer.errors — confirm succeeded but the sign-in behind it did
    // not, so the confirmed banner and this sentence are shown together
    'auth.employer.errors.confirmed_sign_in_failed',

    // auth.worker.errors — authErrorKey is shared with WorkerAuthForm
    'auth.worker.errors.account_not_confirmed',
] as const;

/**
 * Keys whose copy carries an ICU placeholder. next-intl throws at render time
 * when a translation references a variable the caller never passed, and a
 * locale that quietly dropped the placeholder renders a sentence with a hole
 * in it. Both are invisible to a plain presence check.
 */
const REQUIRED_PLACEHOLDERS: Record<string, readonly string[]> = {
    'auth.employer.resend_cooldown': ['{seconds}'],
    'auth.employer.code_sent': ['{email}'],
};

describe('auth-recovery i18n keys', () => {
    for (const [locale, tree] of [
        ['en', en],
        ['es', es],
    ] as const) {
        it(`has a non-empty ${locale}.json value for every added key path`, () => {
            const missing = ADDED_KEY_PATHS.filter((path) => {
                const value = resolve(tree as MessageNode, path);
                return typeof value !== 'string' || value.trim() === '';
            });
            expect(missing).toEqual([]);
        });

        it(`keeps every ICU placeholder in ${locale}.json`, () => {
            const broken: string[] = [];
            for (const [path, placeholders] of Object.entries(REQUIRED_PLACEHOLDERS)) {
                const value = resolve(tree as MessageNode, path);
                for (const placeholder of placeholders) {
                    if (typeof value !== 'string' || !value.includes(placeholder)) {
                        broken.push(`${path} is missing ${placeholder}`);
                    }
                }
            }
            expect(broken).toEqual([]);
        });
    }

    /**
     * The employer namespace is formal usted; the worker namespace is informal
     * tu. Nothing enforces that mechanically, but the one key that lands in
     * both must not be copy-pasted between them, because the registers differ.
     */
    it('does not reuse the same Spanish sentence across the two registers', () => {
        const employer = resolve(es as MessageNode, 'auth.employer.errors.account_not_confirmed');
        const worker = resolve(es as MessageNode, 'auth.worker.errors.account_not_confirmed');
        expect(employer).toBeTypeOf('string');
        expect(worker).toBeTypeOf('string');
        expect(worker).not.toBe(employer);
    });
});
