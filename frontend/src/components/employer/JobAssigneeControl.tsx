'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useEmployerMembership } from '@/hooks/useEmployerMembership';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/errors';
import { getTeam, reassignJob, teamErrorMessageKey, type TeamMember } from '@/lib/api/team';
import { isTeamManagementEnabled } from '@/lib/feature-flags';

type JobAssigneeControlProps = {
    jobId: string;
    /**
     * The job's responsible person (`jobs.employer_id`) as the job read gives
     * it; null when the read does not name one (nothing is preselected then).
     */
    assigneeUserId: string | null;
    /** Read the job again: after a move, and after a 404 `job_not_found`. */
    onJobChanged: () => void;
    /** Where a legal wall returns the employer to. */
    returnUrl: string;
};

/**
 * Phase 3: the owner moves this job to themselves or to an active foreman.
 *
 * Owner-only, and only with the team flag on. Every other answer -- flag off
 * (`disabled`), `loading`, `blocked`, a failed membership read (`error`), a
 * foreman -- renders nothing and asks for nothing, so the job page is exactly
 * the Phase 2 page for them. The team list is only requested past this gate.
 */
export function JobAssigneeControl(props: JobAssigneeControlProps) {
    const membership = useEmployerMembership();
    if (!isTeamManagementEnabled()) return null;
    if (membership.status !== 'ready' || membership.role !== 'owner') return null;
    return <OwnerAssigneePicker {...props} />;
}

/** Who may take a job: the owner, then every active foreman. */
function assignableMembers(members: TeamMember[]): TeamMember[] {
    const active = members.filter((m) => m.status === 'active');
    return [
        ...active.filter((m) => m.role === 'owner'),
        ...active.filter((m) => m.role === 'foreman'),
    ];
}

/** Focus nobody holds any more: the control's own button was just disabled. */
function focusWasDropped(): boolean {
    const active = document.activeElement;
    return active === null || active === document.body;
}

/**
 * A move this control made, held until the job read catches up: `from` is the
 * `assigneeUserId` prop at the time. While the prop still says `from`, the
 * control shows `to`; once a refetch changes the prop, the prop is the truth.
 */
type LocalMove = { from: string | null; to: string };

