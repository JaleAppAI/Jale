import type { ReportCategory, ReportRole } from '@/lib/report/categories';
import type { ReportConfig } from '@/lib/api/reports';
import type { CaptureResult } from './seams/report-capture';

/** What a screen reports with, when it opens the form from an error. */
export type ReportedError = { kind: string; status?: number; code?: string };

/**
 * One open report form. Created by `openReport`, which starts the capture and
 * the config read in the same tick as the tap; the form subscribes to both.
 */
export type ReportSession = {
    id: number;
    role: ReportRole;
    /** Whether the form starts in its signed-in version. It can switch to signed out, never back. */
    signedIn: boolean;
    category: ReportCategory;
    capture: Promise<CaptureResult>;
    config: Promise<ReportConfig>;
};

/** The catalogue a role's own sentences live in: tú for workers, usted for employers. */
export function roleNamespace(role: ReportRole): 'report_worker' | 'report_employer' {
    return role === 'employer' ? 'report_employer' : 'report_worker';
}
