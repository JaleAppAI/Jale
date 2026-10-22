'use client';

import type { ReactNode } from 'react';

/**
 * Overlay coordinator: one overlay at a time.
 *
 * PLACEHOLDER. These exports keep their final signatures so that overlays and
 * host pages can call them now; the tutorial framework lane fills in the
 * bodies. Until then the provider renders its children unchanged and
 * `useOverlayPresence` does nothing.
 */
export function OverlayPresenceProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Called by every overlay with its own `open` state, so a tutorial never
 * auto-opens on top of another overlay. Placeholder: does nothing yet.
 */
export function useOverlayPresence(open: boolean): void {
  void open;
}
