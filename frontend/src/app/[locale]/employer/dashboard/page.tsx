'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { JobPostingCard } from '@/components/employer/JobPostingCard';
import { ApplicantCard } from '@/components/employer/ApplicantCard';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { mockJobs, mockApplicants, mockStats, type JobPosting } from '@/lib/mockData';

export default function EmployerDashboardPage() {
    useRequireAuth();
    const t = useTranslations('employer_dashboard');

    const [jobs, setJobs] = useState<JobPosting[]>(mockJobs);
    const [modalOpen, setModalOpen] = useState(false);

    function handleToggle(id: string) {
        setJobs(prev =>
            prev.map(job =>
                job.id === id
                    ? { ...job, status: job.status === 'active' ? 'closed' : 'active' }
                    : job
            )
        );
    }

    function handleAddJob(job: JobPosting) {
        setJobs(prev => [job, ...prev]);
        setModalOpen(false);
    }

    return (
        <>
            <main className="mx-auto max-w-5xl px-4 py-10">
                {/* Stats Row */}
                <div className="grid grid-cols-3 gap-4 mb-8">
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.active_jobs')}</p>
                        <p className="text-2xl font-bold">{mockStats.activeJobs}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.total_applicants')}</p>
                        <p className="text-2xl font-bold">{mockStats.totalApplicants}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.total_views')}</p>
                        <p className="text-2xl font-bold">{mockStats.totalViews}</p>
                    </Card>
                </div>

                {/* Job Postings */}
                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold">{t('jobs.title')}</h2>
                        <Button onClick={() => setModalOpen(true)}>{t('jobs.post_job')}</Button>
                    </div>
                    <div className="space-y-3">
                        {jobs.map(job => (
                            <JobPostingCard key={job.id} job={job} onToggle={handleToggle} />
                        ))}
                    </div>
                </div>

                {/* Applicants */}
                <div>
                    <h2 className="text-lg font-semibold mb-4">{t('applicants.title')}</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {mockApplicants.map(applicant => (
                            <ApplicantCard key={applicant.id} applicant={applicant} />
                        ))}
                    </div>
                </div>
            </main>
            <PostJobModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onSubmit={handleAddJob}
            />
        </>
    );
}
