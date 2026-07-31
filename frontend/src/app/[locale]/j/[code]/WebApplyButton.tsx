import { Link } from '@/i18n/navigation';

interface WebApplyButtonProps {
  jobId: string;
  shareCode?: string;
  label: string;
}

/**
 * Secondary CTA for the referred stranger who'd rather sign up on the
 * website than through WhatsApp. Visually quiet (outline) so the WhatsApp
 * button stays primary. Adds no data fetch -- the link is built entirely
 * from data already on the page. Rendered as a styled <a> (not a <button>
 * nested inside one) since this is pure navigation, not an async action.
 * Label is passed down from the page (which already has `t` in scope) so
 * this stays a plain presentational server component with no i18n hook of
 * its own.
 */
export function WebApplyButton({ jobId, shareCode, label }: WebApplyButtonProps) {
  const params = new URLSearchParams({ returnTo: `/worker/jobs/${jobId}` });
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