function OwnerAssigneePicker({ jobId, assigneeUserId, onJobChanged, returnUrl }: JobAssigneeControlProps) {
    const t = useTranslations('employer_team');
    const tCommon = useTranslations('common');
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const toast = useToast();
    const selectId = useId();
    const errorId = useId();

    /** Every member the list returned (active and suspended); null until read. */
    const [members, setMembers] = useState<TeamMember[] | null>(null);
    /** Why the team list could not be read (a busy answer has its own copy). */
    const [loadError, setLoadError] = useState<ReturnType<typeof teamErrorMessageKey> | null>(null);
    const [teamReload, setTeamReload] = useState(0);
    /** The owner's pick; null means "whoever is responsible now". */
    const [choice, setChoice] = useState<string | null>(null);
    const [localMove, setLocalMove] = useState<LocalMove | null>(null);
    const [saving, setSaving] = useState(false);
    /** The synchronous double-submit guard: `saving` lags a render behind. */
    const savingRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const selectRef = useRef<HTMLSelectElement>(null);

    useEffect(() => {
        if (!idToken) return;
        const controller = new AbortController();
        let active = true;
        (async () => {
            try {
                const list = await getTeam(idToken, controller.signal);
                if (!active) return;
                setMembers(list.members);
                setLoadError(null);
            } catch (err) {
                if (!active) return;
                try {
                    handleLegalWall(err, returnUrl);
                } catch {
                    setLoadError(teamErrorMessageKey(err));
                }
            }
        })();
        return () => {
            active = false;
            controller.abort();
        };
    }, [idToken, teamReload, handleLegalWall, returnUrl]);

    const current = localMove && localMove.from === assigneeUserId ? localMove.to : assigneeUserId;
    const assignable = members ? assignableMembers(members) : [];
    /*
     * The job's current person, when they can no longer take jobs (a
     * suspended foreman): shown, but not offered, so the select names who is
     * responsible today instead of reading blank or showing someone else.
     */
    const currentInactive = current && !assignable.some((m) => m.userId === current)
        ? members?.find((m) => m.userId === current) ?? null
        : null;
    const pick = choice ?? current ?? '';
    const known = assignable.some((m) => m.userId === pick) || currentInactive?.userId === pick;
    /** What the select shows: '' (nothing) for an id no option names. */
    const selected = known ? pick : '';
    const canSave = selected !== '' && selected !== current && assignable.some((m) => m.userId === selected);

    // A plain function: it is only a click handler, so nothing memoizes on it.
    async function handleSave() {
        if (!idToken || savingRef.current || !canSave) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
            const result = await reassignJob(idToken, jobId, selected);
            setLocalMove({ from: assigneeUserId, to: result.assigneeUserId });
            setChoice(null);
            // `changed: false`: the job already was theirs (another tab, or a
            // move that landed first). Nothing happened, so nothing to say or
            // to read again.
            if (result.changed) {
                const name = members?.find((m) => m.userId === result.assigneeUserId)?.name ?? '';
                if (name) toast.success(t('reassign.done', { name }));
                onJobChanged();
            }
        } catch (err) {
            try {
                handleLegalWall(err, returnUrl);
            } catch {
                const code = err instanceof ApiError ? err.code : null;
                if (code === 'job_not_found') {
                    onJobChanged();
                } else if (code === 'invalid_assignee') {
                    // The person picked is no longer someone who can take it.
                    setChoice(null);
                    setTeamReload((n) => n + 1);
                }
                setError(t(teamErrorMessageKey(err)));
            }
        } finally {
            savingRef.current = false;
            setSaving(false);
            // The button was disabled while saving, which drops keyboard focus
            // to <body>. Put it back once the commit has re-enabled things:
            // on the button, or on the select when there is nothing to save.
            requestAnimationFrame(() => {
                if (!focusWasDropped()) return;
                const button = buttonRef.current;
                if (button && !button.disabled) button.focus();
                else selectRef.current?.focus();
            });
        }
    }

    if (loadError && members === null) {
        return (
            <div className="border-t border-[var(--jale-divider)] px-5 py-4">
                <InlineFeedback tone="warning">{t(loadError)}</InlineFeedback>
            </div>
        );
    }

    return (
        <div className="border-t border-[var(--jale-divider)] px-5 py-4">
            <label
                htmlFor={selectId}
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
            >
                {t('reassign.label')}
            </label>
            {members === null ? (
                <Skeleton className="h-11 w-full max-w-sm" />
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 sm:max-w-sm">
                        <Select
                            ref={selectRef}
                            id={selectId}
                            value={selected}
                            disabled={saving}
                            aria-describedby={error ? errorId : undefined}
                            onChange={(event) => {
                                setChoice(event.target.value);
                                setError(null);
                            }}
                        >
                            {/* A job whose read names nobody preselects nobody. */}
                            {selected === '' ? <option value="" disabled hidden /> : null}
                            {currentInactive ? (
                                <option value={currentInactive.userId} disabled>
                                    {`${currentInactive.name} (${t('members.suspended')})`}
                                </option>
                            ) : null}
                            {assignable.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                    {m.role === 'owner' ? `${m.name} (${t('members.owner')})` : m.name}
                                </option>
                            ))}
                        </Select>
                    </div>
                    <Button
                        ref={buttonRef}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleSave()}
                        disabled={!canSave}
                        loading={saving}
                        loadingLabel={tCommon('loading')}
                    >
                        {t('reassign.save')}
                    </Button>
                </div>
            )}
            {/* A re-read that failed (after `invalid_assignee`) keeps the old
                list on screen, and says that it may be out of date. */}
            {loadError && members !== null ? (
                <div className="mt-3">
                    <InlineFeedback tone="warning">{t(loadError)}</InlineFeedback>
                </div>
            ) : null}
            {error ? (
                <div id={errorId} className="mt-3">
                    <InlineFeedback tone="danger" onDismiss={() => setError(null)}>
                        {error}
                    </InlineFeedback>
                </div>
            ) : null}
        </div>
    );
}
