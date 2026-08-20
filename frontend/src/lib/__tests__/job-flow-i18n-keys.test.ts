import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * The job-flow redesign (worker apply flow, employer post-job modal, public
 * SEO job page) introduces a batch of new message keys shared by both
 * locales. The messages-parity test only catches a key present in ONE
 * locale but missing from the other — it says nothing if a key is missing
 * from BOTH (e.g. a typo'd path, or a key that was planned but never added).
 *
 * This test enumerates every key path this task was scoped to add and
 * resolves each one against both locale trees, failing loudly (with the
 * exact path) if it's missing or empty in either.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path (e.g. "common.duration_bucket.lt_1w") against a message tree. */
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

/** Full list of key paths added for the job-flow i18n task. */
const ADDED_KEY_PATHS = [
    // common — duration bucket, shared by worker page + public SEO page
    'common.duration_bucket.lt_1w',
    'common.duration_bucket.1_2w',
    'common.duration_bucket.2_4w',
    'common.duration_bucket.1_3m',
    'common.duration_bucket.3_6m',
    'common.duration_bucket.6m_plus',
    'common.duration_bucket.ongoing',

    // common — work days, shared by worker page + public SEO page
    'common.work_days.mon',
    'common.work_days.tue',
    'common.work_days.wed',
    'common.work_days.thu',
    'common.work_days.fri',
    'common.work_days.sat',
    'common.work_days.sun',

    // employer_dashboard.modal — trade "other" capture
    'employer_dashboard.modal.trade_other_label',
    'employer_dashboard.modal.trade_other_placeholder',
    'employer_dashboard.modal.trade_other_hint',

    // employer_dashboard.modal — expected duration select
    'employer_dashboard.modal.expected_duration_select_placeholder',

    // employer_dashboard.modal — schedule (work days + shift start/end)
    'employer_dashboard.modal.schedule_days_label',
    'employer_dashboard.modal.schedule_days_hint',
    'employer_dashboard.modal.shift_start_label',
    'employer_dashboard.modal.shift_end_label',
    'employer_dashboard.modal.shift_to',

    // employer_dashboard.modal — required years of experience stepper
    'employer_dashboard.modal.experience_years_label',
    'employer_dashboard.modal.experience_none',
    'employer_dashboard.modal.experience_years',
    'employer_dashboard.modal.experience_decrement_aria',
    'employer_dashboard.modal.experience_increment_aria',

    // employer_dashboard.modal — certifications picker
    'employer_dashboard.modal.certifications_search_placeholder',
    'employer_dashboard.modal.certifications_add_custom',
    'employer_dashboard.modal.certifications_no_matches',
    'employer_dashboard.modal.certifications_already_added',
    'employer_dashboard.modal.certifications_remove_aria',
    'employer_dashboard.modal.certifications_picker_hint',

    // employer_dashboard.modal — legacy free-text migration note
    'employer_dashboard.modal.legacy_value_note',

    // employer_dashboard.modal — description notes + AI generation helper
    'employer_dashboard.modal.description_placeholder_notes',
    'employer_dashboard.modal.description_helper.notes_hint',
    'employer_dashboard.modal.description_helper.generated_from_notes',
    'employer_dashboard.modal.description_helper.other_disabled_hint',

    // job_requirements — certifications group + picker
    'job_requirements.groups.certifications',
    'job_requirements.picker.proof_toggle_label',
    'job_requirements.picker.proof_hint',
    'job_requirements.picker.no_certifications_yet',
    'job_requirements.picker.cert_tier_aria',

    // worker_job_detail — job detail rows
    'worker_job_detail.trade',
    'worker_job_detail.trade_with_other',
    'worker_job_detail.language',
    'worker_job_detail.transportation',
    'worker_job_detail.transportation_required_yes',
    'worker_job_detail.transportation_required_no',
    'worker_job_detail.work_days_label',
    'worker_job_detail.shift_hours',
    'worker_job_detail.duration',

    // worker_job_detail.what_you_need — apply readiness summary
    'worker_job_detail.what_you_need.title',
    'worker_job_detail.what_you_need.in_vault',
    'worker_job_detail.what_you_need.proof_in_vault',
    'worker_job_detail.what_you_need.proof_needed',
    'worker_job_detail.what_you_need.required',
    'worker_job_detail.what_you_need.optional',
    'worker_job_detail.what_you_need.questions_summary',
    'worker_job_detail.what_you_need.questions_required',
    'worker_job_detail.what_you_need.estimate',
    'worker_job_detail.what_you_need.vault_check_failed',

    // worker_job_detail.apply_flow — multi-step apply wizard
    'worker_job_detail.apply_flow.steps.questions',
    'worker_job_detail.apply_flow.steps.documents',
    'worker_job_detail.apply_flow.steps.review',
    'worker_job_detail.apply_flow.steps.aria_label',
    'worker_job_detail.apply_flow.steps.step_label',
    'worker_job_detail.apply_flow.steps.completed',
    'worker_job_detail.apply_flow.hints.questions',
    'worker_job_detail.apply_flow.hints.documents',
    'worker_job_detail.apply_flow.hints.review',
    'worker_job_detail.apply_flow.continue_button',
    'worker_job_detail.apply_flow.back_to_details',
    'worker_job_detail.apply_flow.back_to_jobs',
    'worker_job_detail.apply_flow.progress_saved',
    'worker_job_detail.apply_flow.prefilled_hint',
    'worker_job_detail.apply_flow.cert_question',
    'worker_job_detail.apply_flow.cert_use_vault',
    'worker_job_detail.apply_flow.cert_upload_new',
    'worker_job_detail.apply_flow.cert_unverified_note',
    'worker_job_detail.apply_flow.cert_from_vault',
    'worker_job_detail.apply_flow.review_answers',
    'worker_job_detail.apply_flow.review_skipped',
    'worker_job_detail.apply_flow.review_not_attached',
    'worker_job_detail.apply_flow.review_claimed_proof',
    'worker_job_detail.apply_flow.review_claimed_no_proof',
    'worker_job_detail.apply_flow.review_not_claimed',
    'worker_job_detail.apply_flow.review_note',
    'worker_job_detail.apply_flow.submit',
    'worker_job_detail.apply_flow.submitted_title',
    'worker_job_detail.apply_flow.errors.required_questions',
    'worker_job_detail.apply_flow.errors.required_doc',
    'worker_job_detail.apply_flow.errors.required_cert',
    'worker_job_detail.apply_flow.errors.cert_proof',
    'worker_job_detail.apply_flow.errors.missing_certification_proof',

    // public_job — job detail rows on the public SEO page
    'public_job.trade_with_other',
    'public_job.work_days_label',
    'public_job.shift_hours',
] as const;

describe('job-flow i18n keys', () => {
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
