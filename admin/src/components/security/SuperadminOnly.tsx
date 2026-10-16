import Link from 'next/link';
import { primaryLinkClass } from '@/components/security/link-styles';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';

/**
 * What a non-superadmin sees on Admins and Security. The loader has already
 * recorded the refused attempt; the response status stays 200.
 */
export function SuperadminOnly({ title, body }: { title: string; body: string }) {
  return (
    <DashboardPanel as="section" className="flex flex-col items-start gap-4 p-6 sm:p-8">
      <Badge tone="danger">403</Badge>
      <h1 className="text-2xl font-extrabold tracking-tight text-balance text-[var(--jale-ink)]">{title}</h1>
      <p className="text-sm text-[var(--jale-ink-2)]">{body}</p>
      <Link className={primaryLinkClass} href="/" prefetch={false}>Back to Home</Link>
    </DashboardPanel>
  );
}
