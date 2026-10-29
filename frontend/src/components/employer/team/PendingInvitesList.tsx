'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import type { TeamInvite } from '@/lib/api/team';
import { formatLongDate } from '@/lib/date';
import type { TeamActionResult } from './types';
import { secondsLeft, useCooldownClock } from './useCooldownClock';

const ERROR_ID = 'team-pending-error';

/**
 * The backend refuses a resend within 60 s of the last send
 * (133's `org_team_invite_resend`: `last_sent_at > now() - 60 seconds`).
 */
export const RESEND_COOLDOWN_MS = 60_000;

type Busy = { inviteId: string; action: 'resend' | 'revoke' };

/**
 * Pending invites: email, contact name, and when the invite expires (or that
 * it already has). Resend and Revoke per row.
 *
 * The page makes the calls, toasts and refetches. This list keeps:
 *  - the row in flight (both of its buttons disabled meanwhile);
 *  - the last refusal, shown once for the section and linked to the buttons
 *    it concerns with `aria-describedby`. It lives here rather than on the row
 *    because a refusal usually refetches and the row may be gone;
 *  - when each invite may be resent: `lastSentAt + 60 s` (derived from the
 *    data, so it survives a refetch and a reload), or later when a 429 named a
 *    longer wait. Until then Resend is disabled and the row says
 *    "Try again in Ns".
 */
export function PendingInvitesList({
    invites,
    onResend,
    onRevoke,
}: {
    invites: TeamInvite[];
    onResend: (invite: TeamInvite) => Promise<TeamActionResult>;
    onRevoke: (invite: TeamInvite) => Promise<TeamActionResult>;
}) {
    const t = useTranslations('employer_team');
    const locale = useLocale();
    const [busy, setBusy] = useState<Busy | null>(null);
    const [error, setError] = useState<{ inviteId: string; message: string } | null>(null);
    const [rateLimitedUntil, setRateLimitedUntil] = useState<Readonly<Record<string, number>>>({});
    const busyRef = useRef(false);

    const resendAt = (invite: TeamInvite): number => {
        const sent = Date.parse(invite.lastSentAt);
        const byLastSend = Number.isFinite(sent) ? sent + RESEND_COOLDOWN_MS : 0;
        return Math.max(byLastSend, rateLimitedUntil[invite.inviteId] ?? 0);
    };
    const now = useCooldownClock(invites.map(resendAt));

    async function run(invite: TeamInvite, action: Busy['action']) {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy({ inviteId: invite.inviteId, action });
        setError(null);
        try {
            const result = await (action === 'resend' ? onResend(invite) : onRevoke(invite));
            if (!result.ok) {
                if (result.message) setError({ inviteId: invite.inviteId, message: result.message });
                const wait = result.retryAfterSeconds;
                if (wait !== undefined) {
                    setRateLimitedUntil((prev) => ({ ...prev, [invite.inviteId]: Date.now() + wait * 1000 }));
                }
            }
        } finally {
            busyRef.current = false;
            setBusy(null);
        }
    }

    return (
        <DashboardPanel>
            <PanelHeader title={t('pending.title')} />
            {error ? (
                <div className="px-5 pt-4">
                    <InlineFeedback tone="danger" onDismiss={() => setError(null)}>
                        <span id={ERROR_ID}>{error.message}</span>
                    </InlineFeedback>
                </div>
            ) : null}
            {invites.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--jale-ink-2)]">{t('pending.empty')}</p>
            ) : (
                <ul className="divide-y divide-[var(--jale-divider)]">
                    {invites.map((invite) => {
                        const emailId = `team-invite-${invite.inviteId}`;
                        const waitId = `team-invite-${invite.inviteId}-wait`;
                        const rowBusy = busy?.inviteId === invite.inviteId;
                        const wait = secondsLeft(resendAt(invite), now);
                        const describedBy = [
                            emailId,
                            error?.inviteId === invite.inviteId ? ERROR_ID : null,
                        ].filter(Boolean).join(' ');
                        const expires = formatLongDate(invite.expiresAt, locale);
                        return (
                            <li
                                key={invite.inviteId}
                                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                            >
                                <div className="min-w-0 space-y-1">
                                    <p
                                        id={emailId}
                                        className="text-sm font-semibold text-[var(--jale-ink)] [overflow-wrap:anywhere]"
                                    >
                                        {invite.email}
                                    </p>
                                    {invite.contactName ? (
                                        <p className="text-sm text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">
                                            {invite.contactName}
                                        </p>
                                    ) : null}
                                    {invite.expired ? (
                                        <Badge tone="warning">{t('pending.expired')}</Badge>
                                    ) : expires ? (
                                        <p className="text-xs text-[var(--jale-ink-2)]">
                                            {t('pending.expires', { date: expires })}
                                        </p>
                                    ) : null}
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => run(invite, 'resend')}
                                            disabled={rowBusy || wait > 0}
                                            loading={rowBusy && busy?.action === 'resend'}
                                            aria-describedby={wait > 0 ? `${describedBy} ${waitId}` : describedBy}
                                        >
                                            {t('pending.resend')}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => run(invite, 'revoke')}
                                            disabled={rowBusy}
                                            loading={rowBusy && busy?.action === 'revoke'}
                                            aria-describedby={describedBy}
                                        >
                                            {t('pending.revoke')}
                                        </Button>
                                    </div>
                                    {wait > 0 ? (
                                        <p id={waitId} className="text-xs text-[var(--jale-ink-2)]">
                                            {t('pending.resend_wait', { seconds: wait })}
                                        </p>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </DashboardPanel>
    );
}
