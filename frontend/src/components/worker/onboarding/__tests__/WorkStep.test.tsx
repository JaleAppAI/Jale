// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkStep } from '@/components/worker/onboarding/WorkStep';
import { EMPTY_LOCATION_DRAFT, type OnboardingDraft } from '@/lib/onboarding-flow';
import { AVAILABILITY_KEYS, EXPERIENCE_KEYS } from '@/lib/worker-vocab';
import { message, renderIntl } from './render-intl';

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
    firstName: '', lastName: '', location: { ...EMPTY_LOCATION_DRAFT },
    trade: null, customTrade: '', experience: null, transportation: null, availability: null,
    answers: ['', '', ''],
    ...overrides,
});

function props(overrides: Partial<Parameters<typeof WorkStep>[0]> = {}) {
    return {
        draft: draft(),
        onDraftChange: vi.fn(),
        rejection: null,
        saving: false,
        error: null,
        onBack: vi.fn(),
        onSubmit: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof WorkStep>[0];
}

describe('WorkStep', () => {
    it('asks all three questions on ONE screen', () => {
        renderIntl(<WorkStep {...props()} />);
        expect(screen.getByRole('heading', { name: message('worker_onboarding.work.title') })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.work.years'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.work.transport'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.work.availability'))).toBeInTheDocument();
        for (const key of EXPERIENCE_KEYS) {
            expect(screen.getByRole('button', { name: message(`worker_vocab.experience.${key}`) })).toBeInTheDocument();
        }
        for (const key of AVAILABILITY_KEYS) {
            expect(screen.getByRole('button', { name: message(`worker_vocab.availability.${key}`) })).toBeInTheDocument();
        }
    });

    it('renders in Spanish', () => {
        renderIntl(<WorkStep {...props()} />, 'es');
        expect(screen.getByRole('heading', { name: message('worker_onboarding.work.title', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_vocab.experience.10+', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_vocab.transport.no', 'es') })).toBeInTheDocument();
    });

    it('keeps Continue disabled until all three are answered — including a No on transport', () => {
        const { rerender } = renderIntl(<WorkStep {...props({
            draft: draft({ experience: '2-4', availability: 'full_time' }),
        })} />);
        const cta = () => screen.getByRole('button', { name: message('worker_onboarding.work.cta') });
        expect(cta()).toBeDisabled();

        rerender(<WorkStep {...props({
            draft: draft({ experience: '2-4', availability: 'full_time', transportation: false }),
        })} />);
        expect(cta()).toBeEnabled();
    });

    it('records a No answer as false, not as "unanswered"', async () => {
        const onDraftChange = vi.fn();
        renderIntl(<WorkStep {...props({ onDraftChange })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_vocab.transport.no') }));
        expect(onDraftChange).toHaveBeenCalledWith({ transportation: false });
    });

    it('posts experience, transportation and availability as one batch', async () => {
        const onSubmit = vi.fn();
        renderIntl(<WorkStep {...props({
            draft: draft({ experience: '5-9', transportation: true, availability: 'weekends' }),
            onSubmit,
        })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.work.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'profile.experience', value: '5-9' },
            { stepKey: 'profile.transportation', value: true },
            { stepKey: 'profile.availability', value: 'weekends' },
        ]);
    });
});
