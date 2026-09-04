import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * English strings sitting in the SPANISH catalogue.
 *
 * `messages-parity.test.ts` compares key SETS, so a Spanish value that is
 * simply the English sentence copied across passes it: the key exists in both
 * files. This is the other half -- the paths reported by the owner after the
 * 2026-09-03 release, asserted to differ from their English counterparts.
 *
 * Equality-based on purpose, and deliberately NOT applied catalogue-wide:
 * plenty of paths are legitimately identical in both locales (brand names,
 * "OSHA 10", "WhatsApp", numeric formats), so a blanket sweep would be noise.
 * This is a named list that grows when a leak is found.
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

/**
 * Paths whose Spanish value must not be the English one.
 *
 * Two groups. The first four are the reported leaks. The rest are strings this
 * change ADDED whose only other coverage is a mock assertion or an error path
 * a component test never reaches -- `messages-parity.test.ts` would notice a
 * key missing from one catalogue, but a copy-pasted English value passes it,
 * and nothing else renders these.
 */
const MUST_BE_TRANSLATED = [
    'employer_dashboard.panels.job_progress_title',
    'employer_dashboard.panels.time_to_fill_title',
    'employer_dashboard.disabled.label',
    'employer_dashboard.disabled.preview',
    'employer_dashboard.jobs.status_change.resume_success',
    'employer_dashboard.jobs.status_change.error_generic',
    'billing.limit_dialog.body_jobs_preflight',
] as const;

describe('employer dashboard Spanish copy', () => {
    it('resolves every listed path in both catalogues', () => {
        const missing = MUST_BE_TRANSLATED.filter((path) => {
            const enValue = resolve(en as MessageNode, path);
            const esValue = resolve(es as MessageNode, path);
            return typeof enValue !== 'string' || typeof esValue !== 'string';
        });
        expect(missing).toEqual([]);
    });

    it('carries a Spanish value, not the English string, for every listed path', () => {
        const leaked = MUST_BE_TRANSLATED.filter(
            (path) => resolve(es as MessageNode, path) === resolve(en as MessageNode, path),
        );
        expect(leaked).toEqual([]);
    });
});
