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

import type { ApplicationDetailsStatus } from '@/lib/status';

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
