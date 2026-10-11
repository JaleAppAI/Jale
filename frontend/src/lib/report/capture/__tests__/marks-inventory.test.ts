import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The inventory of screens whose personal details are hidden in a report
 * screenshot (`data-private`), and of the brand images drawn as they are
 * (`data-capture-safe`). It reads the source, so a mark that disappears -- or
 * a new one -- changes this list and shows up in review.
 *
 * Hidden: phone numbers, email addresses, dates of birth, home addresses,
 * emergency contacts, references, work-authorization and pay answers, the
 * answers a person wrote to questions, and document file names. Names are not
 * hidden automatically; the person can hide them in the editor. Form fields,
 * uploaded images and other media are hidden by the capture itself and need
 * no mark.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Where each `data-private` mark is, and what it hides. */
const PRIVATE_MARKS: Record<string, { count: number; hides: string }> = {
    'app/[locale]/employer/workers/[worker_id]/page.tsx': {
        count: 3,
        hides: "the worker's phone; answers to the job's questions; the worker's three profile answers",
    },
    'app/[locale]/employer/workers/[worker_id]/AnswerHighlights.tsx': {
        count: 1,
        hides: "the written summary of the worker's profile answers",
    },
    'app/[locale]/employer/workers/[worker_id]/DocumentSlots.tsx': {
        count: 2,
        hides: "document file names, and the names the worker gave them",
    },
    'app/[locale]/employer/jobs/[id]/page.tsx': {
        count: 2,
        hides: "an applicant's answers to the job's questions; the requirement answers (date of birth, home address, emergency contact, references, work authorization, pay...)",
    },
    'app/[locale]/employer/profile/page.tsx': {
        count: 2,
        hides: "the employer's email and phone",
    },
    'app/[locale]/worker/profile/page.tsx': {
        count: 1,
        hides: "the worker's phone",
    },
    'components/worker/DocumentSlot.tsx': {
        count: 1,
        hides: 'the vault file name',
    },
    'components/worker/application-requirements/DocumentsCertificationsStep.tsx': {
        count: 1,
        hides: 'the vault file a certification will use',
    },
    'components/worker/application-requirements/FieldControls.tsx': {
        count: 1,
        hides: 'the selected yes/no answer on the application form (work authorization, worked here before...)',
    },
    'components/worker/onboarding/DoneStep.tsx': {
        count: 1,
        hides: "the worker's onboarding answers in their own words",
    },
    'app/[locale]/upload/[token]/page.tsx': {
        count: 2,
        hides: 'the chosen file names, on the form and on the receipt',
    },
};

/** Brand images that may be drawn as they are. Nothing else may carry the mark. */
const SAFE_MARKS: Record<string, { min: number; max: number; what: string }> = {
    'app/[locale]/page.tsx': { min: 1, max: 1, what: 'the wordmark in the landing footer' },
    'app/[locale]/j/[code]/page.tsx': { min: 1, max: 1, what: 'the wordmark on the public job band' },
    'components/landing/LandingNav.tsx': { min: 1, max: 1, what: 'the wordmark in the landing navigation' },
    // Marked by the report-flow change, which owns this file.
    'components/auth/AuthShell.tsx': { min: 0, max: 1, what: 'the wordmark on the sign-in screens' },
};

/** The capture's own code and every test mention the marks without being screens. */
function isScreenSource(rel: string): boolean {
    if (!/\.tsx$/.test(rel)) return false;
    if (rel.split(path.sep).includes('__tests__')) return false;
    if (rel.startsWith(path.join('lib', 'report', 'capture'))) return false;
    if (rel.startsWith(path.join('components', 'report', 'screenshot'))) return false;
    return true;
}

function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collect(full, out);
        else out.push(full);
    }
    return out;
}

const SCREENS = collect(SRC)
    .map((full) => path.relative(SRC, full))
    .filter(isScreenSource)
    .map((rel) => ({ rel: rel.split(path.sep).join('/'), text: readFileSync(path.join(SRC, rel), 'utf8') }));

/** JSX attribute uses only: `data-private`, `data-private=`, never prose. */
function countAttribute(text: string, name: string): number {
    return (text.match(new RegExp(`\\s${name}(?=[\\s=>/])`, 'g')) ?? []).length;
}

describe('report screenshot marks', () => {
    it('reads the real source tree', () => {
        expect(SCREENS.length).toBeGreaterThan(100);
        expect(SCREENS.some((s) => s.rel === 'app/[locale]/worker/profile/page.tsx')).toBe(true);
    });

    it('hides personal details exactly where the inventory says', () => {
        const found: Record<string, number> = {};
        for (const { rel, text } of SCREENS) {
            const n = countAttribute(text, 'data-private');
            if (n > 0) found[rel] = n;
        }
        const expected = Object.fromEntries(Object.entries(PRIVATE_MARKS).map(([rel, { count }]) => [rel, count]));
        expect(found).toEqual(expected);
    });

    it('draws only brand images as they are', () => {
        for (const { rel, text } of SCREENS) {
            const n = countAttribute(text, 'data-capture-safe');
            const allowed = SAFE_MARKS[rel];
            if (!allowed) {
                expect(n, `${rel} carries data-capture-safe but is not a listed brand asset`).toBe(0);
                continue;
            }
            expect(n, `${rel}: ${allowed.what}`).toBeGreaterThanOrEqual(allowed.min);
            expect(n, `${rel}: ${allowed.what}`).toBeLessThanOrEqual(allowed.max);
        }
    });

    it('marks brand images only on img elements', () => {
        for (const { rel, text } of SCREENS) {
            for (const match of text.matchAll(/<(\w+)[^<>]*\sdata-capture-safe(?=[\s=>/])/g)) {
                expect(match[1], rel).toBe('img');
            }
        }
    });
});
