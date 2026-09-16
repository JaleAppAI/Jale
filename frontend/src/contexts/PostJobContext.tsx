'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/toast';
import { PlanLimitDialog } from '@/components/employer/PlanLimitDialog';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { getBilling, getJobs } from '@/lib/api/employer';
import type { EmployerBilling, Job, JobCreatedOutcome } from '@/lib/api/employer';
import { activeJobsPreflightModel, type PlanLimitModel } from '@/lib/plan-limit';

/**
 * "Post a job", from anywhere in the employer app.
 *
 * The wizard used to be mounted by ONE page. Every other employer surface --
 * applicants, templates, messages, billing, a job's own page -- was a dead end
 * for the single most common thing an employer comes here to do: they had to
 * navigate back to the dashboard first. So the modal, its plan-limit preflight
 * and the "a job was created" fan-out all move up here, above the router, and
 * any page opts in by rendering `<PostJobButton />` (see
 * `components/employer/PostJobButton.tsx`).
 *
 * THE PREFLIGHT is the part that has to be got right. `activeJobsPreflightModel`
 * answers "would a post be refused?" from billing plus the LIVE count of active
 * jobs, so a free-plan employer whose one slot is taken is told before they
 * write a draft rather than by a 403 three steps in. It needs two things this
 * context does not otherwise have -- the plan and the jobs list -- so:
 *
 *  - a page already holding them (the dashboard) publishes them with
 *    `usePostJobSnapshot`, and the gate is then decided synchronously, with no
 *    request at all;
 *  - any other page causes ONE lazy fetch on the first open, cached for the
 *    session and invalidated whenever a job is created.
 *
 * `activeCount` is derived from the jobs list on both paths, never from
 * `billing.activeJobUsage`: that field is a load-time snapshot, and pausing a
 * job frees a slot the snapshot still shows as used.
 *
 * The gate is deliberately optimistic -- no billing, or a failed read, means no
 * gate -- because the publish-time 403 is still the backstop and locking an
 * employer out of posting on a slow request would be worse than the bug this
 * prevents.
 */

/** What the preflight needs. A page that already has it can skip the fetch. */
export type PostJobSnapshot = {
    billing: EmployerBilling | null;
    jobs: Job[];
    /** Active jobs as the page counts them right now — not `activeJobUsage`. */
    activeCount: number;
};

export type JobCreatedListener = (job: Job, outcome?: JobCreatedOutcome) => void;

type PostJobValue = {
    /** Opens the wizard, or the limit dialog when the plan has no slot left. */
    openPostJob: (snapshot?: PostJobSnapshot) => void;
    /** True while the lazy billing/jobs read behind the gate is in flight. */
    opening: boolean;
    /** Registers a listener for posted jobs; returns its unsubscribe. */
    subscribeJobCreated: (listener: JobCreatedListener) => () => void;
    /** Publishes a page's already-loaded plan + jobs to the preflight. */
    registerSnapshot: (snapshot: PostJobSnapshot | null) => void;
};

const PostJobContext = createContext<PostJobValue | null>(null);

function activeJobsIn(jobs: Job[]): number {
    return jobs.filter((job) => job.status === 'active').length;
}

