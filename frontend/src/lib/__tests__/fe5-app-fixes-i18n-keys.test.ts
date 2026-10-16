import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Sprint 28 lane FE-5 copy. `messages-parity.test.ts` only catches a key that
 * exists in ONE locale; a key missing from BOTH (a typo'd path, a forgotten
 * key) passes it. This list names every key the lane adds or rewords, so a
 * missing or empty one fails here with its path.
 *
 * Each FE-5 task appends its own keys. The hand-off's copy table for review is
 * generated from this file (see the lane plan, Task 17).
 */

type MessageNode = string | { [key: string]: MessageNode };

function resolve(tree: MessageNode, path: string): string | undefined {
    let node: MessageNode = tree;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

/** New keys, in the order the tasks add them. */
export const ADDED_KEY_PATHS: readonly string[] = [
    // Task 4 (item 6): the drawer's row for an applicant with no thread yet.
    'employer_messages.drawer_new_conversation',
    // Task 5 (F27): the worker Applications badge, as a screen reader hears it.
    'app_shell.applications_attention_badge',
    // Task 7 (F4): a reset code cannot reach this account.
    'auth.employer.errors.reset_unavailable',
    // Task 9 (F19): the worker's hired card.
    'worker_application_details.hired_card.details_intro',
    'worker_application_details.hired_card.details_intro_no_company',
    'worker_application_details.hired_card.start_date',
    'worker_application_details.hired_card.start_date_tbc',
    'worker_application_details.hired_card.report_location',
    'worker_application_details.hired_card.contact',
    'worker_application_details.hired_card.notes',
    'worker_application_details.hired_card.remind',
    'worker_application_details.hired_card.remind_sent',
    'worker_application_details.hired_card.remind_recent',
    'worker_application_details.hired_card.remind_wait',
    'worker_application_details.hired_card.message_label',
    'worker_application_details.hired_card.message_hint',
    'worker_application_details.hired_card.message_placeholder',
    'worker_application_details.hired_card.message_count',
    'worker_application_details.hired_card.message_send',
    'worker_application_details.hired_card.message_sent_at',
    'worker_application_details.hired_card.message_empty',
    'worker_application_details.hired_card.message_too_long',
    'worker_application_details.hired_card.message_invalid',
    'worker_application_details.hired_card.message_rate_limited',
    'worker_application_details.hired_card.not_hired',
    // Task 10 (F19): hire banner and celebration once details exist.
    'worker_applications.hired_celebration.banner.body_details_dated',
    'worker_applications.hired_celebration.banner.body_details_undated',
    'worker_applications.hired_celebration.row.body_details',
    'worker_applications.hired_celebration.modal.body_details',
    // Task 11 (F19): the employer's start-details form and banner.
    'employer_applicants.hire_details.add',
    'employer_applicants.hire_details.edit',
    'employer_applicants.hire_details.needed',
    'employer_applicants.hire_details.summary_starts',
    'employer_applicants.hire_details.summary_location',
    'employer_applicants.hire_details.summary_saved',
    'employer_applicants.hire_details.title',
    'employer_applicants.hire_details.intro',
    'employer_applicants.hire_details.start_date',
    'employer_applicants.hire_details.report_location',
    'employer_applicants.hire_details.report_location_placeholder',
    'employer_applicants.hire_details.contact_name',
    'employer_applicants.hire_details.contact_phone',
    'employer_applicants.hire_details.contact_phone_hint',
    'employer_applicants.hire_details.notes',
    'employer_applicants.hire_details.notes_placeholder',
    'employer_applicants.hire_details.save',
    'employer_applicants.hire_details.cancel',
    'employer_applicants.hire_details.saved',
    'employer_applicants.hire_details.error_date',
    'employer_applicants.hire_details.error_too_long',
    'employer_applicants.hire_details.error_phone',
    'employer_applicants.hire_details.error_field',
    'employer_applicants.hire_details.error_not_hired',
    'employer_applicants.hire_details.error_not_found',
    'employer_applicants.hire_details.banner',
    'employer_applicants.hire_details.banner_cta',
];

/** Existing keys whose wording changes, with the exact new text. */
export const CHANGED_VALUES: Readonly<Record<string, { en: string; es: string }>> = {
    // Item 1 (Q-2 default): the retry copy for a refresh outage and every
    // other offline failure.
    'common.errors.offline': {
        en: "We couldn't reach Jale. Check your connection and try again.",
        es: 'No pudimos conectar con Jale. Revise su conexión e intente de nuevo.',
    },
};

describe('FE-5 copy', () => {
    it('has every added key, non-empty, in en and es', () => {
        const missing = ADDED_KEY_PATHS.flatMap((path) => [
            ...(resolve(en as MessageNode, path)?.trim() ? [] : [`en:${path}`]),
            ...(resolve(es as MessageNode, path)?.trim() ? [] : [`es:${path}`]),
        ]);
        expect(missing).toEqual([]);
    });

    it.each(Object.entries(CHANGED_VALUES))('rewords "%s" in both locales', (path, expected) => {
        expect(resolve(en as MessageNode, path)).toBe(expected.en);
        expect(resolve(es as MessageNode, path)).toBe(expected.es);
    });

    it('lists no key twice', () => {
        expect(new Set(ADDED_KEY_PATHS).size).toBe(ADDED_KEY_PATHS.length);
    });
});
