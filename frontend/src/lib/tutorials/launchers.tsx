'use client';

import { createContext, use, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { TutorialId } from '@/lib/api/tutorials';

/**
 * Guide launchers: how the Help center starts a task's step-by-step guide.
 *
 * A guide plays inside its task's host (the post-job wizard), so only the
 * host's owner can start one: it opens the host the way its own button does
 * (the plan gate first, for posting a job) and asks for the guide as a
 * replay. The owner registers that here (`useRegisterGuideLauncher`) for as
 * long as it can do it; Help shows "Guide me through it" on the row of every
 * guide that has a launcher (`useGuideLaunchers`), and nothing for the rest.
 * So a guide gets its Help action from its own host, and Help itself names
 * none.
 *
 * Mounted by `TutorialProgressProvider`. Without it nothing registers and
 * Help shows no launcher.
 */

export type GuideLauncher = () => void;

type LauncherStore = {
    subscribe(listener: () => void): () => void;
    getSnapshot(): ReadonlyMap<TutorialId, GuideLauncher>;
    /** Registers `launch` for `id` (the latest wins); returns its removal. */
    register(id: TutorialId, launch: GuideLauncher): () => void;
};

const NONE: ReadonlyMap<TutorialId, GuideLauncher> = new Map();

function createLauncherStore(): LauncherStore {
    let launchers: ReadonlyMap<TutorialId, GuideLauncher> = NONE;
    const listeners = new Set<() => void>();
    const set = (next: ReadonlyMap<TutorialId, GuideLauncher>) => {
        launchers = next;
        for (const listener of Array.from(listeners)) listener();
    };
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => launchers,
        register(id, launch) {
            set(new Map(launchers).set(id, launch));
            return () => {
                if (launchers.get(id) !== launch) return;
                const next = new Map(launchers);
                next.delete(id);
                set(next);
            };
        },
    };
}

const LauncherContext = createContext<LauncherStore | null>(null);

export function GuideLaunchersProvider({ children }: { children: ReactNode }) {
    const [store] = useState(createLauncherStore);
    return <LauncherContext value={store}>{children}</LauncherContext>;
}

const noSubscription = () => () => {};
const noLaunchers = () => NONE;

/** Every guide that can be started from Help now, by tutorial id. */
export function useGuideLaunchers(): ReadonlyMap<TutorialId, GuideLauncher> {
    const store = use(LauncherContext);
    return useSyncExternalStore(
        store?.subscribe ?? noSubscription,
        store?.getSnapshot ?? noLaunchers,
        noLaunchers,
    );
}

/** Offers Help a way to start `id`'s guide while `launch` is not null. */
export function useRegisterGuideLauncher(id: TutorialId, launch: GuideLauncher | null): void {
    const store = use(LauncherContext);
    useEffect(() => {
        if (store === null || launch === null) return;
        return store.register(id, launch);
    }, [store, id, launch]);
}
