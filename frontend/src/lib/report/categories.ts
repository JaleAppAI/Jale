/**
 * Report categories, and which one a report starts with.
 *
 * The codes are the database's (the report tables CHECK each one against its
 * role), so they are fixed strings, never copy; the labels live in the
 * `report_worker` / `report_employer` catalogues.
 *
 * Pre-selection only sets the starting radio. The person can always pick
 * another, and the most likely one is chosen from where they were:
 *   1. an explicit category from the caller,
 *   2. else the latest hint a mounted component registered (a screen the URL
 *      cannot describe, like the apply flow inside a job page),
 *   3. else the route table below.
 * A code that does not belong to the role is ignored at every step, and
 * `whatsapp` is never pre-selected: nothing on a web screen can say a report
 * is about WhatsApp messages.
 */

export const WORKER_REPORT_CATEGORIES = [
    'sign_in',
    'finding_jobs',
    'applying',
    'uploads',
    'profile',
    'whatsapp',
    'other',
] as const;

export const EMPLOYER_REPORT_CATEGORIES = [
    'account',
    'job_posting',
    'applicants',
    'messages',
    'billing',
    'emails',
    'company_profile',
    'other',
] as const;

export type WorkerReportCategory = (typeof WORKER_REPORT_CATEGORIES)[number];
export type EmployerReportCategory = (typeof EMPLOYER_REPORT_CATEGORIES)[number];
export type ReportCategory = WorkerReportCategory | EmployerReportCategory;

/** `unknown`: signed out on a screen that implies no role. It uses the worker list. */
export type ReportRole = 'worker' | 'employer' | 'unknown';
export type SignedInRole = 'worker' | 'employer';

export function categoriesFor(role: ReportRole): readonly ReportCategory[] {
    return role === 'employer' ? EMPLOYER_REPORT_CATEGORIES : WORKER_REPORT_CATEGORIES;
}

export function isCategoryFor(role: ReportRole, value: unknown): value is ReportCategory {
    return typeof value === 'string' && (categoriesFor(role) as readonly string[]).includes(value);
}

/** Path segments of a route pattern, without a stray locale prefix. */
function segmentsOf(pattern: string): string[] {
    const segments = pattern.split(/[?#]/)[0].split('/').filter(Boolean);
    if (segments[0] === 'en' || segments[0] === 'es') segments.shift();
    return segments;
}

type Rule = {
    matches: (segments: string[]) => boolean;
    worker?: WorkerReportCategory;
    employer?: EmployerReportCategory;
};

/** The route half of the pre-selection table, first match wins. */
const ROUTE_RULES: readonly Rule[] = [
    {
        matches: ([a, b]) => a === 'auth' || (a === 'legal' && b === 'accept'),
        worker: 'sign_in',
        employer: 'account',
    },
    { matches: ([a, b]) => a === 'worker' && b === 'applications', worker: 'applying' },
    {
        matches: ([a, b]) => (a === 'worker' && (b === 'home' || b === 'jobs')) || a === 'j',
        worker: 'finding_jobs',
    },
    { matches: ([a]) => a === 'upload', worker: 'uploads' },
    { matches: ([a, b]) => a === 'worker' && (b === 'profile' || b === 'onboarding'), worker: 'profile' },
    { matches: ([a, b]) => a === 'employer' && (b === 'jobs' || b === 'templates'), employer: 'job_posting' },
    { matches: ([a, b]) => a === 'employer' && (b === 'applicants' || b === 'workers'), employer: 'applicants' },
    { matches: ([a, b]) => a === 'employer' && b === 'conversations', employer: 'messages' },
    { matches: ([a, b]) => a === 'employer' && b === 'billing', employer: 'billing' },
    { matches: ([a]) => a === 'digest-unsubscribe', employer: 'emails' },
    { matches: ([a, b]) => a === 'employer' && b === 'profile', employer: 'company_profile' },
];

function routeCategory(pattern: string, role: ReportRole): ReportCategory {
    const segments = segmentsOf(pattern);
    const rule = ROUTE_RULES.find((candidate) => candidate.matches(segments));
    const category = role === 'employer' ? rule?.employer : rule?.worker;
    return category ?? 'other';
}

function usable(role: ReportRole, value: string | null | undefined): value is ReportCategory {
    return value !== 'whatsapp' && isCategoryFor(role, value);
}

export function preselectCategory({
    pattern,
    role,
    hint,
    explicit,
}: {
    pattern: string;
    role: ReportRole;
    hint?: string | null;
    explicit?: string | null;
}): ReportCategory {
    if (usable(role, explicit)) return explicit;
    if (usable(role, hint)) return hint;
    return routeCategory(pattern, role);
}

/** The role a route implies on its own, for a visitor who is not signed in. */
export function impliedRoleForPattern(pattern: string): SignedInRole | null {
    const [first] = segmentsOf(pattern);
    if (first === 'worker' || first === 'j') return 'worker';
    if (first === 'employer' || first === 'digest-unsubscribe') return 'employer';
    return null;
}

/**
 * The role a report claims: the signed-in role, else the sign-in screen's
 * variant, else what the route implies, else `unknown`.
 */
export function resolveReportRole({
    userType,
    shellRole,
    pattern,
}: {
    userType: SignedInRole | null;
    shellRole?: SignedInRole | null;
    pattern: string;
}): ReportRole {
    return userType ?? shellRole ?? impliedRoleForPattern(pattern) ?? 'unknown';
}
