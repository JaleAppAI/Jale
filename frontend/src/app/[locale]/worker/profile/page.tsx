'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { apiFetch } from '@/lib/api';
import { parseApiError } from '@/lib/api/errors';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { KVList } from '@/components/ui/kv-list';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { ProfileEditForm } from '@/components/worker/ProfileEditForm';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { getVaultDocuments, updateWorkerProfile } from '@/lib/api/worker';
import type { WorkerProfileData, WorkerProfilePatch, WorkerVaultDoc, DocType } from '@/lib/api/worker';
import { readPendingReferral, clearPendingReferral, validateJobId } from '@/lib/referral-return';

export const dynamic = 'force-dynamic';

const DOC_TYPES: DocType[] = ['resume', 'driver_license'];

const AVAILABILITY_KEYS = ['full_time', 'part_time', 'weekends', 'flexible'];

/** Everything the page renders, fetched as one unit so it loads as one unit. */
type WorkerProfilePageData = {
    profile: WorkerProfileData;
    docs: WorkerVaultDoc[];
};

/**
 * The `/worker/profile` response shape, narrowed to the fields the page uses.
 * Extracted from the two identical inline mappings the page used to carry (the
 * first load and the post-flush re-read) so they cannot drift apart.
 */
function toWorkerProfile(p: Record<string, unknown>): WorkerProfileData {
    const raw = p as WorkerProfileData & { skills?: string[]; certifications?: string[] };
    return {
        id: raw.id, phone: raw.phone, full_name: raw.full_name,
        skills: raw.skills ?? [], availability: raw.availability,
        years_experience: raw.years_experience, location: raw.location, bio: raw.bio,
        certifications: raw.certifications ?? [],
        preferred_cities: raw.preferred_cities ?? [],
    };
}

