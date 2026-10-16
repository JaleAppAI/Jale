import Link from 'next/link';

/** The 404 card: inside the console shell, or alone for an unmatched URL. */
export function NotFoundCard() {
  return (
    <section
      aria-labelledby="not-found-title"
      className="w-full max-w-md rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-8 text-center shadow-[var(--shadow-card)]"
    >
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]">Error 404</p>
      <h1 id="not-found-title" className="mt-2 text-2xl font-extrabold tracking-[-0.02em] text-[var(--jale-ink)]">
        That admin page does not exist.
      </h1>
      <p className="mt-2 text-sm text-[var(--jale-ink-2)]">Check the address, or go back to Home.</p>
      <Link
        href="/"
        prefetch={false}
        className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-[var(--jale-blue-500)] px-5 text-sm font-semibold text-white shadow-[var(--shadow-btn)] transition-colors hover:bg-[var(--jale-blue-600)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        Back to Home
      </Link>
    </section>
  );
}
