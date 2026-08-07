'use client';

import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';

interface WebApplyButtonProps {
  jobId: string;
  label: string;
}

/**
 * Secondary CTA for the referred stranger who'd rather sign up on the
 * website than through WhatsApp. Visually quiet (outline) so the WhatsApp
 * button stays primary. Reads the `?r=` share tag itself via
 * `useSearchParams` (a client hook -- nothing server-side may read
 * searchParams on this route, since doing so would force dynamic
 * rendering). Rendered as a styled <a> (not a <button> nested inside one)
 * since this is pure navigation, not an async action. Label is still passed
 * down from the page (which already has `t` in scope) so this component
 * doesn't need its own i18n hook.
 */
export function WebApplyButton({ jobId, label }: WebApplyButtonProps) {
  const searchParams = useSearchParams();
  const shareCode = searchParams.get('r');
  const params = new URLSearchParams({ job: jobId });
  if (shareCode) params.set('share', shareCode);

  return (
    <Link
      href={`/auth/worker?${params.toString()}`}
      className="mt-2 flex w-full items-center justify-center rounded-xl border border-[var(--jale-divider)] bg-white px-6 py-3 text-base font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jale-blue-500)]"
    >
      {label}
    </Link>
  );
}
