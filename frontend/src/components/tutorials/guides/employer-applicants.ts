import { guideTarget } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import type { WalkthroughGuide } from './types';

/**
 * E3's step-by-step guide: your applicants. It starts on the page view
 * (`maybeAutoOpen` with `walkthrough`) on the three pages that show them,
 * and each page has its own steps, kept apart by `when`, because each page
 * can do different things (the inventory's surface × action matrix):
 *
 *  - THE BOARD (`/employer/applicants`, `apps.board`): every job's
 *    applicants, the job chips, the status select that saves on the pick
 *    (Hired asks first), the Hired hint when details are outstanding, start
 *    details on Hired rows only, and Message. No Request details here.
 *  - A JOB'S PAGE (`apps.job_panel`): the filters, the filtered-empty state,
 *    one applicant's row, Request details (or Resend request), Message Worker
 *    and View profile. No status control here.
 *  - THE APPLICANT PROFILE (`apps.profile_status`): the status select with
 *    Save, the Hired hint, Request details, the documents, and where start
 *    details go once hired. No start details or message control here.
 *
 * A step whose control is not on the page (no applicant row with Request
 * details, no hired row) does not apply, so the guide never points at a
 * control the page does not have. Each page's steps apply on that page only
 * (a `when` on the page's own mark), so a guide started on one page ends
 * there: it never waits for another page's steps.
 *
 * A control that would take the person away from the guide is shown, not
 * pressed (`interactive: false`): Message opens the conversation drawer,
 * which the guide covers, and a job's Message Worker and View profile leave
 * the page. The copy says to use them after the guide. A control that opens
 * a dialog (Hired asks first; start details) stays pressable.
 *
 * The marks are `data-guide="apps.*"`.
 */

const KEY = 'tutorial.employer_applicants.guide';

/** The steps that say what they wait for (a step that is always ready shows no wait line). */
const WAITS: ReadonlySet<string> = new Set(['job_filtered_empty']);

function keys(id: string) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        ...(WAITS.has(id) ? { waitKey: `${KEY}.steps.${id}.wait` } : {}),
    };
}

const up = (name: string) => guideTarget(name) !== null;

const onBoard = () => up('apps.board');
const onJobPage = () => up('apps.job_panel');
const onProfile = () => up('apps.profile_status');

const BOARD: readonly SpotlightStep[] = [
    { id: 'board_row', target: { guide: 'apps.row' }, when: () => onBoard() && up('apps.row'), mode: 'next', ...keys('board_row') },
    { id: 'board_jobs', target: { guide: 'apps.board_jobs' }, when: () => onBoard() && up('apps.board_jobs'), mode: 'next', ...keys('board_jobs') },
    { id: 'board_status', target: { guide: 'apps.row_status' }, when: () => onBoard() && up('apps.row_status'), mode: 'next', ...keys('board_status') },
    { id: 'board_hire_blocked', target: { guide: 'apps.row_hint' }, when: () => onBoard() && up('apps.row_hint'), mode: 'next', ...keys('board_hire_blocked') },
    { id: 'board_hire_banner', target: { guide: 'apps.hire_banner' }, when: () => onBoard() && up('apps.hire_banner'), mode: 'next', ...keys('board_hire_banner') },
    { id: 'board_start', target: { guide: 'apps.row_start' }, when: () => onBoard() && up('apps.row_start'), mode: 'next', ...keys('board_start') },
    // Said, not pressed: Message opens the drawer, which the guide covers.
    { id: 'board_message', target: { guide: 'apps.row_message' }, when: () => onBoard() && up('apps.row_message'), mode: 'next', interactive: false, ...keys('board_message') },
];

const JOB_PAGE: readonly SpotlightStep[] = [
    { id: 'job_filters', target: { guide: 'apps.filters' }, when: onJobPage, mode: 'next', ...keys('job_filters') },
    {
        id: 'job_filtered_empty',
        target: { guide: 'apps.filtered_empty' },
        // The filters hide everyone: the way back is Clear filters.
        when: () => onJobPage() && up('apps.filtered_empty'),
        mode: 'next',
        ready: () => !up('apps.filtered_empty'),
        ...keys('job_filtered_empty'),
    },
    { id: 'job_row', target: { guide: 'apps.job_row' }, when: () => onJobPage() && up('apps.job_row'), mode: 'next', ...keys('job_row') },
    { id: 'job_request', target: { guide: 'apps.request' }, when: () => onJobPage() && up('apps.request'), mode: 'next', ...keys('job_request') },
    // Said, not pressed: both leave this page, and the guide stays with it.
    { id: 'job_message', target: { guide: 'apps.job_message' }, when: () => onJobPage() && up('apps.job_message'), mode: 'next', interactive: false, ...keys('job_message') },
    { id: 'job_profile', target: { guide: 'apps.job_profile' }, when: () => onJobPage() && up('apps.job_profile'), mode: 'next', interactive: false, ...keys('job_profile') },
];

/** The applicant's saved status, as the profile's status panel says. */
const profileStatus = () => guideTarget('apps.profile_status')?.getAttribute('data-status') ?? null;

const PROFILE: readonly SpotlightStep[] = [
    { id: 'profile_status', target: { guide: 'apps.profile_status' }, when: onProfile, mode: 'next', ...keys('profile_status') },
    { id: 'profile_hire_blocked', target: { guide: 'apps.profile_hint' }, when: () => onProfile() && up('apps.profile_hint'), mode: 'next', ...keys('profile_hire_blocked') },
    { id: 'profile_request', target: { guide: 'apps.profile_request' }, when: () => onProfile() && up('apps.profile_request'), mode: 'next', ...keys('profile_request') },
    { id: 'profile_docs', target: { guide: 'apps.profile_docs' }, when: () => onProfile() && up('apps.profile_docs'), mode: 'next', ...keys('profile_docs') },
    {
        id: 'profile_hired',
        target: { guide: 'apps.profile_status' },
        // Once hired, start details are added on the Applicants board.
        when: () => onProfile() && profileStatus() === 'hired',
        mode: 'next',
        ...keys('profile_hired'),
    },
];

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.employer_applicants.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [...BOARD, ...JOB_PAGE, ...PROFILE],
};

export default guide;
