// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeStep } from '@/components/worker/onboarding/TradeStep';
import {
    EMPTY_LOCATION_DRAFT,
    MAX_ANSWER_CHARS,
    MAX_CUSTOM_TRADE_CHARS,
    MIN_ANSWER_CHARS,
    MIN_CUSTOM_TRADE_CHARS,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { STANDARD_TRADE_KEYS } from '@/lib/worker-vocab';
import { interpolate, message, renderIntl } from './render-intl';

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
    firstName: '', lastName: '', location: { ...EMPTY_LOCATION_DRAFT },
    trade: null, customTrade: '', experience: null, transportation: null, availability: null,
    answers: ['', '', ''],
    ...overrides,
});

function props(overrides: Partial<Parameters<typeof TradeStep>[0]> = {}) {
    return {
        draft: draft(),
        stepKey: 'profile.trade',
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

describe('TradeStep — the typed-in trade has bounds of its own', () => {
    const bounds = { min: MIN_CUSTOM_TRADE_CHARS, max: MAX_CUSTOM_TRADE_CHARS };

    it('gates Continue on 2 to 60 characters of real text', () => {
        const cta = () => screen.getByRole('button', { name: message('worker_onboarding.trade.cta') });

        const { rerender } = renderIntl(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: 'w' }) })} />);
        expect(cta()).toBeDisabled();

        rerender(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: '  w  ' }) })} />);
        expect(cta()).toBeDisabled();

        rerender(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: 'x'.repeat(MAX_CUSTOM_TRADE_CHARS + 1) }) })} />);
        expect(cta()).toBeDisabled();

        rerender(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: 'x'.repeat(MAX_CUSTOM_TRADE_CHARS) }) })} />);
        expect(cta()).toBeEnabled();
    });

    it('says why before the save, and names the bound', () => {
        const { rerender } = renderIntl(<TradeStep {...props({ draft: draft({ trade: 'other', customTrade: 'w' }) })} />);
        const sentence = interpolate(message('worker_onboarding.rejection.reason.custom_trade.too_short'), bounds);
        expect(screen.getByText(sentence)).toBeInTheDocument();
        expect(screen.getByLabelText(message('worker_onboarding.trade.other_label'))).toHaveAttribute('aria-invalid', 'true');

        // An empty box is not yet wrong — they have not typed anything.
        rerender(<TradeStep {...props({ draft: draft({ trade: 'other' }) })} />);
        expect(screen.queryByText(sentence)).not.toBeInTheDocument();
    });

    it('renders each of the three server reasons with its own sentence', () => {
        for (const reason of ['too_short', 'too_long', 'invalid'] as const) {
            const { unmount } = renderIntl(<TradeStep {...props({
                rejection: { stepKey: 'profile.custom_trade', reason },
                draft: draft({ trade: 'other', customTrade: 'welder' }),
            })} />);
            expect(screen.getByRole('alert')).toHaveTextContent(
                interpolate(message(`worker_onboarding.rejection.reason.custom_trade.${reason}`), bounds),
            );
            unmount();
        }
    });

    it('says it in Spanish too', () => {
        renderIntl(<TradeStep {...props({
            rejection: { stepKey: 'profile.custom_trade', reason: 'too_long' },
            draft: draft({ trade: 'other', customTrade: 'welder' }),
        })} />, 'es');
        expect(screen.getByRole('alert')).toHaveTextContent(
            interpolate(message('worker_onboarding.rejection.reason.custom_trade.too_long', 'es'), bounds),
        );
    });

    it('does NOT borrow the trust answer\'s numbers for the same reason code', () => {
        // `too_short` means 15 characters on a trust answer and 2 here. The
        // sentence has to come from the field, not from the code.
        renderIntl(<TradeStep {...props({
            rejection: { stepKey: 'profile.custom_trade', reason: 'too_short' },
            draft: draft({ trade: 'other', customTrade: 'w' }),
        })} />);
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent(String(MIN_CUSTOM_TRADE_CHARS));
        expect(alert).not.toHaveTextContent(String(MIN_ANSWER_CHARS));
    });

    it('keeps the shared wording for a step with no field copy of its own', () => {
        renderIntl(<TradeStep {...props({
            rejection: { stepKey: 'profile.trade', reason: 'too_short' },
            draft: draft({ trade: 'plumber' }),
        })} />);
        expect(screen.getByRole('alert')).toHaveTextContent(
            interpolate(message('worker_onboarding.rejection.reason.too_short'), { min: MIN_ANSWER_CHARS, max: MAX_ANSWER_CHARS }),
        );
    });
});
