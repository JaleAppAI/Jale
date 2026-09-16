'use client';

import { useMemo } from 'react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useUnreadMessages } from '@/contexts/UnreadMessagesContext';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { Skeleton, SkeletonLine } from '@/components/ui/skeleton';
import { UnreadBadge } from '@/components/layout/UnreadBadge';
import type { InboxItem } from '@/lib/api/employer';

/**
 * The dashboard's WhatsApp panel (sprint 26, B3).
 *
 * It used to print one fixed paragraph -- "Employer messages are live. Worker
 * replies continue through WhatsApp..." -- under the most recent job's title.
 * True, and the same on the day a worker replied as on the day nobody did. The
 * panel sat on the surface employers spend their time on and told them nothing
 * about their messages.
 *
 * Now it shows the most recent message: who wrote, on which job, what they
 * said and when, with the unread count beside the title. The static paragraph
 * survives as the EMPTY state, where it is the right thing to say, and the
 * job-title line it used to carry stays with it.
 *
 * Reads the inbox from `UnreadMessagesContext` -- the same one read the badge
 * and the drawer use. A panel that fetched for itself would be a third request
 * for a payload already in memory.
 */

/**
 * The message the employer has not seen yet, if any -- the newest by
 * `last_message_at` rather than `items[0]`. The inbox is ordered
 * conversations-first and then by recency, so the first item is USUALLY this
 * one, but a thread created without a message yet sorts on its creation time
 * and would take the slot while having nothing to show.
 */
function newestMessage(items: InboxItem[]): InboxItem | null {
    let newest: InboxItem | null = null;
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const item of items) {
        if (!item.last_message_at || !item.last_message_preview) continue;
        const at = Date.parse(item.last_message_at);
        if (!Number.isFinite(at) || at <= newestAt) continue;
        newest = item;
        newestAt = at;
    }
    return newest;
}

export function LatestMessagePanel({ fallbackJobTitle }: { fallbackJobTitle: string | null }) {
    const t = useTranslations('employer_dashboard');
    const tMessages = useTranslations('employer_messages');
    const format = useFormatter();
    /*
     * The reference point for "2 hours ago", read ONCE per mount rather than
     * from `Date.now()` in the middle of the render: a clock call during
     * render is impure, and two renders a second apart would legitimately
     * produce two different phrases for the same message.
     */
    const now = useNow();
    const { items, loading, unreadCount } = useUnreadMessages();

    const latest = useMemo(() => newestMessage(items), [items]);

    return (
        <DashboardPanel>
            <PanelHeader
                title={t('panels.whatsapp_title')}
                action={
                    <div className="flex items-center gap-2">
                        <UnreadBadge count={unreadCount} tone="bar" />
                        <Link
                            href="/employer/conversations"
                            className="rounded text-xs font-bold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                            {t('panels.open_messages')}
                        </Link>
                    </div>
                }
            />
            <div className="p-5">
                {loading ? (
                    <div role="status" className="space-y-2">
                        <SkeletonLine width="w-1/2" />
                        <SkeletonLine width="w-1/3" tone="paper" />
                        <Skeleton className="h-3 w-3/4" />
                    </div>
                ) : latest ? (
                    <>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <p className="min-w-0 truncate text-sm font-bold text-[var(--jale-ink)]">
                                {latest.worker_name ?? tMessages('unknown_worker')}
                            </p>
                            {/* `time` so the relative phrase carries the exact
                                instant for anyone who needs it -- "2 hours ago"
                                is unusable on its own in a support thread. */}
                            <time
                                dateTime={latest.last_message_at ?? undefined}
                                className="shrink-0 text-[11px] tabular-nums text-[var(--jale-ink-2)]"
                            >
                                {format.relativeTime(new Date(latest.last_message_at as string), now)}
                            </time>
                        </div>
                        <p className="truncate text-xs text-[var(--jale-ink-2)]">
                            {latest.job_city ? `${latest.job_title} · ${latest.job_city}` : latest.job_title}
                        </p>
                        {/* Two lines of the message itself, not one: a WhatsApp
                            reply is usually a sentence, and one clipped line is
                            rarely enough to decide whether to open it. */}
                        <p className="mt-2 line-clamp-2 text-sm leading-5 text-[var(--jale-ink)]">
                            {latest.last_message_preview}
                        </p>
                    </>
                ) : (
                    <>
                        <p className="text-sm font-bold text-[var(--jale-ink)]">
                            {fallbackJobTitle ?? t('panels.no_recent_job')}
                        </p>
                        <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">
                            {t('panels.whatsapp_body')}
                        </p>
                    </>
                )}
            </div>
        </DashboardPanel>
    );
}
