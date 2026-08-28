// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeStep } from '@/components/worker/onboarding/TradeStep';
import { EMPTY_LOCATION_DRAFT, type OnboardingDraft } from '@/lib/onboarding-flow';
import { STANDARD_TRADE_KEYS } from '@/lib/worker-vocab';
import { message, renderIntl } from './render-intl';

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
    firstName: '', lastName: '', location: { ...EMPTY_LOCATION_DRAFT },
    trade: null, customTrade: '', experience: null, transportation: null, availability: null,
    answers: ['', '', ''],
    ...overrides,
});

function props(overrides: Partial<Parameters<typeof TradeStep>[0]> = {}) {
    return {
        draft: draft(),
        onDraftChange: vi.fn(),
        rejection: null,
        saving: false,
        error: null,
        onBack: vi.fn(),
        onSubmit: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof TradeStep>[0];
}

describe('TradeStep', () => {
    it('lists the five standard trades plus Other, in English', () => {
        renderIntl(<TradeStep {...props()} />);
        expect(screen.getByRole('heading', { name: message('worker_onboarding.trade.title') })).toBeInTheDocument();
        for (const key of STANDARD_TRADE_KEYS) {
            expect(screen.getByRole('button', { name: message(`worker_vocab.trade.${key}`) })).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: message('worker_vocab.trade.other') })).toBeInTheDocument();
    });

    it('lists them in Spanish', () => {
        renderIntl(<TradeStep {...props()} />, 'es');
        expect(screen.getByRole('heading', { name: message('worker_onboarding.trade.title', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_vocab.trade.plumber', 'es') })).toBeInTheDocument();
    });

    it('keeps Continue disabled until a trade is picked', () => {
        renderIntl(<TradeStep {...props()} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.trade.cta') })).toBeDisabled();
    });

    it('picks a trade through the draft callback', async () => {
        const onDraftChange = vi.fn();
        renderIntl(<TradeStep {...props({ onDraftChange })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_vocab.trade.carpenter') }));
        expect(onDraftChange).toHaveBeenCalledWith({ trade: 'carpenter' });
    });

    it('posts one step for a standard trade', async () => {
        const onSubmit = vi.fn();
        renderIntl(<TradeStep {...props({ draft: draft({ trade: 'plumber' }), onSubmit })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trade.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([{ stepKey: 'profile.trade', value: 'plumber' }]);
    });

    it('reveals the free-text box for Other and gates Continue on it', async () => {
        const onSubmit = vi.fn();
        const { rerender } = renderIntl(<TradeStep {...props({ draft: draft({ trade: 'other' }) })} />);
        expect(screen.getByLabelText(message('worker_onboarding.trade.other_label'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.trade.cta') })).toBeDisabled();

        rerender(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: 'welder' }), onSubmit })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trade.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'profile.trade', value: 'other' },
            { stepKey: 'profile.custom_trade', value: 'welder' },
        ]);
    });

    it('shows a rejected trade step inline', () => {
        renderIntl(<TradeStep {...props({ rejection: { stepKey: 'profile.custom_trade', reason: 'nope' }, draft: draft({ trade: 'other' }) })} />);
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.rejection.generic'));
    });
});
