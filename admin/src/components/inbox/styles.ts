// Shared class strings for the Inbox views, so headings, muted text, links and
// focus rings read the same everywhere. Colours are FE-1's tokens; blue-700
// and the *-text tokens flip for the dark theme.
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';
export const PAGE_TITLE = 'text-[1.625rem] font-extrabold leading-tight tracking-tight text-[var(--jale-ink)] text-balance [overflow-wrap:anywhere]';
export const PANEL_TITLE = 'text-xs font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]';
export const MUTED = 'text-sm text-[var(--jale-ink-2)]';
export const LABEL = 'text-sm font-semibold text-[var(--jale-ink)]';
export const DANGER_TEXT = 'text-sm font-medium text-[var(--jale-danger-text)]';
export const TEXT_LINK = `rounded-sm font-semibold text-[var(--jale-blue-700)] underline-offset-2 hover:underline ${FOCUS_RING}`;
export const BACK_LINK = `inline-flex min-h-11 w-fit items-center gap-1 text-sm ${TEXT_LINK}`;
export const BUTTON_LINK_OUTLINE = `inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-5 text-sm font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)] ${FOCUS_RING}`;
export const CODE = 'rounded bg-[var(--jale-paper)] px-1.5 py-0.5 font-mono text-xs text-[var(--jale-ink)] [overflow-wrap:anywhere]';
