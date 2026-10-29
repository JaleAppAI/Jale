'use client';

import type { Ref } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import type { TeamMember } from '@/lib/api/team';

/** Owner first, then foremen by when they joined (ties by name, so the order is stable). */
export function sortTeamMembers(members: readonly TeamMember[]): TeamMember[] {
    return [...members].sort((a, b) => {
        if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
        const byJoined = a.joinedAt.localeCompare(b.joinedAt);
        return byJoined !== 0 ? byJoined : a.name.localeCompare(b.name);
    });
}

/** What a row calls the person: the name, or the email when the name is empty. */
export function memberLabel(member: TeamMember): string {
    return member.name.trim() || member.email;
}

/**
 * The company's members. Badges for the role, and for a (billing-)suspended
 * foreman. Each foreman row shows their open-jobs count and a Remove button;
 * the owner never gets one (the backend refuses `cannot_remove_owner` anyway).
 * Every Remove reads the same word, so each is described by its row's name.
 *
 * The list itself is programmatically focusable (`listRef`, `tabIndex -1`):
 * after a removal the row that held focus is gone, and the page moves focus
 * here rather than letting it drop to the body.
 */
export function MembersList({
    members,
    currentUserId,
    onRemove,
    listRef,
}: {
    members: readonly TeamMember[];
    /** The signed-in owner, marked "You". */
    currentUserId?: string | null;
    onRemove: (member: TeamMember) => void;
    listRef?: Ref<HTMLUListElement>;
}) {
    const t = useTranslations('employer_team');

    return (
        <DashboardPanel>
            <PanelHeader title={t('members.title')} />
            <ul
                ref={listRef}
                tabIndex={-1}
                aria-label={t('members.title')}
                className="divide-y divide-[var(--jale-divider)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
                {sortTeamMembers(members).map((m) => {
                    const nameId = `team-member-${m.userId}`;
                    const isOwner = m.role === 'owner';
                    return (
                        <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                            <div className="min-w-0 space-y-1">
                                <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-[var(--jale-ink)]">
                                    <span id={nameId} data-testid="member-name" className="[overflow-wrap:anywhere]">
                                        {memberLabel(m)}
                                    </span>
                                    {currentUserId && m.userId === currentUserId ? (
                                        <span className="text-xs font-medium text-[var(--jale-ink-2)]">{t('members.you')}</span>
                                    ) : null}
                                </p>
                                {m.name.trim() ? (
                                    <p className="text-sm text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">{m.email}</p>
                                ) : null}
                                <div className="flex flex-wrap items-center gap-3">
                                    <Badge tone={isOwner ? 'info' : 'neutral'}>
                                        {isOwner ? t('members.owner') : t('members.foreman')}
                                    </Badge>
                                    {m.status === 'suspended' ? (
                                        <Badge tone="warning">{t('members.suspended')}</Badge>
                                    ) : null}
                                    {!isOwner ? (
                                        <span className="text-xs text-[var(--jale-ink-2)]">
                                            {t('members.jobs', { count: m.openJobs })}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                            {!isOwner ? (
                                <Button variant="outline" size="sm" onClick={() => onRemove(m)} aria-describedby={nameId}>
                                    {t('members.remove')}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </DashboardPanel>
    );
}
