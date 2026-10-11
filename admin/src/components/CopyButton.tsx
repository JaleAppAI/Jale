'use client';

import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

type CopyButtonProps = {
  /** The exact text to copy. */
  value: string;
  /** The visible label, for example "Copy id". */
  label: string;
  /** The accessible name when the visible label alone is ambiguous. */
  accessibleLabel?: string;
};

const RESET_AFTER_MS = 2000;

/** Copies one value to the clipboard and says so, visibly and to screen readers. */
export function CopyButton({ value, label, accessibleLabel }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = window.setTimeout(() => setState('idle'), RESET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="copy-control">
      <button
        aria-label={accessibleLabel}
        className="button secondary copy-button"
        onClick={() => { void copy(); }}
        type="button"
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
      <span aria-live="polite" className="visually-hidden">
        {state === 'copied' ? 'Copied to the clipboard.' : state === 'failed' ? 'Could not copy. Select the text and copy it by hand.' : ''}
      </span>
    </span>
  );
}
