import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Sprint-20 requirements/proof-upload clarity hints (employer picker rows,
 * worker apply-flow cert rows, worker "What you'll need" panel).
 *
 * Same guard as `job-flow-i18n-keys.test.ts`, for this task's key batch:
 * the messages-parity test only catches a key present in ONE locale, so it
 * says nothing when a path is typo'd or never added in EITHER. Every hint
 * below is selected by a pure helper in `lib/job-requirements.ts`
 * (`certificationHintKey`, `docHintKey`, `workerCertNoteKey`,
 * `whatYouNeedHintKey`) -- a missing value there surfaces as a raw key path
 * inside a sentence explaining an application requirement, which is exactly
 * the confusion this task exists to remove.
 *
 * Deliberately a NEW file rather than an extension of
 * `job-flow-i18n-keys.test.ts`: that list is the record of what the job-flow
 * redesign task added, and mixing batches would blur which task owns which
 * key.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "job_requirements.picker.doc_hint_required") against a message tree. */
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

/** Full list of key paths added for the requirements-hints task. */
const ADDED_KEY_PATHS = [
    // job_requirements.picker — employer-side, per-row "what this does to
    // applicants" hints (certificationHintKey / docHintKey).
    'job_requirements.picker.cert_hint_required_proof',
    'job_requirements.picker.cert_hint_required_attest',
    'job_requirements.picker.cert_hint_optional',
    'job_requirements.picker.doc_hint_required',
    'job_requirements.picker.doc_hint_optional',

    // worker_job_detail.apply_flow — named-cert claim rows (workerCertNoteKey).
    'worker_job_detail.apply_flow.cert_attest_note',
    'worker_job_detail.apply_flow.cert_proof_note',

    // worker_job_detail.what_you_need — second line on each doc/cert row of
    // the pre-apply panel, reused by the apply flow's document rows
    // (whatYouNeedHintKey).
    'worker_job_detail.what_you_need.hint_doc_required',
    'worker_job_detail.what_you_need.hint_doc_optional',
    'worker_job_detail.what_you_need.hint_cert_required_proof',
    'worker_job_detail.what_you_need.hint_cert_required_attest',
    'worker_job_detail.what_you_need.hint_cert_optional',
] as const;

describe('requirements-hints i18n keys', () => {
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
});
