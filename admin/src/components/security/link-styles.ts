// Links drawn in the Button primitive's shapes. A Link stays a link (it
// navigates), so it is not the Button component itself.
export const primaryLinkClass = [
  'inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-semibold',
  'bg-[var(--jale-blue-500)] text-white transition-colors hover:bg-[var(--jale-blue-600)]',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

export const secondaryLinkClass = [
  'inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-semibold',
  'border border-[var(--jale-divider)] text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper)]',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');
