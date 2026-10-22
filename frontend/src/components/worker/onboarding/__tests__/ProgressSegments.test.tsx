// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { ProgressSegments } from '../ProgressSegments';
import { interpolate, message, renderIntl } from './render-intl';

/*
 * The web onboarding is seven screens before the summary: the terms, about
 * you, your trade, your work and the three questions. The rail draws one
 * segment per screen and says "Step n of 7" to a screen reader.
 */

function segments(container: HTMLElement): Element[] {
    return Array.from(container.querySelectorAll('[aria-hidden="true"] > i'));
}

describe('ProgressSegments', () => {
    it('draws seven segments', () => {
        const { container } = renderIntl(<ProgressSegments current="terms" />);
        expect(segments(container)).toHaveLength(7);
    });

    it('counts the last question as step 7 of 7', () => {
        renderIntl(<ProgressSegments current="q3" />);
        expect(screen.getByRole('status')).toHaveTextContent(
            interpolate(message('worker_onboarding.progress.label'), { current: 7, total: 7 }),
        );
    });

    it('fills every segment on the summary', () => {
        const { container } = renderIntl(<ProgressSegments current="done" />);
        const filled = segments(container).filter((s) => !s.className.includes('--jale-paper-2'));
        expect(filled).toHaveLength(7);
    });
});
