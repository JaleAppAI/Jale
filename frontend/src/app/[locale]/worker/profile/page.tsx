'use client';
import { useEffect, useState } from 'react';
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
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { MediaBoardGrid } from '@/components/media-board/MediaBoardGrid';
import { PostLightbox } from '@/components/media-board/PostLightbox';
import { NewPostModal } from '@/components/media-board/NewPostModal';
import { getVaultDocuments, updateWorkerProfile, getWorkerPosts, deleteWorkerPost } from '@/lib/api/worker';
import type { WorkerProfileData, WorkerProfilePatch, WorkerVaultDoc, DocType, WorkerPost } from '@/lib/api/worker';
import { readPendingReferral, clearPendingReferral, validateJobId } from '@/lib/referral-return';

export const dynamic = 'force-dynamic';

// The vault slots offered on this page. `work_auth_doc` is here because the
// backend has accepted it since migration 074 (canonical DOC_TYPES,
// infra/lambda/lib/job-fields.ts) and a job may require it -- without a slot,
// that requirement was unsatisfiable from the web.
// `certification_doc` is deliberately NOT offered here: it is a multi-file,
// per-`cert_name` slot (078_worker_documents_cert_name.sql) and this page has
// no cert_name plumbing -- it is uploaded from inside the apply flow instead.
const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'work_auth_doc'];

const AVAILABILITY_KEYS = ['full_time', 'part_time', 'weekends', 'flexible'];

/** Everything the page renders, fetched as one unit so it loads as one unit. */
type WorkerProfilePageData = {
    profile: WorkerProfileData;
    docs: WorkerVaultDoc[];
    posts: WorkerPost[];
    next_before: string | null;
    next_before_id: string | null;
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
        main_trade: raw.main_trade ?? null,
        main_trade_other: raw.main_trade_other ?? null,
    };
}

export default function WorkerProfilePage() {
    const { idToken } = useAuth();
    const router = useRouter();
    const t = useTranslations('worker_profile');
    const tCommon = useTranslations('common');
    const tMedia = useTranslations('media_board');

    const [editing, setEditing] = useState(false);
    const [saved, setSaved] = useState(false);
    const [selectedPost, setSelectedPost] = useState<WorkerPost | null>(null);
    const [composing, setComposing] = useState(false);
    const [postFeedback, setPostFeedback] = useState<string | null>(null);

    // Local pagination state for "load more": posts fetched beyond the
    // page's initial batch, plus the keyset cursor to fetch the next one.
    const [extraPosts, setExtraPosts] = useState<WorkerPost[]>([]);
    const [cursor, setCursor] = useState<{ before: string; before_id: string } | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

    const { phase, data, errorKind, refreshError, retry, refresh } = usePageData<WorkerProfilePageData>({
        fetcher: async ({ token, signal }) => {
            const res = await apiFetch('/worker/profile', { signal }, token);
            if (!res.ok) throw await parseApiError(res, 'fetch_failed');
            let profile = toWorkerProfile(await res.json());
            const d = await getVaultDocuments(token, signal);
            const docs = d.documents;
            const postsRes = await getWorkerPosts(token, undefined, signal);

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
                    return {
                        profile,
                        docs,
                        posts: postsRes.posts,
                        next_before: postsRes.next_before,
                        next_before_id: postsRes.next_before_id,
                    };
                }
            }
            return {
                profile,
                docs,
                posts: postsRes.posts,
                next_before: postsRes.next_before,
                next_before_id: postsRes.next_before_id,
            };
        },
        legalReturnUrl: '/worker/profile',
    });

    // Re-initialize load-more state whenever fresh page data lands: a first
    // load, a retry, or a post-create/delete refresh must all start the
    // cursor fresh so `allPosts` below can't double-show rows.
    useEffect(() => {
        setExtraPosts([]);
        setCursor(
            data?.next_before && data?.next_before_id
                ? { before: data.next_before, before_id: data.next_before_id }
                : null,
        );
        setLoadMoreError(null);
    }, [data]);

    const allPosts = [...(data?.posts ?? []), ...extraPosts];

    async function loadMore() {
        if (!cursor || !idToken) return;
        setLoadMoreError(null);
        try {
            const page = await getWorkerPosts(idToken, cursor);
            setExtraPosts((prev) => [...prev, ...page.posts]);
            setCursor(
                page.next_before && page.next_before_id
                    ? { before: page.next_before, before_id: page.next_before_id }
                    : null,
            );
        } catch {
            setLoadMoreError(tMedia('load_more_error'));
        }
    }

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
                                                    <div className="flex flex-col items-end gap-1.5">
                                                        <BadgeList
                                                            items={(profile.preferred_cities ?? []).map((c) => `${c.city}, ${c.state}`)}
                                                            emptyLabel={t('empty_preferred_cities')}
                                                        />
                                                        {/* Nullable-safe: no main_trade, or no preferred city yet,
                                                            and PayReferenceHint's own guard (blank/'other' trade,
                                                            no city_key) renders nothing. */}
                                                        <PayReferenceHint
                                                            trade={profile.main_trade ?? ''}
                                                            cityKey={profile.preferred_cities?.[0]?.city_key}
                                                            variant="worker-profile"
                                                        />
                                                    </div>
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

                        <div id="media-board">
                            <DashboardPanel>
                                <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                                    <h2 className="text-base font-extrabold text-[var(--jale-ink)]">{tMedia('title')}</h2>
                                    <Button variant="outline" size="sm" onClick={() => setComposing(true)}>
                                        {tMedia('new_post')}
                                    </Button>
                                </div>
                                <div className="space-y-4 px-5 py-5">
                                    <p className="text-xs text-[var(--jale-ink-2)]">{tMedia('subtitle')}</p>
                                    {postFeedback && (
                                        <InlineFeedback tone="success" onDismiss={() => setPostFeedback(null)}>
                                            {postFeedback}
                                        </InlineFeedback>
                                    )}
                                    <MediaBoardGrid posts={allPosts} editable onSelect={setSelectedPost} />
                                    {cursor && (
                                        <div className="flex flex-col items-center gap-2">
                                            <Button variant="outline" size="sm" onClick={loadMore}>
                                                {tMedia('load_more')}
                                            </Button>
                                            {loadMoreError && (
                                                <InlineFeedback tone="danger">{loadMoreError}</InlineFeedback>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </DashboardPanel>
                        </div>

                        {composing && idToken && (
                            <NewPostModal
                                token={idToken}
                                onClose={() => setComposing(false)}
                                onCreated={async (flaggedCount) => {
                                    setComposing(false);
                                    setPostFeedback(
                                        flaggedCount > 0 ? tMedia('published_flagged_toast') : tMedia('published_toast'),
                                    );
                                    await refresh();
                                }}
                            />
                        )}

                        {selectedPost && (
                            <PostLightbox
                                post={selectedPost}
                                editable
                                onClose={() => setSelectedPost(null)}
                                onDelete={async (postId) => {
                                    await deleteWorkerPost(idToken!, postId);
                                    setSelectedPost(null);
                                    setPostFeedback(tMedia('deleted_toast'));
                                    await refresh();
                                }}
                            />
                        )}
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
