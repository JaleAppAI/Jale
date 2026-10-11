import { describe, expect, it } from 'vitest';
import {
    EMPLOYER_REPORT_CATEGORIES,
    WORKER_REPORT_CATEGORIES,
    categoriesFor,
    impliedRoleForPattern,
    isCategoryFor,
    preselectCategory,
    resolveReportRole,
    type ReportRole,
} from '../categories';
import { routePattern } from '@/components/report/seams/report-context';

const ROLES: ReportRole[] = ['worker', 'employer', 'unknown'];

describe('category lists', () => {
    it('match the codes the database accepts, in order', () => {
        expect(WORKER_REPORT_CATEGORIES).toEqual([
            'sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other',
        ]);
        expect(EMPLOYER_REPORT_CATEGORIES).toEqual([
            'account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile', 'other',
        ]);
    });

    it('gives a signed-out visitor with no implied role the worker list', () => {
        expect(categoriesFor('worker')).toEqual(WORKER_REPORT_CATEGORIES);
        expect(categoriesFor('employer')).toEqual(EMPLOYER_REPORT_CATEGORIES);
        expect(categoriesFor('unknown')).toEqual(WORKER_REPORT_CATEGORIES);
    });

    it('validates a code against the role that would send it', () => {
        expect(isCategoryFor('worker', 'uploads')).toBe(true);
        expect(isCategoryFor('employer', 'uploads')).toBe(false);
        expect(isCategoryFor('unknown', 'sign_in')).toBe(true);
        expect(isCategoryFor('employer', 'billing')).toBe(true);
        expect(isCategoryFor('worker', 'billing')).toBe(false);
        expect(isCategoryFor('worker', 'nonsense')).toBe(false);
        expect(isCategoryFor('worker', undefined)).toBe(false);
    });
});

/*
 * Every row of the pre-selection table, as the CONCRETE route Next renders --
 * a pathname plus the `useParams()` it comes with -- turned into a pattern by
 * `routePattern` itself, through the report flow's context seam. Hand-written
 * patterns could agree with this module and still disagree with the patterns
 * the app actually produces (`/employer/workers/:worker_id`, not `:id`).
 */
const RECORD = '00000000-0000-4000-8000-00000000000a';
const UPLOAD_TOKEN = 'ab'.repeat(32);

type Row = [pathname: string, params: Record<string, string | string[]>, worker: string, employer: string];
const ROWS: Row[] = [
    ['/auth/worker', {}, 'sign_in', 'account'],
    ['/auth/employer', {}, 'sign_in', 'account'],
    ['/legal/accept', {}, 'sign_in', 'account'],
    ['/worker/home', {}, 'finding_jobs', 'other'],
    [`/worker/jobs/${RECORD}`, { id: RECORD }, 'finding_jobs', 'other'],
    ['/j/ABC123', { code: 'ABC123' }, 'finding_jobs', 'other'],
    ['/worker/applications', {}, 'applying', 'other'],
    [`/worker/applications/${RECORD}`, { id: RECORD }, 'applying', 'other'],
    [`/upload/${UPLOAD_TOKEN}`, { token: UPLOAD_TOKEN }, 'uploads', 'other'],
    ['/worker/profile', {}, 'profile', 'other'],
    ['/worker/onboarding', {}, 'profile', 'other'],
    [`/employer/jobs/${RECORD}`, { id: RECORD }, 'other', 'job_posting'],
    ['/employer/templates', {}, 'other', 'job_posting'],
    ['/employer/applicants', {}, 'other', 'applicants'],
    [`/employer/workers/${RECORD}`, { worker_id: RECORD }, 'other', 'applicants'],
    ['/employer/conversations', {}, 'other', 'messages'],
    ['/employer/billing', {}, 'other', 'billing'],
    ['/digest-unsubscribe', {}, 'other', 'emails'],
    ['/employer/profile', {}, 'other', 'company_profile'],
    ['/employer/dashboard', {}, 'other', 'other'],
    ['/', {}, 'other', 'other'],
    ['/no/such/page', { rest: ['no', 'such', 'page'] }, 'other', 'other'],
];

const TABLE: Array<[string, string, string]> = ROWS.map(([pathname, params, worker, employer]) => [
    routePattern(pathname, params).pattern,
    worker,
    employer,
]);

