'use client';

import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { Skeleton } from '@/components/ui/skeleton';

interface WebApplyButtonProps {
  jobId: string;
  label: string;
}

/**
 * The `Button` outline+lg recipe, applied to an anchor.
 *
 * `Button` renders a `<button>`, and this is pure navigation, so the component
 * cannot be reused directly (nor may a `<button>` be nested inside an `<a>`).
 * Mirroring the recipe here is the same escape hatch `StateAction` takes, and
 * it goes away when `Button` grows an `asChild` prop -- changing that API is
 * another owner's call.
 */
const WEB_APPLY_CLASSES = [
  'flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-base font-semibold',
  'border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]',
  'transition-all duration-150 hover:bg-[var(--jale-paper-2)] active:scale-[0.98]',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

/**
 * Suspense fallback for the secondary CTA. Same reason as `ApplyButtonSkeleton`
 * -- `useSearchParams()` keeps this island out of the static render -- and the
 * same geometry as the anchor above (h-12, full width, pill) plus the `mt-2`
 * that separates it from the primary button, so the trust footer below never
 * moves.
 */
export function WebApplyButtonSkeleton() {
  return <Skeleton className="mt-2 h-12 w-full rounded-full" />;
}

/**
 * Secondary CTA for the referred stranger who'd rather sign up on the
 * website than through WhatsApp. Visually quiet (outline) so the WhatsApp
 * button stays primary. Reads the `?r=` share tag itself via
 * `useSearchParams` (a client hook -- nothing server-side may read
 * searchParams on this route, since doing so would force dynamic
 * rendering). Label is still passed down from the page (which already has `t`
 * in scope) so this component doesn't need its own i18n hook.
 */
export function WebApplyButton({ jobId, label }: WebApplyButtonProps) {
  const searchParams = useSearchParams();
  const shareCode = searchParams.get('r');
  const params = new URLSearchParams({ job: jobId });
  if (shareCode) params.set('share', shareCode);

  return (
    <Link href={`/auth/worker?${params.toString()}`} className={`mt-2 ${WEB_APPLY_CLASSES}`}>
      {label}
    </Link>
  );
}
