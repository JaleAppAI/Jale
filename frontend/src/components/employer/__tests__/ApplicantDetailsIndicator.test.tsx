// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import {
    ApplicantDetailsIndicator,
    remainingCount,
} from '@/components/employer/ApplicantDetailsIndicator';
import type { RequirementsRemaining } from '@/lib/api/employer';
import { interpolate, message, renderIntl } from './render-intl';

const remaining = (counts: Partial<RequirementsRemaining['counts']> = {}): RequirementsRemaining => ({
    prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
    counts: { prompts: 0, fields: 0, certifications: 0, docs: 0, ...counts },
    complete: false,
});

describe('ApplicantDetailsIndicator', () => {
    it('renders nothing when the API publishes no stage-2 vocabulary yet', () => {
        // Fail-open: a frontend ahead of its backend must say nothing rather
        // than tell every employer that nobody has been asked for details.
        const { container } = renderIntl(<ApplicantDetailsIndicator />);
        expect(container).toBeEmptyDOMElement();
    });

    it('reads neutral before anything has been asked', () => {
        renderIntl(<ApplicantDetailsIndicator status="not_requested" />);
        expect(
            screen.getByText(message('employer_job_listing.applicants.details.not_requested')),
        ).toBeInTheDocument();
    });

    it('names how many things are left once details are requested', () => {
        renderIntl(
            <ApplicantDetailsIndicator
                status="requested"
                remaining={remaining({ prompts: 0, fields: 2, docs: 1 })}
            />,
        );
        expect(
            screen.getByText(
                interpolate(message('employer_job_listing.applicants.details.requested'), { count: 3 }),
            ),
        ).toBeInTheDocument();
    });

    it('drops the count rather than interpolating an absent one', () => {
        renderIntl(<ApplicantDetailsIndicator status="requested" />);
        expect(
            screen.getByText(message('employer_job_listing.applicants.details.requested_no_count')),
        ).toBeInTheDocument();
    });

    it('reads as done when the worker has finished', () => {
        renderIntl(
            <ApplicantDetailsIndicator status="complete" remaining={remaining()} />,
        );
        expect(
            screen.getByText(message('employer_job_listing.applicants.details.complete')),
        ).toBeInTheDocument();
    });

    it('speaks Spanish', () => {
        renderIntl(<ApplicantDetailsIndicator status="not_requested" />, 'es');
        expect(
            screen.getByText(message('employer_job_listing.applicants.details.not_requested', 'es')),
        ).toBeInTheDocument();
    });
});

describe('remainingCount', () => {
    it('sums all four blocking buckets', () => {
        expect(remainingCount(remaining({ prompts: 1, fields: 2, certifications: 3, docs: 4 }))).toBe(10);
    });

    it('is null when there is no remaining doc to read, and 0 when there genuinely is nothing left', () => {
        expect(remainingCount(undefined)).toBeNull();
        expect(remainingCount(remaining())).toBe(0);
    });
});
