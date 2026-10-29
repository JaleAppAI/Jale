import Link from 'next/link';
import { companyHref, employerLabel } from '@/lib/employer-health';

const LINK = 'font-semibold text-[var(--jale-blue-700)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';

/**
 * A company's name as it appears in every list: the shared label (an unnamed
 * company is told apart by its owner's id), linking to the company page. A row
 * with no company (a login with no membership) is plain text. The link never
 * prefetches: opening the page records a read.
 */
export function CompanyLink({
  name,
  ownerId,
  organizationId,
}: {
  name: string;
  ownerId: string;
  organizationId: string | null;
}) {
  const label = employerLabel(name, ownerId);
  if (organizationId === null) return <>{label}</>;
  return (
    <Link href={companyHref(organizationId)} prefetch={false} className={LINK}>
      {label}
    </Link>
  );
}
