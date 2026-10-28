'use client';

import { useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { useEmployerMembership } from '@/hooks/useEmployerMembership';
import { usePageData } from '@/hooks/usePageData';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { InviteForm } from '@/components/employer/team/InviteForm';
import { MembersList, memberLabel } from '@/components/employer/team/MembersList';
import { PendingInvitesList } from '@/components/employer/team/PendingInvitesList';
import { RemoveMemberDialog } from '@/components/employer/team/RemoveMemberDialog';
import type { TeamActionResult } from '@/components/employer/team/types';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';
import { useToast } from '@/components/ui/toast';
import { ApiError, errorMessageKey } from '@/lib/api/errors';
import {
    createInvite,
    getTeam,
    removeMember,
    resendInvite,
    retryAfterSecondsOf,
    revokeInvite,
    teamErrorMessageKey,
    type TeamInvite,
    type TeamList,
    type TeamLocale,
    type TeamMember,
} from '@/lib/api/team';
import { isTeamManagementEnabled } from '@/lib/feature-flags';

export const dynamic = 'force-dynamic';

const RETURN_URL = '/employer/team';

/** The Resend cool-down when a 429 names no wait. */
const RATE_LIMIT_DEFAULT_SECONDS = 60;

/**
 * A refusal that says the list on screen is stale: a 409, or a 404 naming the
 * invite or member (not `not_found`, which is the route itself). A full seat
 * count is stale data too. The page refetches before showing the message.
 */
function isStaleListRefusal(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    if (err.code === 'seat_limit_reached') return true;
    if (err.status === 409) return true;
    return err.status === 404 && err.code !== 'not_found';
}

/**
 * `/employer/team` (Phase 3): the owner's Team page -- seats, the invite
 * form, pending invites (resend, revoke) and members (remove, moving their
 * jobs to someone else).
 *
 * With the team flag off the route does not exist (Phase 2 had none): it is
 * not found and makes no request. A foreman goes to the dashboard. The role
 * is the membership's, or billing's when the membership call failed; a
 * loading or blocked membership is never an owner, so it paints the skeleton
 * and requests nothing (a blocked login is already being routed to
 * `/employer/access`).
 */
export default function EmployerTeamPage() {
    if (!isTeamManagementEnabled()) notFound();
    return <TeamScreen />;
}

function TeamScreen() {
    const t = useTranslations('employer_team');
    const router = useRouter();
    const membership = useEmployerMembership();

    const role =
        membership.status === 'ready'
            ? membership.role
            : membership.status === 'error'
                ? membership.billingRole
                : null;
    const isForeman = role === 'foreman';
    // An `error` with no billing role either: let the server decide (the list
    // answers 403 `owner_required` to a foreman, shown as the error state).
    const canView = membership.status === 'ready' || membership.status === 'error' ? !isForeman : false;
    const currentUserId = membership.status === 'ready' ? membership.userId : null;

    useEffect(() => {
        if (isForeman) router.replace('/employer/dashboard');
    }, [isForeman, router]);

    return (
        <AppShell role="employer" title={t('title')} actions={<PostJobButton />}>
            <main className="mx-auto max-w-3xl px-4 py-6 md:px-6">
                {canView ? <TeamContent currentUserId={currentUserId} /> : <ListPageSkeleton rows={3} />}
            </main>
        </AppShell>
    );
}

function TeamContent({ currentUserId }: { currentUserId: string | null }) {
    const t = useTranslations('employer_team');
    const tCommon = useTranslations('common');
    const locale: TeamLocale = useLocale() === 'es' ? 'es' : 'en';
    const toast = useToast();
    const { idToken, handleLegalWall } = useRequireAuth();

    const [removing, setRemoving] = useState<TeamMember | null>(null);
    const [removePending, setRemovePending] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    /** A remove refused as already done: once the refetch drops the member, close and toast this. */
    const [goneMessage, setGoneMessage] = useState<string | null>(null);
    /** A removed member whose login the server could not disable yet (`accessUpdated: false`). */
    const [accessPendingName, setAccessPendingName] = useState<string | null>(null);
    /** Bumped after a removal's refetch: focus moves to the members list (the row that had it is gone). */
    const [focusMembers, setFocusMembers] = useState(0);
    const membersListRef = useRef<HTMLUListElement>(null);

    const { phase, data, errorKind, refreshError, retry, refresh } = usePageData<TeamList>({
        fetcher: ({ token, signal }) => getTeam(token, signal),
        legalReturnUrl: RETURN_URL,
    });

    // Runs after the commit that closed the dialog, so it lands after Modal's
    // own focus return (to a Remove button the refetch has removed).
    useEffect(() => {
        if (focusMembers > 0) membersListRef.current?.focus();
    }, [focusMembers]);

    const members = data?.members;
    useEffect(() => {
        if (!goneMessage || !removing || !members) return;
        if (members.some((m) => m.userId === removing.userId)) return;
        // Derived from the refetch's answer: the member is no longer on the
        // team, so the dialog has nothing left to do. Synchronising UI with
        // external data is what this effect is for.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRemoving(null);
        setRemoveError(null);
        setGoneMessage(null);
        toast.info(goneMessage);
        setFocusMembers((n) => n + 1);
    }, [goneMessage, removing, members, toast]);

    /** Routes a legal wall or blocked login; otherwise refetches if stale and names the message. */
    async function failure(err: unknown): Promise<TeamActionResult> {
        try {
            handleLegalWall(err, RETURN_URL);
            return { ok: false, message: null };
        } catch {
            // Not a wall: the page shows it.
        }
        if (isStaleListRefusal(err)) await refresh();
        const code = err instanceof ApiError ? err.code : undefined;
        const message = code === 'seat_limit_reached'
            ? `${t('errors.seat_limit_reached')} ${t('invite.seats_remedy')}`
            : t(teamErrorMessageKey(err));
        return {
            ok: false,
            message,
            ...(code !== undefined ? { code } : {}),
            ...(code === 'invite_rate_limited'
                ? { retryAfterSeconds: retryAfterSecondsOf(err) ?? RATE_LIMIT_DEFAULT_SECONDS }
                : {}),
        };
    }

    /** `invite_closed` is not an error: the invite already left the pending list. Refetch and say so. */
    async function inviteClosed(err: unknown): Promise<boolean> {
        if (!(err instanceof ApiError) || err.code !== 'invite_closed') return false;
        await refresh();
        toast.info(t('errors.invite_closed'));
        return true;
    }

    async function handleInvite(input: { email: string; contactName?: string }): Promise<TeamActionResult> {
        if (!idToken) return { ok: false, message: t('errors.generic') };
        try {
            await createInvite(idToken, { ...input, locale });
        } catch (err) {
            return failure(err);
        }
        toast.success(t('invite.sent', { email: input.email }));
        await refresh();
        return { ok: true };
    }

    async function handleResend(invite: TeamInvite): Promise<TeamActionResult> {
        if (!idToken) return { ok: false, message: t('errors.generic') };
        try {
            await resendInvite(idToken, invite.inviteId, locale);
        } catch (err) {
            if (await inviteClosed(err)) return { ok: true };
            return failure(err);
        }
        toast.success(t('pending.resent', { email: invite.email }));
        await refresh();
        return { ok: true };
    }

    async function handleRevoke(invite: TeamInvite): Promise<TeamActionResult> {
        if (!idToken) return { ok: false, message: t('errors.generic') };
        try {
            await revokeInvite(idToken, invite.inviteId);
        } catch (err) {
            if (await inviteClosed(err)) return { ok: true };
            return failure(err);
        }
        toast.success(t('pending.revoked'));
        await refresh();
        return { ok: true };
    }

    function openRemove(member: TeamMember) {
        setRemoveError(null);
        setGoneMessage(null);
        setRemoving(member);
    }

    function closeRemove() {
        setRemoving(null);
        setGoneMessage(null);
    }

    async function handleRemove(reassignTo: string) {
        if (!removing || removePending) return;
        if (!idToken) {
            setRemoveError(t('errors.generic'));
            return;
        }
        const target = removing;
        const name = memberLabel(target);
        setRemovePending(true);
        setRemoveError(null);
        setGoneMessage(null);
        try {
            const result = await removeMember(idToken, target.userId, reassignTo);
            setRemoving(null);
            toast.success(t('remove.done', { name, count: result.movedJobs }));
            setAccessPendingName(result.accessUpdated ? null : name);
            await refresh();
            setFocusMembers((n) => n + 1);
        } catch (err) {
            const result = await failure(err);
            if (!result.ok && result.message) {
                setRemoveError(result.message);
                // Already gone: if the refetch agrees, the effect above closes the dialog.
                if (result.code === 'member_not_found' || result.code === 'already_removed') {
                    setGoneMessage(result.message);
                }
            }
        } finally {
            setRemovePending(false);
        }
    }

    if (phase === 'auth' || phase === 'loading') {
        // Same archetype as loading.tsx, so the handover costs no visible swap.
        return <ListPageSkeleton rows={3} />;
    }

    if (phase === 'error' || !data) {
        return (
            <DashboardPanel>
                <ErrorState kind={errorKind ?? 'unknown'} onRetry={retry} />
            </DashboardPanel>
        );
    }

    const { seats } = data;
    const noSeats = seats.limit === 0;
    const used = seats.active + seats.pending;
    const seatsFull = !noSeats && used >= seats.limit;

    return (
        <div className="anim-fade-in space-y-5">
            {/* A failed background refetch is a footnote: the lists stay as they were. */}
            {refreshError ? (
                <InlineFeedback tone="warning">{tCommon(errorMessageKey(refreshError))}</InlineFeedback>
            ) : null}

            {accessPendingName ? (
                <InlineFeedback tone="warning" onDismiss={() => setAccessPendingName(null)}>
                    {t('remove.access_pending', { name: accessPendingName })}
                </InlineFeedback>
            ) : null}

            {noSeats ? (
                <InlineFeedback tone="info">
                    <span className="block">{t('no_seats')}</span>
                    <Link
                        href="/employer/billing"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                    >
                        {t('no_seats_link')}
                    </Link>
                </InlineFeedback>
            ) : (
                <p className="flex flex-wrap gap-x-3 text-sm font-semibold text-[var(--jale-ink-2)]">
                    <span>{t('seats', { used, limit: seats.limit })}</span>
                    {seats.pending > 0 ? <span>{t('seats_pending', { count: seats.pending })}</span> : null}
                </p>
            )}

            {noSeats ? null : <InviteForm onInvite={handleInvite} seatsFull={seatsFull} />}

            <PendingInvitesList invites={data.invites} onResend={handleResend} onRevoke={handleRevoke} />

            <MembersList
                members={data.members}
                currentUserId={currentUserId}
                onRemove={openRemove}
                listRef={membersListRef}
            />

            <RemoveMemberDialog
                key={removing?.userId ?? 'closed'}
                open={removing !== null}
                member={removing}
                members={data.members}
                pending={removePending}
                error={removeError}
                onCancel={closeRemove}
                onConfirm={handleRemove}
            />
        </div>
    );
}
