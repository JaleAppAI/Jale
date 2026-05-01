import { Card } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import type { Job } from '@/lib/api/worker';

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  driver_license: "Driver's License",
  ssn: 'SSN',
};

export function WorkerJobCard({ job, href }: { job: Job; href: string }) {
  return (
    <Link href={href} className="block">
      <Card className="p-4 hover:shadow-sm transition-shadow">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div>
            <p className="text-base font-semibold">{job.title}</p>
            <p className="text-xs text-muted-foreground">{job.company_name} · {job.location}</p>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
            {job.job_type.replace('-', ' ')}
          </span>
        </div>
        {job.required_docs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {job.required_docs.map((d) => (
              <span key={d} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {DOC_LABELS[d] ?? d}
              </span>
            ))}
          </div>
        )}
      </Card>
    </Link>
  );
}
