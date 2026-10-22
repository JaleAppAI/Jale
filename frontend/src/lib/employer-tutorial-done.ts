import { normalizeApplicationStatus, type ApplicationStatus, type LegacyApplicationStatus } from '@/lib/status';

/**
 * K1.5 "has done the task" for the four employer tutorials, read from data the
 * host page already holds. A tutorial auto-opens only while its signal is
 * `false`; `true` means never, and `undefined` means "not known yet", which a
 * host treats as "do not ask yet".
 */

/** Inbox state as a host page reads it from `useUnreadMessages()`. */
export type InboxSignal = {
    loading: boolean;
    errorKind: unknown;
    items: readonly {
        application_status: ApplicationStatus | LegacyApplicationStatus;
        conversation_id: string | null;
    }[];
};

/** Statuses an employer only reaches by acting on an applicant. `contacted` and `talking` are not among them. */
const PAST_APPLIED: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
    'details_requested',
    'hired',
    'not_interested',
]);

function isPastApplied(status: ApplicationStatus | LegacyApplicationStatus): boolean {
    return PAST_APPLIED.has(normalizeApplicationStatus(status));
}

/** E1 and E2: the employer has any job, in any status. */
export function hasJobsDone(jobs: readonly unknown[] | null | undefined): boolean | undefined {
    return jobs ? jobs.length > 0 : undefined;
}

/**
 * E3: any application on any of the employer's jobs is past applied, as the
 * page's own applicants or the inbox show it. A page that already shows one
 * settles it without waiting for the inbox; a failed inbox read leaves the
 * page's data to answer alone.
 */
export function applicantsTutorialDone(
    pageStatuses: readonly (ApplicationStatus | LegacyApplicationStatus)[] | null,
    inbox: InboxSignal,
): boolean | undefined {
    if (pageStatuses === null) return undefined;
    if (pageStatuses.some(isPastApplied)) return true;
    if (inbox.errorKind) return false;
    if (inbox.loading) return undefined;
    return inbox.items.some((item) => isPastApplied(item.application_status));
}

/**
 * E4: the employer has a conversation. A thread is only ever created by the
 * employer's first message, so a row with a conversation id is the sign.
 */
export function messagesTutorialDone(inbox: InboxSignal): boolean | undefined {
    if (inbox.loading || inbox.errorKind) return undefined;
    return inbox.items.some((item) => item.conversation_id !== null);
}