describe('pre-selection from the screen', () => {
    it.each(TABLE)('%s -> worker %s, employer %s', (pattern, worker, employer) => {
        expect(preselectCategory({ pattern, role: 'worker' })).toBe(worker);
        expect(preselectCategory({ pattern, role: 'employer' })).toBe(employer);
        // A visitor with no role gets the worker list, so the worker column.
        expect(preselectCategory({ pattern, role: 'unknown' })).toBe(worker);
    });

    it('tolerates a trailing slash and a stray locale prefix', () => {
        expect(preselectCategory({ pattern: '/employer/billing/', role: 'employer' })).toBe('billing');
        expect(preselectCategory({ pattern: '/es/worker/profile', role: 'worker' })).toBe('profile');
        expect(preselectCategory({ pattern: '', role: 'worker' })).toBe('other');
    });

    it('never pre-selects whatsapp, from any screen, hint or caller', () => {
        for (const role of ROLES) {
            for (const [pattern] of TABLE) {
                expect(preselectCategory({ pattern, role })).not.toBe('whatsapp');
                expect(preselectCategory({ pattern, role, hint: 'whatsapp' })).not.toBe('whatsapp');
                expect(preselectCategory({ pattern, role, explicit: 'whatsapp' })).not.toBe('whatsapp');
            }
        }
    });

    it('prefers a hint over the route, and an explicit category over both', () => {
        const jobPage = routePattern(`/worker/jobs/${RECORD}`, { id: RECORD }).pattern;
        expect(preselectCategory({ pattern: jobPage, role: 'worker', hint: 'applying' })).toBe('applying');
        expect(preselectCategory({ pattern: '/worker/profile', role: 'worker', hint: 'uploads' })).toBe('uploads');
        expect(
            preselectCategory({ pattern: '/worker/profile', role: 'worker', hint: 'uploads', explicit: 'sign_in' }),
        ).toBe('sign_in');
    });

    it('ignores a hint or category that does not belong to the role', () => {
        // The posts grid also renders on an employer's view of a worker; its
        // worker-only hint must not leak into the employer list.
        const workerPage = routePattern(`/employer/workers/${RECORD}`, { worker_id: RECORD }).pattern;
        expect(preselectCategory({ pattern: workerPage, role: 'employer', hint: 'uploads' })).toBe('applicants');
        expect(preselectCategory({ pattern: '/employer/billing', role: 'employer', explicit: 'sign_in' }))
            .toBe('billing');
        expect(preselectCategory({ pattern: '/worker/home', role: 'worker', explicit: 'not_a_code' }))
            .toBe('finding_jobs');
    });
});

describe('the role a report claims', () => {
    const patternOf = (pathname: string, params: Record<string, string | string[]> = {}) =>
        routePattern(pathname, params).pattern;

    it('reads the role a route implies', () => {
        expect(impliedRoleForPattern(patternOf('/worker/home'))).toBe('worker');
        expect(impliedRoleForPattern(patternOf(`/worker/jobs/${RECORD}`, { id: RECORD }))).toBe('worker');
        expect(impliedRoleForPattern(patternOf('/j/ABC123', { code: 'ABC123' }))).toBe('worker');
        expect(impliedRoleForPattern(patternOf('/employer/billing'))).toBe('employer');
        expect(impliedRoleForPattern(patternOf(`/employer/workers/${RECORD}`, { worker_id: RECORD }))).toBe('employer');
        expect(impliedRoleForPattern(patternOf('/digest-unsubscribe'))).toBe('employer');
        expect(impliedRoleForPattern(patternOf(`/upload/${UPLOAD_TOKEN}`, { token: UPLOAD_TOKEN }))).toBeNull();
        expect(impliedRoleForPattern(patternOf('/legal/accept'))).toBeNull();
        expect(impliedRoleForPattern(patternOf('/auth/worker'))).toBeNull();
        expect(impliedRoleForPattern(patternOf('/no/such/page', { rest: ['no', 'such', 'page'] }))).toBeNull();
        expect(impliedRoleForPattern(patternOf('/'))).toBeNull();
    });

    it('takes the signed-in role first, then the sign-in screen, then the route, then unknown', () => {
        expect(resolveReportRole({ userType: 'employer', shellRole: 'worker', pattern: '/worker/home' })).toBe('employer');
        expect(resolveReportRole({ userType: null, shellRole: 'employer', pattern: '/auth/employer' })).toBe('employer');
        expect(resolveReportRole({ userType: null, shellRole: 'worker', pattern: '/employer/billing' })).toBe('worker');
        expect(resolveReportRole({ userType: null, pattern: patternOf('/j/ABC123', { code: 'ABC123' }) })).toBe('worker');
        expect(resolveReportRole({ userType: null, pattern: patternOf('/digest-unsubscribe') })).toBe('employer');
        expect(resolveReportRole({ userType: null, pattern: patternOf(`/upload/${UPLOAD_TOKEN}`, { token: UPLOAD_TOKEN }) }))
            .toBe('unknown');
        expect(resolveReportRole({ userType: null, shellRole: null, pattern: patternOf('/no/such/page', { rest: ['no', 'such', 'page'] }) }))
            .toBe('unknown');
    });

    it('pre-selects emails for a signed-out visitor on the unsubscribe page', () => {
        const pattern = patternOf('/digest-unsubscribe');
        const role = resolveReportRole({ userType: null, pattern });
        expect(preselectCategory({ pattern, role })).toBe('emails');
    });
});
