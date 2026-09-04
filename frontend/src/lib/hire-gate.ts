// ---------------------------------------------------------------------------
// The hire gate, client side.
//
// As of migration 091 `hired` is not a status an employer can simply choose:
// a BEFORE UPDATE trigger refuses it until every required field, job-scoped
// document and required-tier certification claim is in, and the API turns that
// into 409 `details_incomplete { missing: {fields, docs, certifications} }`.
//
// This module is the UI's read of the same rule, and it exists so the employer
// meets it BEFORE pressing Save rather than as an error afterwards. It is
// advisory only: the 409 stays the authority, and the page must still handle
// it (a stale page load, or the fail-open branch below, both reach it).
// ---------------------------------------------------------------------------

import type { RequirementsRemaining } from '@/lib/api/worker';
import {
    TERMINAL_APPLICATION_STATUSES,
    type ApplicationDetailsStatus,
    type ApplicationStatus,
} from '@/lib/status';

/**
 * How many things still block a hire, as one number.
 *
 * All four buckets are blocking-only by construction -- the read endpoints'
 * `remainingView` already drops optional fields/docs and the uncollectable
 * legacy `ssn` -- so this is a plain sum, and it is the same arithmetic the
 * worker's own progress bar shows. `null` (not `0`) when there is no remaining
 * document to read: an API that has not shipped the field is not the same
 * answer as an applicant with nothing left, and the two render differently.
 */
export function remainingCount(remaining?: RequirementsRemaining | null): number | null {
    if (!remaining?.counts) return null;
    const { prompts, fields, certifications, docs } = remaining.counts;
    return prompts + fields + certifications + docs;
}

/** Why a hire is blocked -- the two states have different remedies. */
export type HireBlockReason =
    /** Nobody has asked this worker for anything yet. Remedy: request details. */
    | 'not_requested'
    /** Asked, still outstanding. Remedy: wait, or nudge. */
    | 'requested';

/**
 * Whether `hired` should be offered for this applicant.
 *
 * FAIL-OPEN on an absent `details_status`: the frontend may ship ahead of the
 * backend, and an API that publishes no stage-2 vocabulary is not evidence
 * that a hire is blocked -- it is evidence we cannot tell. Blocking on
 * "unknown" would make hiring impossible on the old API for the whole window
 * between the two deploys; offering it means the worst case is the 409 the
 * page already renders.
 *
 * `complete` is not blocked here even though the trigger could still refuse
 * (a doc deleted between the read and the save): that is exactly the case the
 * 409 handler exists for, and pre-blocking it would put a permanent hint on a
 * row where nothing is actually wrong.
 */
export function hireBlockReason(profile: {
    details_status?: ApplicationDetailsStatus;
} | null | undefined): HireBlockReason | null {
    const status = profile?.details_status;
    if (status === 'not_requested') return 'not_requested';
    if (status === 'requested') return 'requested';
    return null;
}

/** Boolean convenience over `hireBlockReason` for the disabled attribute. */
export function hireBlocked(profile: {
    details_status?: ApplicationDetailsStatus;
} | null | undefined): boolean {
    return hireBlockReason(profile) !== null;
}

/**
 * The statuses the employer's status DROPDOWN offers.
 *
 * `details_requested` is deliberately absent (sprint 24, B7). It is the one
 * status that also has to send the worker a WhatsApp message, and the backend
 * only sends on an actual transition -- so picking it in the dropdown on a row
 * that already sat there committed nothing and notified nobody, while the
 * "Request details" button beside it did both. Two controls that looked the
 * same and behaved differently. The button is now the only way in, and
 * `canResendDetails` is the only way to repeat it.
 *
 * NOT a narrowing of `ApplicationStatus`: `details_requested` remains a legal
 * API status (the button sends it) and the badge/label mapping must still
 * render it whenever it is an application's CURRENT status. This list only
 * says what an employer may pick.
 *
 * Mirrors `APPLICATION_STATUSES` in `infra/lambda/lib/job-fields.ts` minus
 * that one member, in the same order.
 */
export const SELECTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
    'pending',
    'contacted',
    'talking',
    'hired',
    'not_interested',
];

/**
 * Whether to offer "Request details" for this application.
 *
 * Shared by the applicant CARD (job page) and the applicant PAGE (worker
 * detail), so the two can never disagree about when the button exists.
 *
 * Sprint 24 (B7): the button now STAYS once details have been requested --
 * relabelled as a resend. `details_status` no longer participates. The old
 * rule hid it the moment the request landed, which combined with the select's
 * "Save is disabled for the current value" left an employer with no control at
 * all for a worker who never answered. Only a TERMINAL status withdraws it: a
 * hire is done, and a rejection is not reopened by asking for paperwork.
 *
 * Still fail-open on an absent `status`, same reasoning as `hireBlockReason`:
 * not knowing is not evidence that the action is unavailable, and the PATCH is
 * the authority either way.
 */
export function canRequestDetails(application: {
    status?: ApplicationStatus;
    details_status?: ApplicationDetailsStatus;
} | null | undefined): boolean {
    if (!application) return false;
    const { status } = application;
    return !(status && TERMINAL_APPLICATION_STATUSES.includes(status));
}

/**
 * Whether pressing the button would be a RESEND rather than a first request.
 *
 * Read off the committed application status alone -- not `details_status`,
 * which stays `requested` even after the employer moves the applicant on to
 * `talking`, and re-sending a stage-2 ping to someone whose row no longer says
 * `details_requested` would describe a stage they are no longer in.
 *
 * Drives both the button's label and the `resend: true` flag on the PATCH, so
 * the two can never disagree -- the backend refuses `resend` with a 400 for
 * any other status.
 */
export function canResendDetails(status: ApplicationStatus | undefined | null): boolean {
    return status === 'details_requested';
}

/**
 * What the PATCH says about whether the worker actually heard about it
 * (sprint 24, B7). `notify_reason` is only sent when `notified` is false.
 */
export type DetailsRequestOutcome = {
    notified?: boolean;
    notify_reason?: 'unchanged' | 'renderer_unavailable' | 'not_notifiable_status';
};

/** The `employer_job_listing.applicants.*` keys this module chooses between. */
export type DetailsRequestFeedbackKey =
    | 'request_details_sent'
    | 'request_details_notified'
    | 'request_details_no_whatsapp'
    | 'request_details_unchanged';

/**
 * Which sentence to show after a details request, from the outcome the backend
 * reported. A pure function on purpose: it is the whole of the "did the worker
 * hear about it?" decision, it is shared by the card and the page, and it is
 * the part worth testing.
 *
 * FAIL-OPEN to the neutral line: an API that publishes no `notified` is not
 * evidence that nothing was sent, so the pre-B7 copy is used -- it promises a
 * future notification rather than asserting a past one, which is honest under
 * either backend. A `notified: false` carrying a reason this build has no
 * sentence for degrades the same way, for the same reason.
 */
export function detailsRequestFeedbackKey(
    outcome: DetailsRequestOutcome | null | undefined,
): DetailsRequestFeedbackKey {
    if (outcome?.notified === true) return 'request_details_notified';
    if (outcome?.notified === false) {
        if (outcome.notify_reason === 'renderer_unavailable') return 'request_details_no_whatsapp';
        if (outcome.notify_reason === 'unchanged') return 'request_details_unchanged';
    }
    return 'request_details_sent';
}
