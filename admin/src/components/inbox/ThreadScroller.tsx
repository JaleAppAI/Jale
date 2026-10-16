'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { FOCUS_RING } from './styles';

/**
 * The thread's scroll box. On load, and whenever a message is added, it shows
 * the newest message by setting scrollTop. It never moves focus and never
 * animates, so it is safe for reduced motion. It is a focusable named region,
 * so keyboard users can scroll it.
 */
export function ThreadScroller({ count, label, children }: { count: number; label: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);
  return (
    <div
      aria-label={label}
      className={`max-h-[min(70vh,48rem)] overflow-y-auto overscroll-contain bg-[var(--jale-paper)] ${FOCUS_RING}`}
      ref={box}
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
