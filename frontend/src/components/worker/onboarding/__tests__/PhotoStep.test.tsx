// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhotoStep } from '@/components/worker/onboarding/PhotoStep';
import { message, renderIntl } from './render-intl';

function props(overrides: Partial<Parameters<typeof PhotoStep>[0]> = {}) {
    return {
        onSkip: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof PhotoStep>[0];
}

describe('PhotoStep', () => {
    it('offers the photo as optional, in English', () => {
        renderIntl(<PhotoStep {...props()} />);
        expect(screen.getByRole('heading', { name: message('worker_onboarding.photo.title') })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.photo.subtitle'))).toBeInTheDocument();
    });

    it('renders in Spanish', () => {
        renderIntl(<PhotoStep {...props()} />, 'es');
        expect(screen.getByRole('heading', { name: message('worker_onboarding.photo.title', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.photo.skip', 'es') })).toBeInTheDocument();
    });

    it('shows the upload button disabled — v1 has no photo uploader to reuse', () => {
        renderIntl(<PhotoStep {...props()} />);
        const add = screen.getByRole('button', { name: message('worker_onboarding.photo.add') });
        expect(add).toBeDisabled();
        expect(add).toHaveAttribute('title', message('worker_onboarding.common.coming_soon'));
    });

    it('skips without asking the API for anything — there is no photo step', async () => {
        const onSkip = vi.fn();
        renderIntl(<PhotoStep {...props({ onSkip })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.photo.skip') }));
        expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('offers no Back: the run completed on the last question', () => {
        renderIntl(<PhotoStep {...props()} />);
        expect(screen.queryByRole('button', { name: message('worker_onboarding.common.back') })).not.toBeInTheDocument();
    });
});
