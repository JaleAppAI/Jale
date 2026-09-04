import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Sprint-23 EMPLOYER-side application-stage copy: the pre-application prompts
 * editor, the requirements picker's re-voiced sentences, the applicant card's
 * details indicator / own-words box / Request details button, and the worker
 * detail page's hire gate.
 *
 * A deliberately NEW file rather than an extension of
 * `application-stages-i18n-keys.test.ts` (wave 1's vocabulary) or of the
 * worker lane's own list -- same reasoning `requirements-hints-i18n-keys.test.ts`
 * states in its own header: mixing batches blurs which task owns which key,
 * and these two lanes' catalogue edits are merged separately.
 *
 * `messages-parity` only catches a key present in ONE locale. It says nothing
 * about a path missing from BOTH, which is what a typo or a rename looks like.
 */

type MessageNode = string | { [key: string]: MessageNode };

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

const ADDED_KEY_PATHS = [
    // job_requirements.prompts -- the whole PreApplicationPromptsEditor.
    'job_requirements.prompts.section_title',
    'job_requirements.prompts.section_subtitle',
    'job_requirements.prompts.empty',
    'job_requirements.prompts.add',
    'job_requirements.prompts.question_number',
    'job_requirements.prompts.placeholder',
    'job_requirements.prompts.counter',
    'job_requirements.prompts.move_up',
    'job_requirements.prompts.move_down',
    'job_requirements.prompts.remove',
    'job_requirements.prompts.move_up_aria',
    'job_requirements.prompts.move_down_aria',
    'job_requirements.prompts.remove_aria',
    'job_requirements.prompts.tip',
    'job_requirements.prompts.tip_warning',
    'job_requirements.prompts.locked_title',
    'job_requirements.prompts.locked_hint',
    'job_requirements.prompts.validation_blank',
    'job_requirements.prompts.validation_too_long',
    'job_requirements.prompts.invalid_rejected',
    'job_requirements.prompts.locked_rejected',

    // The one new picker line. The RE-VOICED keys (rule_line, doc_hint_*,
    // cert_hint_*) keep their paths on purpose so
    // `requirements-hints-i18n-keys.test.ts` still holds -- see the wording
    // assertions at the bottom of this file for what actually changed.
    'job_requirements.picker.after_request_note',

    // The applicant card.
    'employer_job_listing.applicants.request_details',
    'employer_job_listing.applicants.request_details_sent',
    'employer_job_listing.applicants.details.not_requested',
    'employer_job_listing.applicants.details.requested',
    'employer_job_listing.applicants.details.requested_no_count',
    'employer_job_listing.applicants.details.complete',
    'employer_job_listing.applicants.own_words.title',
    'employer_job_listing.applicants.own_words.question_removed',

    // The worker detail page's hire gate.
    'employer_worker_profile.hire_option_blocked',
    'employer_worker_profile.hire_blocked_not_requested',
    'employer_worker_profile.hire_blocked_requested',
    'employer_worker_profile.hire_blocked_requested_no_count',
    'employer_worker_profile.prompt_answers_title',
    'employer_worker_profile.prompt_answers_question_removed',
    'employer_worker_profile.details_incomplete_title',
    'employer_worker_profile.details_incomplete_fields',
    'employer_worker_profile.details_incomplete_docs',
    'employer_worker_profile.details_incomplete_certifications',

    // ── Sprint 24 ────────────────────────────────────────────────
    // B7: the details button is now the ONLY control that sends the stage
    // notification, so it also has to say what happened. Added to THIS file
    // rather than a new per-batch one -- these paths sit inside the same two
    // namespaces this suite already owns, and the copy they replace
    // (`request_details_sent`, still listed above as the fail-open fallback)
    // is pinned here too.
    'employer_job_listing.applicants.request_details_resend',
    'employer_job_listing.applicants.request_details_notified',
    'employer_job_listing.applicants.request_details_no_whatsapp',
    'employer_job_listing.applicants.request_details_unchanged',

    // B8: the cross-job applicants overview row's skill-overflow toggle.
    'employer_applicants.skills_show_all',
    'employer_applicants.skills_show_fewer',
] as const;

describe('employer application-stage i18n keys', () => {
    it.each(['en', 'es'] as const)('has a non-empty %s value for every added key path', (locale) => {
        const tree = (locale === 'en' ? en : es) as MessageNode;
        const missing = ADDED_KEY_PATHS.filter((path) => {
            const value = resolve(tree, path);
            return typeof value !== 'string' || value.trim() === '';
        });
        expect(missing).toEqual([]);
    });

    /**
     * The re-voicing is the half `messages-parity` and the hints key test are
     * both blind to: every path already existed and stayed non-empty, so an
     * English-only rewrite would ship a bilingual mismatch silently. These pin
     * that BOTH trees moved off the apply-time voice.
     */
    it.each([
        'job_requirements.picker.rule_line',
        'job_requirements.picker.doc_hint_required',
        'job_requirements.picker.doc_hint_optional',
        'job_requirements.picker.cert_hint_required_proof',
        'job_requirements.picker.cert_hint_required_attest',
        'job_requirements.picker.cert_hint_optional',
    ])('re-voices %s to the request-details moment in both locales', (path) => {
        expect(resolve(en as MessageNode, path)).toContain('when you request details');
        expect(resolve(es as MessageNode, path)).toContain('cuando usted solicite los datos');
    });

    /**
     * The two outcome sentences name the worker, and the no-WhatsApp one must
     * say that nothing was sent -- that is the entire point of B7. A
     * placeholder dropped in translation would turn an honest report into a
     * sentence about nobody.
     */
    it.each([
        'employer_job_listing.applicants.request_details_notified',
        'employer_job_listing.applicants.request_details_no_whatsapp',
    ])('interpolates the worker name into %s in both locales', (path) => {
        expect(resolve(en as MessageNode, path)).toContain('{name}');
        expect(resolve(es as MessageNode, path)).toContain('{name}');
    });

    it('keeps the picker hint paths the sprint-20 hints test pins', () => {
        // Belt and braces: the re-voicing above must never be done by renaming.
        for (const tree of [en, es] as MessageNode[]) {
            expect(resolve(tree, 'job_requirements.picker.doc_hint_required')).toBeTruthy();
            expect(resolve(tree, 'job_requirements.picker.cert_hint_optional')).toBeTruthy();
        }
    });
});
