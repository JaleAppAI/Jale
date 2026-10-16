import { NotFoundCard } from '@/components/shell/NotFoundCard';

/** Unmatched URLs: rendered in the root layout only, so it has its own main. */
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-[var(--jale-shell)] px-4 py-12 text-[var(--jale-ink)]">
      <NotFoundCard />
    </main>
  );
}
