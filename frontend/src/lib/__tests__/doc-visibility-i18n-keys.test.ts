import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { REQUIREMENT_DOC_KEYS } from '../job-requirements';

/**
 * Migration-074 doc-visibility batch: the worker vault's `work_auth_doc`
 * slot, and the apply flow's notice for a legacy `required_docs` entry that
 * has no upload path at all (`ssn`).
 *
 * Same guard as `requirements-hints-i18n-keys.test.ts`, and a new file for
 * the same reason: each list is the record of what ONE task added, and
 * `messages-parity.test.ts` only catches a key present in one locale and
 * missing from the other — it says nothing when a path is typo'd or was
 * never added in EITHER tree.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "worker_profile.documents.types.work_auth_doc") against a message tree. */
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

/** Full list of key paths added for the doc-visibility task. */
const ADDED_KEY_PATHS = [
    // The vault's third upload slot: the backend has accepted this doc_type
    // since migration 074 (canonical DOC_TYPES, infra/lambda/lib/job-fields.ts),
    // but the profile page offered no slot for it, so a job requiring it was
    // unsatisfiable from the web.
    'worker_profile.documents.types.work_auth_doc',

    // The apply flow's notice for a `required_docs` entry the app has no
    // upload path for (legacy 'ssn'). Those keys no longer block Continue, so
    // this sentence is the ONLY thing telling the worker the requirement is
    // real and handled off-platform.
    'worker_application_details.legacy_doc_notice',
] as const;

describe('doc visibility i18n keys', () => {
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

    it('has a job_requirements.docs label for every requirement doc key', () => {
        // Regression guard for the shared doc catalogue, which is now the
        // fallback BOTH the worker job card and the job detail page read when
        // a `required_docs` entry has no `doc_labels` entry of its own. A new
        // REQUIREMENT_DOC_KEYS member without a label here would reach the
        // worker as the raw enum string, which is the bug this task fixes.
        const missing: string[] = [];
        for (const key of REQUIREMENT_DOC_KEYS) {
            for (const [locale, tree] of [['en', en], ['es', es]] as const) {
                const path = `job_requirements.docs.${key}`;
                const value = resolve(tree as MessageNode, path);
                if (typeof value !== 'string' || value.trim() === '') {
                    missing.push(`${locale}:${path}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('names the legacy ssn requirement from the one shared doc catalogue', () => {
        // Was `worker_job_detail.doc_labels.ssn`. That namespace is gone: the
        // apply-flow notice, and every other reader, now goes through
        // `doc_types.*`, so this guards the key that actually feeds the
        // sentence rather than a duplicate nothing reads.
        for (const tree of [en, es]) {
            const value = resolve(tree as MessageNode, 'doc_types.ssn');
            expect(typeof value === 'string' && value.trim() !== '').toBe(true);
        }
    });
});
