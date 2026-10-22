'use client';

import type { ReactNode } from 'react';

/**
 * Tutorial progress store: loads this account's tutorial records once per
 * session and records how an auto-opened tutorial was dismissed.
 *
 * PLACEHOLDER. The export keeps its final name so the signed-in shells can
 * mount it now; the tutorial framework lane fills in the body. Until then the
 * provider renders its children unchanged and loads nothing.
 */
export function TutorialProgressProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