export default function WorkerProfilePage() {
    const { idToken } = useAuth();
    const router = useRouter();
    const t = useTranslations('worker_profile');
    const tCommon = useTranslations('common');

    const [editing, setEditing] = useState(false);
    const [saved, setSaved] = useState(false);

    const { phase, data, errorKind, refreshError, retry, refresh } = usePageData<WorkerProfilePageData>({
        fetcher: async ({ token, signal }) => {
            const res = await apiFetch('/worker/profile', { signal }, token);
            if (!res.ok) throw await parseApiError(res, 'fetch_failed');
            let profile = toWorkerProfile(await res.json());
            const d = await getVaultDocuments(token, signal);
            const docs = d.documents;

            const pending = sessionStorage.getItem('pendingWorkerProfile');
            if (pending) {
                await updateWorkerProfile(token, JSON.parse(pending));
                sessionStorage.removeItem('pendingWorkerProfile');
                const updated = await apiFetch('/worker/profile', { signal }, token);
                if (updated.ok) {
                    profile = toWorkerProfile(await updated.json());
                }

                // This is the second stop of the web-apply signup journey: the form
                // sent a fresh signup here (so the typed profile above gets saved)
                // instead of straight to the job. If a referral is still waiting,
                // finish the journey now.
                const referral = readPendingReferral();
                const jobId = validateJobId(referral?.jobId);
                if (jobId) {
                    clearPendingReferral();
                    router.push(`/worker/jobs/${jobId}`);
                    // Returning (rather than falling through) keeps the redirect
                    // the last thing this path does, exactly as before: the page
                    // hands over its data and the router takes the screen.
                    return { profile, docs };
                }
            }
            return { profile, docs };
        },
        legalReturnUrl: '/worker/profile',
    });

    async function handleSave(patch: WorkerProfilePatch) {
        if (!idToken) return;
        await updateWorkerProfile(idToken, patch);
        setEditing(false);
        setSaved(true);
        // A failed reload can no longer blank a saved profile: `refresh` only
        // ever adds newer data or a `refreshError` footnote.
        await refresh();
    }

    function startEditing() {
        setSaved(false);
        setEditing(true);
    }

    // 'auth' means the token gate has not opened yet: nothing has been asked
    // for, so the page owes the reader a skeleton rather than an empty screen.
    const showSkeleton = phase === 'auth' || phase === 'loading';
    const profile = data?.profile ?? null;
    const docs = data?.docs ?? [];

    return (
        <AppShell role="worker" title={t('title')}>
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {showSkeleton ? (
                    /* Same archetype and geometry as `loading.tsx`, so the route-level
                       skeleton and this one are the same picture — the handover from
                       server render to client fetch costs no visible swap. */
                    <DetailPageSkeleton />
                ) : phase === 'error' && errorKind ? (
                    <DashboardPanel>
                        <ErrorState kind={errorKind} onRetry={retry} />
                    </DashboardPanel>
                ) : !profile ? (
                    <DashboardPanel>
                        <ErrorState kind="unknown" onRetry={retry} />
                    </DashboardPanel>
                ) : (
                    <div className="anim-fade-in space-y-6">
                        {refreshError && (
                            <InlineFeedback tone="warning">{tCommon('feedback.refresh_failed')}</InlineFeedback>
                        )}

                        <DashboardPanel>
                            {/* PanelHeader's geometry, plus the avatar it has no slot for. */}
                            <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                                <div className="flex min-w-0 items-center gap-3">
                                    <InitialsAvatar name={profile.full_name ?? ''} fallback="W" size={36} />
                                    <h2 className="min-w-0 truncate text-base font-extrabold text-[var(--jale-ink)]">
                                        {profile.full_name ?? t('info_title')}
                                    </h2>
                                </div>
                                {!editing && (
                                    <Button variant="outline" size="sm" onClick={startEditing}>
                                        {t('edit_button')}
                                    </Button>
                                )}
                            </div>

                            {editing ? (
                                <div className="anim-fade-in px-5 py-5">
                                    <ProfileEditForm
                                        initial={profile}
                                        onCancel={() => setEditing(false)}
                                        onSave={handleSave}
                                    />
                                </div>
                            ) : (
                                <div className="anim-fade-in px-5 py-3">
                                    {saved && (
                                        <InlineFeedback
                                            tone="success"
                                            onDismiss={() => setSaved(false)}
                                            className="mb-3 mt-2"
                                        >
                                            {tCommon('feedback.saved')}
                                        </InlineFeedback>
                                    )}
                                    <KVList
                                        items={[
                                            { label: t('field_phone'), value: <span className="tabular-nums">{profile.phone}</span> },
                                            { label: t('field_name'), value: profile.full_name || t('empty_name') },
                                            {
                                                label: t('field_skills'),
                                                value: <BadgeList items={profile.skills} emptyLabel={t('empty_skills')} />,
                                            },
                                            {
                                                label: t('field_certifications'),
                                                value: (
                                                    <BadgeList
                                                        items={profile.certifications ?? []}
                                                        emptyLabel={t('empty_certifications')}
                                                        tone="info"
                                                    />
                                                ),
                                            },
                                            {
                                                label: t('field_availability'),
                                                value:
                                                    profile.availability && AVAILABILITY_KEYS.includes(profile.availability)
                                                        ? t(`availability.${profile.availability}`)
                                                        : t('empty_availability'),
                                            },
                                            {
                                                label: t('field_years_experience'),
                                                // `tabular-nums` only wraps an actual number; a
                                                // sentence has no columns to align.
                                                value:
                                                    profile.years_experience === null ||
                                                    profile.years_experience === undefined ? (
                                                        t('empty_experience')
                                                    ) : (
                                                        <span className="tabular-nums">{profile.years_experience}</span>
                                                    ),
                                            },
                                            { label: t('field_location'), value: profile.location || t('empty_location') },
                                            {
                                                label: t('edit.preferred_cities_label'),
                                                value: (
                                                    <BadgeList
                                                        items={(profile.preferred_cities ?? []).map((c) => `${c.city}, ${c.state}`)}
                                                        emptyLabel={t('empty_preferred_cities')}
                                                    />
                                                ),
                                            },
                                            { label: t('field_bio'), value: profile.bio || t('empty_bio') },
                                        ]}
                                    />
                                </div>
                            )}
                        </DashboardPanel>

                        {/* id="documents" kept from the original markup for future deep-linking. */}
                        <div id="documents">
                            <DashboardPanel>
                                <PanelHeader title={t('documents_title')} />
                                <div className="space-y-4 px-5 py-5">
                                    <p className="text-xs text-[var(--jale-ink-2)]">{t('documents_subtitle')}</p>
                                    {/* One bordered container, divided rows — the slots draw no
                                        box of their own so the stack reads as a single list. */}
                                    <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
                                        {DOC_TYPES.map((dt) => (
                                            <li key={dt}>
                                                <DocumentSlot
                                                    token={idToken!}
                                                    doc_type={dt}
                                                    existing={docs.find((d) => d.doc_type === dt)}
                                                    onChange={refresh}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </DashboardPanel>
                        </div>
                    </div>
                )}
            </main>
        </AppShell>
    );
}

/**
 * A KV row whose value is a set of chips. Right-aligned to sit under the
 * column the dashed rows establish, wrapping onto more lines at 390px rather
 * than squeezing the label.
 */
/**
 * `emptyLabel` is required, not defaulted: an empty list is a real answer
 * ("no certifications"), and every caller knows which field it is talking
 * about. A shared default would be a bare dash again, one indirection further
 * away.
 */
function BadgeList({
    items,
    emptyLabel,
    tone = 'neutral',
}: {
    items: string[];
    emptyLabel: string;
    tone?: 'neutral' | 'info';
}) {
    // Plain text, so an empty list reads in the same ink as every other "not
    // set" value in the list rather than as a differently-styled special case.
    if (items.length === 0) return <>{emptyLabel}</>;

    return (
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            {items.map((item) => (
                <Badge key={item} tone={tone}>
                    {item}
                </Badge>
            ))}
        </span>
    );
}
