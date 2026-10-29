'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import type { TeamMember } from '@/lib/api/team';
import { memberLabel, sortTeamMembers } from './MembersList';

const PICKER_ID = 'team-remove-reassign';
const ERROR_ID = 'team-remove-error';
const MOVE_ID = 'team-remove-moves';

/**
 * Who can take over a removed foreman's jobs: the owner and every active
 * foreman, never the one being removed. A suspended foreman cannot hold jobs
 * (the backend answers `invalid_assignee`), so they are left out.
 */
export function reassignCandidates(members: readonly TeamMember[], target: TeamMember | null): TeamMember[] {
    return sortTeamMembers(members).filter(
        (m) =>
            m.userId !== target?.userId &&
            (m.role === 'owner' || (m.status === 'active' && !m.billingSuspended)),
    );
}

/**
 * Remove a foreman, moving their jobs (and, with them, their conversations)
 * to the person picked here. Defaults to the owner.
 *
 * Built like `DeleteJobDialog`: the foundation `Modal` gives the focus trap,
 * Escape, the backdrop and the return of focus to the row's Remove button.
 * The parent owns `pending`/`error`, so one attempt's state cannot leak into
 * the next member's dialog, and keys this dialog by the member so the pick
 * starts at the owner each time. While the request is out nothing closes it
 * and the picker is disabled: the result needs a place to land.
 *
 * With open jobs, a line under the picker names how many move and to whom,
 * following the pick (and describing the picker). The dialog also says the
 * member loses access at once.
 *
 * The candidates follow `members`, so after a refetch (an `invalid_assignee`
 * refusal) someone who can no longer take the jobs drops out of the list and
 * the pick falls back to the owner.
 */
export function RemoveMemberDialog({
    open,
    member,
    members,
    pending,
    error,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    member: TeamMember | null;
    members: readonly TeamMember[];
    pending: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: (reassignTo: string) => void;
}) {
    const t = useTranslations('employer_team');
    const pickerRef = useRef<HTMLSelectElement>(null);
    const [picked, setPicked] = useState<string | null>(null);

    const candidates = reassignCandidates(members, member);
    const fallback = candidates.find((m) => m.role === 'owner') ?? candidates[0] ?? null;
    const reassignTo = candidates.some((m) => m.userId === picked) ? picked : fallback?.userId ?? null;
    const assignee = candidates.find((m) => m.userId === reassignTo) ?? null;
    const openJobs = member?.openJobs ?? 0;
    const showMoves = openJobs > 0 && assignee !== null;
    const pickerDescribedBy = [showMoves ? MOVE_ID : null, error ? ERROR_ID : null].filter(Boolean).join(' ') || undefined;

    function handleDismiss() {
        if (pending) return;
        onCancel();
    }

    function handleConfirm() {
        if (pending || !reassignTo) return;
        onConfirm(reassignTo);
    }

    return (
        <Modal
            open={open}
            onClose={handleDismiss}
            title={member ? t('remove.title', { name: memberLabel(member) }) : undefined}
            size="sm"
            closeOnOverlay={!pending}
            closeOnEscape={!pending}
            initialFocusRef={pickerRef}
            footer={
                <>
                    <Button variant="ghost" onClick={handleDismiss} disabled={pending}>
                        {t('remove.cancel')}
                    </Button>
                    <Button variant="error" onClick={handleConfirm} loading={pending} disabled={!reassignTo}>
                        {t('remove.confirm')}
                    </Button>
                </>
            }
        >
            <p className="text-sm leading-6 text-[var(--jale-ink-2)]">{t('remove.body')}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">{t('remove.access')}</p>

            <div className="mt-4 space-y-1.5">
                <label htmlFor={PICKER_ID} className="block text-sm font-semibold text-[var(--jale-ink)]">
                    {t('remove.reassign_label')}
                </label>
                <Select
                    ref={pickerRef}
                    id={PICKER_ID}
                    value={reassignTo ?? ''}
                    onChange={(e) => setPicked(e.target.value)}
                    disabled={pending}
                    aria-describedby={pickerDescribedBy}
                >
                    {candidates.map((m) => (
                        <option key={m.userId} value={m.userId}>
                            {m.role === 'owner' ? `${memberLabel(m)} (${t('members.owner')})` : memberLabel(m)}
                        </option>
                    ))}
                </Select>
                {showMoves ? (
                    <p id={MOVE_ID} aria-live="polite" className="text-sm font-medium text-[var(--jale-ink)]">
                        {t('remove.jobs_move', { count: openJobs, name: memberLabel(assignee) })}
                    </p>
                ) : null}
            </div>

            {error ? (
                <InlineFeedback tone="danger" className="mt-4">
                    <span id={ERROR_ID}>{error}</span>
                </InlineFeedback>
            ) : null}
        </Modal>
    );
}
