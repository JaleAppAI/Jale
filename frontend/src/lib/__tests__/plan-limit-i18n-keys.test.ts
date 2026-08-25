import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Same guard as `employer-digest-i18n-keys.test.ts`, for the plan-limit
 * dialog, the plan signage banners, and the dashboard usage counters.
 *
 * `messages-parity.test.ts` only catches a key present in ONE locale and
 * missing from the other — it says nothing when a key is missing from BOTH
 * (a typo'd path, or a key that was planned and never added). This enumerates
 * every path this task adds and resolves each one against both trees.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "billing.limit_dialog.title") against a message tree. */
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

/** Full list of key paths added for the plan-limit copy task. */
const ADDED_KEY_PATHS = [
    // billing.limit_dialog — the blocking dialog shown when a plan limit is hit
    'billing.limit_dialog.title',
    'billing.limit_dialog.body_jobs',
    'billing.limit_dialog.body_jobs_zero',
    'billing.limit_dialog.body_templates',
    'billing.limit_dialog.body_templates_zero',
    'billing.limit_dialog.blocking_heading',
    'billing.limit_dialog.and_more',
    'billing.limit_dialog.hint_jobs',
    'billing.limit_dialog.hint_templates',
    'billing.limit_dialog.cta_upgrade',
    'billing.limit_dialog.cta_pause_job',
    'billing.limit_dialog.cta_manage_templates',
    'billing.limit_dialog.dismiss',

    // billing.signage — the standing free-plan / lapsed-subscription banners
    'billing.signage.free_title',
    'billing.signage.free_body',
    'billing.signage.free_cta',
    'billing.signage.lapsed_title',
    'billing.signage.lapsed_body',
    'billing.signage.lapsed_body_grace',
    'billing.signage.lapsed_cta',
    'billing.signage.lapsed_cta_grace',

    // employer_dashboard.usage — the used/limit counters on the dashboard
    'employer_dashboard.usage.jobs',
    'employer_dashboard.usage.templates',
    'employer_dashboard.usage.jobs_plain',
    'employer_dashboard.usage.view_plan',

    // employer_dashboard.modal — posting a job when the template slot is full
    'employer_dashboard.modal.template_not_saved',
    'employer_dashboard.modal.post_without_template',

    // employer_dashboard.jobs — the after-the-fact toast for that same case
    'employer_dashboard.jobs.template_not_saved_after_post',

    // employer_job_listing.actions — pausing a job to free an active slot
    'employer_job_listing.actions.pause',
    'employer_job_listing.actions.pause_pending',
    'employer_job_listing.actions.pause_success',
] as const;

/**
 * Keys that already existed but whose copy this task rewrites. The old strings
 * ("Mark active" / "Mark closed") described a status field; the new ones name
 * the action the employer is taking, and pair with the new `pause` action.
 */
const RECOPIED: ReadonlyArray<{ path: string; en: string; es: string }> = [
    {
        path: 'employer_job_listing.actions.activate',
        en: 'Resume job',
        es: 'Reanudar empleo',
    },
    {
        path: 'employer_job_listing.actions.close',
        en: 'Close job',
        es: 'Cerrar empleo',
    },
];

/**
 * Still rendered by the existing limit-reached path, so the new
 * `billing.limit_dialog.*` block must not be a rename of these.
 */
const STILL_CONSUMED = [
    'billing.limit_reached.modal_message',
    'billing.limit_reached.cta',
] as const;

describe('plan limit i18n keys', () => {
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

    it('uses the new action copy for the two recopied keys', () => {
        // Checked by value, not just presence: these keys already resolved to
        // the OLD strings, so a presence-only assertion would pass unchanged.
        const wrong: string[] = [];
        for (const entry of RECOPIED) {
            if (resolve(en as MessageNode, entry.path) !== entry.en) {
                wrong.push(`en:${entry.path}`);
            }
            if (resolve(es as MessageNode, entry.path) !== entry.es) {
                wrong.push(`es:${entry.path}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('keeps the limit_reached keys the existing modal still consumes', () => {
        const missing: string[] = [];
        for (const path of STILL_CONSUMED) {
            for (const [locale, tree] of [
                ['en', en],
                ['es', es],
            ] as const) {
                const value = resolve(tree as MessageNode, path);
                if (typeof value !== 'string' || value.trim() === '') {
                    missing.push(`${locale}:${path}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});
