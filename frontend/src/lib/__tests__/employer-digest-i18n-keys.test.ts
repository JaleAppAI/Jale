import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { DIGEST_TIMEZONES, digestTimezoneLabelKey } from '../employer-digest-form';

/**
 * Same guard as `job-flow-i18n-keys.test.ts`, for the employer digest
 * settings panel and the public unsubscribe page.
 *
 * `messages-parity.test.ts` only catches a key present in ONE locale and
 * missing from the other — it says nothing when a key is missing from BOTH
 * (a typo'd path, or a key that was planned and never added). This enumerates
 * every path this task adds and resolves each one against both trees.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "employer.digest.title") against a message tree. */
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

/** Full list of key paths added for the employer digest settings task. */
const ADDED_KEY_PATHS = [
    // employer.digest — the Notifications panel on /employer/profile
    'employer.digest.title',
    'employer.digest.description',
    'employer.digest.toggle_aria',
    'employer.digest.state_on',
    'employer.digest.state_off',
    'employer.digest.hour_label',
    'employer.digest.hour_hint',
    'employer.digest.timezone_label',
    'employer.digest.language_label',
    'employer.digest.language_hint',
    'employer.digest.language_group_aria',
    'employer.digest.language_option.en',
    'employer.digest.language_option.es',
    'employer.digest.load_error',
    'employer.digest.save_error',

    // employer.digest.timezones — one label per curated canonical zone
    'employer.digest.timezones.america_new_york',
    'employer.digest.timezones.america_chicago',
    'employer.digest.timezones.america_denver',
    'employer.digest.timezones.america_phoenix',
    'employer.digest.timezones.america_los_angeles',
    'employer.digest.timezones.america_anchorage',
    'employer.digest.timezones.pacific_honolulu',
    'employer.digest.timezones.america_mexico_city',
    'employer.digest.timezones.america_puerto_rico',

    // digest_unsubscribe — the public one-click-unsubscribe landing page
    'digest_unsubscribe.title',
    'digest_unsubscribe.body',
    'digest_unsubscribe.button',
    'digest_unsubscribe.success_title',
    'digest_unsubscribe.success_body',
    'digest_unsubscribe.success_settings_hint',
    'digest_unsubscribe.error_title',
    'digest_unsubscribe.error_body',
] as const;

describe('employer digest i18n keys', () => {
    it('has a non-empty en.json value for every added key path', () => {
        const missing = ADDED_KEY_PATHS.filter((path) => {
            const value = resolve(en as MessageNode, path);
            return typeof value !== 'string' || value.trim() === '';
        });
        expect(missing).toEqual([]);
    });

    it('has a non-empty es.json value for every added key path', () => {
        const missing = ADDED_KEY_PATHS.filter((path) => {
            const value = resolve(es as MessageNode, path);
            return typeof value !== 'string' || value.trim() === '';
        });
        expect(missing).toEqual([]);
    });

    it('has a timezone label for every zone the picker can offer', () => {
        // Ties the message catalogue to the curated constant rather than to
        // the hand-written list above: adding a tenth zone to
        // `DIGEST_TIMEZONES` without a label would otherwise render the raw
        // IANA id to the employer and pass every other test here.
        const missing: string[] = [];
        for (const zone of DIGEST_TIMEZONES) {
            const segment = digestTimezoneLabelKey(zone);
            expect(segment).not.toBeNull();
            const path = `employer.digest.timezones.${segment}`;
            for (const [locale, tree] of [['en', en], ['es', es]] as const) {
                const value = resolve(tree as MessageNode, path);
                if (typeof value !== 'string' || value.trim() === '') {
                    missing.push(`${locale}:${path}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});
