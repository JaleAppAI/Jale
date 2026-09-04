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

import type { FeedbackTone } from '@/components/ui/inline-feedback';
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
 * Sprint 24 (B7): the button now STAYS while a request is OUTSTANDING --
 * relabelled as a resend. The sprint-23 rule hid it the moment the request
 * landed, which combined with the select's "Save is disabled for the current
 * value" left an employer with no control at all for a worker who never
 * answered.
 *
 * Two things still withdraw it:
 *   - a TERMINAL status: a hire is done, and a rejection is not reopened by
 *     asking for paperwork.
 *   - `details_status === 'complete'`: the worker HAS answered. The row can
 *     legitimately still read `details_requested` at that point (the status is
 *     the employer's to move, the stage timestamps are not), so without this
 *     guard both surfaces would offer to chase details the employer already
 *     holds.
 *
 * Still fail-open on an absent `status`/`details_status`, same reasoning as
 * `hireBlockReason`: not knowing is not evidence that the action is
 * unavailable, and the PATCH is the authority either way.
 */
export function canRequestDetails(application: {
    status?: ApplicationStatus;
    details_status?: ApplicationDetailsStatus;
} | null | undefined): boolean {
    if (!application) return false;
    const { status, details_status: detailsStatus } = application;
    if (status && TERMINAL_APPLICATION_STATUSES.includes(status)) return false;
    return detailsStatus !== 'complete';
}

/**
 * The options the status dropdown renders for an application currently at
 * `current`.
 *
 * `SELECTABLE_APPLICATION_STATUSES`, plus `current` prepended when it is not
 * itself selectable -- which today means exactly `details_requested`. A
 * `<select>` whose `value` matches no `<option>` shows the FIRST option's
 * label instead, so omitting the current status outright would put "Pending"
 * over a row that is actually waiting on the worker.
 *
 * The extra option is deliberately NOT disabled: a disabled option that is
 * also the current value renders blank in several browsers (the same trap the
 * `hired` option's `hireOptionDisabled` suppression documents on the worker
 * page). It is harmless enabled, because Save is disabled while the draft
 * still equals the saved status -- so the select can never MOVE an
 * application into `details_requested`, which is the whole point of the
 * ruling, and once the employer moves it elsewhere the option is gone.
 */
export function statusSelectOptions(
    current: ApplicationStatus | undefined | null,
): readonly ApplicationStatus[] {
    if (!current || SELECTABLE_APPLICATION_STATUSES.includes(current)) {
        return SELECTABLE_APPLICATION_STATUSES;
    }
    return [current, ...SELECTABLE_APPLICATION_STATUSES];
}

/**
 * Whether pressing the button would be a RESEND rather than a first request.
 *
 * Needs BOTH halves of the stage vocabulary, and they mean different things:
 *   - `status === 'details_requested'` is what makes a resend legal at all.
 *     The backend refuses `resend` with a 400 for any other status, and
 *     re-sending a stage-2 ping to someone whose row says `talking` would
 *     describe a stage they are no longer in.
 *   - `details_status !== 'complete'` is what makes it MEANINGFUL. A worker
 *     who has already answered needs no nudge, and `canRequestDetails` hides
 *     the button entirely in that case -- these two must agree, or the label
 *     would describe a control that is not there.
 *
 * Fails open on an absent `details_status`: an API that publishes no stage-2
 * vocabulary has not told us the worker answered.
 *
 * Drives both the button's label and the `resend: true` flag on the PATCH, so
 * the two can never disagree.
 */
export function canResendDetails(
    status: ApplicationStatus | undefined | null,
    detailsStatus?: ApplicationDetailsStatus | null,
): boolean {
    return status === 'details_requested' && detailsStatus !== 'complete';
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

/**
 * The banner tone that goes with each outcome sentence.
 *
 * Split from the key on purpose: the copy and the colour are chosen by the
 * same fact, and letting each call site pick its own tone is how a green
 * "no message was sent" banner shipped in the first place. `warning` also
 * gives `InlineFeedback` an `alert` role (inline-feedback.tsx:35-37), so the
 * one outcome that needs the employer to DO something is the one a screen
 * reader is interrupted for.
 */
export function detailsRequestFeedbackTone(key: DetailsRequestFeedbackKey): FeedbackTone {
    if (key === 'request_details_no_whatsapp') return 'warning';
    if (key === 'request_details_unchanged') return 'info';
    // `request_details_sent` is the fail-open line: it promises a future
    // notification rather than asserting a past one, so it is not a false
    // claim and stays a success.
    return 'success';
}
