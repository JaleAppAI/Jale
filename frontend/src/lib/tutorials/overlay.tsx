'use client';

import { createContext, use, useEffect, useId, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Overlay coordinator: one overlay at a time.
 *
 * Every overlay reports whether it is open through `useOverlayPresence(open)`,
 * and a tutorial auto-opens only when nothing is. `ui/modal.tsx` and
 * `ui/sheet.tsx` report for every dialog built on them (ruling R2), so only an
 * overlay that is neither, such as the conversation drawer, adds the call
 * itself. A tutorial's own player is a `Modal`, so it counts too, which is
 * what stops a second tutorial from auto-opening over the first.
 *
 * Mounted once in `app/[locale]/layout.tsx`, above every provider that mounts
 * an overlay (ruling R1). With no provider, `useOverlayPresence` does nothing,
 * so the primitives and their tests behave exactly as they did before.
 *
 * Presence is a SET of per-overlay tokens (`useId`), so a second registration
 * of the same overlay (a re-render, React's development double effects) is
 * harmless. It is recorded in the LAYOUT phase, ahead of every passive effect
 * of the same commit, so a host page that asks "may a tutorial open?" from
 * its own effect already sees a dialog that opened in that very commit. It is
 * a plain mutable set, not state: nothing re-renders when an overlay comes or
 * goes, and the tutorial store reads it at the moment it decides.
 *
 * A component that must act when an overlay closes (the worker tour gate)
 * `subscribe`s instead. A listener runs whenever an overlay opens or closes,
 * from the layout phase of the commit that changed it, possibly before the
 * rest of that commit's overlays have registered: it must not decide there,
 * only schedule a check of its own (a state update, read in an effect).
 */

export type OverlayRegistry = {
    /** True while any registered overlay is open. */
    isPresent(): boolean;
    /** Calls `listener` whenever an overlay opens or closes; returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
};

type MutableRegistry = OverlayRegistry & {
    add(token: string): void;
    remove(token: string): void;
};

const OverlayPresenceContext = createContext<MutableRegistry | null>(null);

function createRegistry(): MutableRegistry {
    const present = new Set<string>();
    const listeners = new Set<() => void>();
    const notify = () => {
        // A copy: a listener may unsubscribe while being told.
        for (const listener of Array.from(listeners)) listener();
    };
    return {
        add: (token) => {
            if (present.has(token)) return;
            present.add(token);
            notify();
        },
        remove: (token) => {
            if (!present.delete(token)) return;
            notify();
        },
        isPresent: () => present.size > 0,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export function OverlayPresenceProvider({ children }: { children: ReactNode }) {
    // One registry for the provider's lifetime.
    const [registry] = useState(createRegistry);
    return <OverlayPresenceContext value={registry}>{children}</OverlayPresenceContext>;
}

/** Client-side `useLayoutEffect`, server-side `useEffect`: overlays render on the server too. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Called by every overlay with its own `open` state, so a tutorial never
 * auto-opens on top of another overlay. Call it before any early return.
 */
export function useOverlayPresence(open: boolean): void {
    const registry = use(OverlayPresenceContext);
    const token = useId();
    useIsomorphicLayoutEffect(() => {
        if (!open || registry === null) return;
        registry.add(token);
        return () => registry.remove(token);
    }, [open, registry, token]);
}

/** The registry the tutorial store reads, or null outside the provider. */
export function useOverlayRegistry(): OverlayRegistry | null {
    return use(OverlayPresenceContext);
}
