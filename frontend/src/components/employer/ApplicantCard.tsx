'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Applicant } from '@/lib/mockData';

interface Props {
  applicant: Applicant;
  onViewProfile?: (id: string) => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(' ');
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return (first + (parts.length > 1 ? last : '')).toUpperCase();
}

const statusStyles: Record<Applicant['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  hired: 'bg-green-100 text-green-700',
};

export function ApplicantCard({ applicant, onViewProfile }: Props) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();

  const formattedDate = new Date(applicant.appliedAt + 'T00:00:00').toLocaleDateString(
    locale === 'es' ? 'es-MX' : 'en-US',
    { month: 'short', day: 'numeric', year: 'numeric' }
  );

  const statusLabel = {
    pending: t('applicants.status.pending'),
    reviewed: t('applicants.status.reviewed'),
    hired: t('applicants.status.hired'),
  }[applicant.status];

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 font-semibold text-sm">
          {getInitials(applicant.name)}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-foreground leading-tight">{applicant.name}</p>
          <p className="text-sm text-muted truncate">{applicant.jobTitle}</p>
        </div>
        <span className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[applicant.status]}`}>
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted">
          <span className="font-medium text-foreground">{t('applicants.applied')}: </span>
          {formattedDate}
        </p>
        <p className="text-muted">
          <span className="font-medium text-foreground">{t('applicants.phone')}: </span>
          {applicant.phone}
        </p>
      </div>

      {applicant.skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {applicant.skills.map((skill) => (
            <span key={skill} className="bg-gray-100 text-gray-600 text-xs rounded px-2 py-0.5">
              {skill}
            </span>
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onViewProfile?.(applicant.id)}
      >
        {t('applicants.view_profile')}
      </Button>
    </Card>
  );
}