export function PostJobProvider({ children }: { children: ReactNode }) {
    const { idToken, isAuthenticated, userType } = useAuth();
    const t = useTranslations('employer_dashboard');
    const toast = useToast();

    const [open, setOpen] = useState(false);
    const [opening, setOpening] = useState(false);
    const [planLimit, setPlanLimit] = useState<PlanLimitModel | null>(null);

    /** A snapshot published by the page on screen, when it has one. */
    const pageSnapshotRef = useRef<PostJobSnapshot | null>(null);
    /** The snapshot this context fetched itself, kept for the session. */
    const fetchedSnapshotRef = useRef<PostJobSnapshot | null>(null);
    const listenersRef = useRef(new Set<JobCreatedListener>());
    /*
     * `Modal`'s own focus restore cannot see the control that opened the LIMIT
     * dialog: on the pages that fetch first, the button is `loading` (and so
     * disabled, and so blurred) by the time the dialog mounts, leaving
     * `document.activeElement` on <body>. Captured at click time instead — the
     * same fix the dashboard already applies to its 403 path.
     */
    const openerRef = useRef<HTMLElement | null>(null);

    const isEmployer = isAuthenticated && userType === 'employer';

    const registerSnapshot = useCallback((snapshot: PostJobSnapshot | null) => {
        pageSnapshotRef.current = snapshot;
    }, []);

    const subscribeJobCreated = useCallback((listener: JobCreatedListener) => {
        listenersRef.current.add(listener);
        return () => {
            listenersRef.current.delete(listener);
        };
    }, []);

    const applySnapshot = useCallback((snapshot: PostJobSnapshot | null) => {
        const gate = activeJobsPreflightModel(
            snapshot?.billing ?? null,
            snapshot?.activeCount ?? 0,
            snapshot?.jobs ?? null,
        );
        if (gate) {
            setPlanLimit(gate);
            return;
        }
        setOpen(true);
    }, []);

    /**
     * The plan and the jobs list, for a page that does not already hold them.
     *
     * Both calls go out together — a sequential pair would make the first click
     * on every non-dashboard page wait out two round trips. Either failing
     * degrades rather than blocks: no billing means no gate, and no jobs list
     * means no named "pause this one instead" suggestions.
     */
    const fetchSnapshot = useCallback(async (token: string): Promise<PostJobSnapshot> => {
        const [jobs, billing] = await Promise.all([
            getJobs(token).catch(() => [] as Job[]),
            getBilling(token).catch(() => null),
        ]);
        return { billing, jobs, activeCount: activeJobsIn(jobs) };
    }, []);

    const openPostJob = useCallback(
        (snapshot?: PostJobSnapshot) => {
            openerRef.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;

            const known = snapshot ?? pageSnapshotRef.current ?? fetchedSnapshotRef.current;
            if (known || !idToken) {
                // Synchronous whenever the answer is already known, so the
                // wizard opens in the same frame as the click.
                applySnapshot(known ?? null);
                return;
            }

            setOpening(true);
            fetchSnapshot(idToken)
                .then((fetched) => {
                    fetchedSnapshotRef.current = fetched;
                    applySnapshot(fetched);
                })
                .finally(() => setOpening(false));
        },
        [applySnapshot, fetchSnapshot, idToken],
    );

    const handleJobCreated = useCallback(
        (job: Job, outcome?: JobCreatedOutcome) => {
            setOpen(false);
            toast.success(t('jobs.post_success'));
            // The new job changes the answer the gate gives, and this context
            // cannot know what the page's own snapshot will do about it — so
            // the one it owns is dropped and re-read on the next open.
            fetchedSnapshotRef.current = null;
            for (const listener of listenersRef.current) listener(job, outcome);
        },
        [t, toast],
    );

    const handlePlanLimitClose = useCallback(() => {
        setPlanLimit(null);
        const opener = openerRef.current;
        openerRef.current = null;
        // Next frame: the opening button may still be `loading` (and so
        // unfocusable) in the current commit, and the Modal's own restore has
        // to land first. `requestAnimationFrame` is absent in some test DOMs.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => opener?.focus());
        } else {
            opener?.focus();
        }
    }, []);

    /*
     * There is deliberately no "reset on sign-out" effect here. Ending a
     * session is always a document navigation in this app -- `logout` assigns
     * `window.location.href` and `onSessionExpired` calls `location.assign` --
     * so this provider is destroyed with the page rather than left holding a
     * previous account's plan. An effect resetting state for a transition that
     * cannot happen would only add a render cascade.
     */

    const value = useMemo<PostJobValue>(
        () => ({ openPostJob, opening, subscribeJobCreated, registerSnapshot }),
        [openPostJob, opening, subscribeJobCreated, registerSnapshot],
    );

    return (
        <PostJobContext.Provider value={value}>
            {children}
            {/* Worker routes share this layout, and a signed-out visitor has no
                wizard to open — neither mounts any of it. */}
            {isEmployer ? (
                <>
                    <PostJobModal
                        open={open}
                        onClose={() => setOpen(false)}
                        onJobCreated={handleJobCreated}
                    />
                    <PlanLimitDialog
                        open={planLimit !== null}
                        model={planLimit}
                        onClose={handlePlanLimitClose}
                    />
                </>
            ) : null}
        </PostJobContext.Provider>
    );
}

export function usePostJob(): PostJobValue {
    const ctx = useContext(PostJobContext);
    if (!ctx) throw new Error('usePostJob must be used inside PostJobProvider');
    return ctx;
}

/**
 * Publishes the plan + jobs the calling page already holds, so the preflight
 * needs no request of its own. Pass `null` while the page is still loading.
 */
export function usePostJobSnapshot(snapshot: PostJobSnapshot | null): void {
    const { registerSnapshot } = usePostJob();
    useEffect(() => {
        registerSnapshot(snapshot);
        return () => registerSnapshot(null);
    }, [registerSnapshot, snapshot]);
}

/**
 * Runs `onCreated` whenever a job is posted from anywhere in the app. The
 * listener is read through a ref, so a page may pass an inline closure without
 * re-subscribing on every render.
 */
export function useJobCreated(onCreated: JobCreatedListener): void {
    const { subscribeJobCreated } = usePostJob();
    const listenerRef = useRef(onCreated);
    useEffect(() => {
        listenerRef.current = onCreated;
    }, [onCreated]);
    useEffect(
        () => subscribeJobCreated((job, outcome) => listenerRef.current(job, outcome)),
        [subscribeJobCreated],
    );
}
