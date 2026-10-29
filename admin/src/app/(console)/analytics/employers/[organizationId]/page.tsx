import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompanyFacts, CompanyMembers } from '@/components/analytics/CompanyDetail';
import { BACK_LINK, MUTED, PAGE_TITLE } from '@/components/inbox/styles';
import { employerLabel } from '@/lib/employer-health';
import { loadCompany } from '@/lib/server/admin-analytics';
import { requireAdminSession } from '@/lib/server/session';

// A static title: a metadata function would load the company a second time,
// and every load writes an audit record.
export const metadata: Metadata = { title: 'Company' };

export const dynamic = 'force-dynamic';

export default async function CompanyPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const session = await requireAdminSession();
  const { organizationId } = await params;
  // Records every member's id under admin.analytics_company_members before rendering.
  const { company, members } = await loadCompany(session, organizationId);
  if (!company) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-[74rem] flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link className={BACK_LINK} href="/analytics/employers" prefetch={false}><span aria-hidden="true">←</span> Employers</Link>
        <h1 className={PAGE_TITLE}>{employerLabel(company.displayName, company.ownerId)}</h1>
        <p className={MUTED}>Members are shown by name only. Opening this page is recorded in the access history.</p>
      </header>
      <CompanyFacts company={company} />
      <CompanyMembers members={members} />
    </div>
  );
}
