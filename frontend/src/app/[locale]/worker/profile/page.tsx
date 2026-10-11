'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { apiFetch } from '@/lib/api';
import { parseApiError } from '@/lib/api/errors';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { BadgeList } from '@/components/ui/badge-list';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { FactsCard } from '@/components/ui/facts-card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { ProfileSkeleton } from '@/components/ui/profile-skeleton';
import { ProfileEditForm } from '@/components/worker/ProfileEditForm';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { MediaBoardGrid } from '@/components/media-board/MediaBoardGrid';
import { PostLightbox } from '@/components/media-board/PostLightbox';
import { NewPostModal } from '@/components/media-board/NewPostModal';
import { getVaultDocuments, updateWorkerProfile, getWorkerPosts, deleteWorkerPost } from '@/lib/api/worker';
import type { WorkerProfileData, WorkerProfilePatch, WorkerVaultDoc, DocType, WorkerPost } from '@/lib/api/worker';

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
            // No `pendingWorkerProfile` flush any more: worker signup is
            // phone-only and the profile is collected by /worker/onboarding
            // against the real engine, which also owns the hand-off to a
            // pending referral job when the run finishes.
            const profile = toWorkerProfile(await res.json());
            const d = await getVaultDocuments(token, signal);
            const docs = d.documents;
            const postsRes = await getWorkerPosts(token, undefined, signal);

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

    /*
     * The facts card's chip-valued and numeric facts, derived once.
     *
     * `BadgeList` renders NO element for an empty list -- just the bare
     * `emptyLabel` text -- so it cannot carry the tile's muted styling itself.
     * Each tile therefore reads the length here to decide whether its value is
     * a real answer or a placeholder.
     */
    const skills = profile?.skills ?? [];
    const certifications = profile?.certifications ?? [];
    const preferredCities = (profile?.preferred_cities ?? []).map((c) => `${c.city}, ${c.state}`);
    const availabilitySet = Boolean(
        profile?.availability && AVAILABILITY_KEYS.includes(profile.availability),
    );
    // Not `!profile?.years_experience`: a worker with 0 years has answered.
    const experienceSet =
        profile?.years_experience !== null && profile?.years_experience !== undefined;

    return (
        <AppShell role="worker" title={t('title')}>
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {showSkeleton ? (
                    /* Same archetype, geometry AND props as `loading.tsx`, so the
                       route-level skeleton and this one are the same picture — the
                       handover from server render to client fetch costs no visible
                       swap. Five tiles, three chip facts, the bio paragraph. */
                    <ProfileSkeleton sections={[5, 3]} />
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
                            <PanelHeader
                                leading={
                                    <InitialsAvatar name={profile.full_name ?? ''} fallback="W" size={36} />
                                }
                                title={profile.full_name ?? t('info_title')}
                                action={
                                    editing ? null : (
                                        <Button variant="outline" size="sm" onClick={startEditing}>
                                            {t('edit_button')}
                                        </Button>
                                    )
                                }
                            />

                            {editing ? (
                                <div className="anim-fade-in px-5 py-5">
                                    <ProfileEditForm
                                        initial={profile}
                                        onCancel={() => setEditing(false)}
                                        onSave={handleSave}
                                    />
                                </div>
                            ) : (
                                <div className="anim-fade-in">
                                    {/* Its own padded block: `FactsCard` owns the card
                                        body's `p-5 md:p-6`, so a padded wrapper around
                                        both would double the card's inset. */}
                                    {saved ? (
                                        <div className="px-5 pt-4">
                                            <InlineFeedback tone="success" onDismiss={() => setSaved(false)}>
                                                {tCommon('feedback.saved')}
                                            </InlineFeedback>
                                        </div>
                                    ) : null}
                                    <FactsCard>
                                        <FactsCard.Section label={t('section_basics')}>
                                            <FactsCard.Tiles>
                                                <FactsCard.Tile label={t('field_name')} muted={!profile.full_name}>
                                                    {profile.full_name || t('empty_name')}
                                                </FactsCard.Tile>
                                                <FactsCard.Tile label={t('field_phone')}>
                                                    <span className="tabular-nums">{profile.phone}</span>
                                                </FactsCard.Tile>
                                                <FactsCard.Tile label={t('field_location')} muted={!profile.location}>
                                                    {profile.location || t('empty_location')}
                                                </FactsCard.Tile>
                                                <FactsCard.Tile
                                                    label={t('field_years_experience')}
                                                    muted={!experienceSet}
                                                >
                                                    {/* `tabular-nums` only wraps an actual number; a
                                                        sentence has no columns to align. */}
                                                    {experienceSet ? (
                                                        <span className="tabular-nums">{profile.years_experience}</span>
                                                    ) : (
                                                        t('empty_experience')
                                                    )}
                                                </FactsCard.Tile>
                                                <FactsCard.Tile
                                                    label={t('field_availability')}
                                                    muted={!availabilitySet}
                                                >
                                                    {availabilitySet
                                                        ? t(`availability.${profile.availability}`)
                                                        : t('empty_availability')}
                                                </FactsCard.Tile>
                                            </FactsCard.Tiles>
                                        </FactsCard.Section>

                                        {/* The chip-valued facts. `align="start"` because a
                                            tile's label sits ABOVE its value: right-aligned
                                            chips would drift off the label naming them. */}
                                        <FactsCard.Section label={t('section_skills')}>
                                            <FactsCard.Tiles>
                                                <FactsCard.Tile
                                                    label={t('field_skills')}
                                                    muted={skills.length === 0}
                                                >
                                                    <BadgeList
                                                        items={skills}
                                                        emptyLabel={t('empty_skills')}
                                                        align="start"
                                                    />
                                                </FactsCard.Tile>
                                                <FactsCard.Tile
                                                    label={t('field_certifications')}
                                                    muted={certifications.length === 0}
                                                >
                                                    <BadgeList
                                                        items={certifications}
                                                        emptyLabel={t('empty_certifications')}
                                                        tone="info"
                                                        align="start"
                                                    />
                                                </FactsCard.Tile>
                                                <FactsCard.Tile
                                                    label={t('edit.preferred_cities_label')}
                                                    muted={preferredCities.length === 0}
                                                >
                                                    <div className="flex min-w-0 flex-col items-start gap-1.5">
                                                        <BadgeList
                                                            items={preferredCities}
                                                            emptyLabel={t('empty_preferred_cities')}
                                                            align="start"
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
                                                </FactsCard.Tile>
                                            </FactsCard.Tiles>
                                        </FactsCard.Section>

                                        {/* Kept even when empty, unlike a job's description:
                                            this is the worker's OWN profile, and "About /
                                            No description added" is the prompt to write
                                            one. Muted so the placeholder does not read as
                                            a fact. */}
                                        <FactsCard.Section label={t('field_bio')}>
                                            <FactsCard.Text muted={!profile.bio}>
                                                {profile.bio || t('empty_bio')}
                                            </FactsCard.Text>
                                        </FactsCard.Section>
                                    </FactsCard>
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
