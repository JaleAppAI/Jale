// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TermsStep } from '@/components/worker/onboarding/TermsStep';
import { message, renderIntl } from './render-intl';

describe('TermsStep', () => {
    it('shows the legal read and the three sections, in English', () => {
        renderIntl(<TermsStep saving={false} onSubmit={vi.fn()} />);
        expect(screen.getByRole('heading', { name: message('worker_onboarding.terms.title') })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.terms.subtitle'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.terms.info_title'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.terms.messages_title'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.terms.terms_title'))).toBeInTheDocument();
    });

    it('shows the same screen in Spanish', () => {
        renderIntl(<TermsStep saving={false} onSubmit={vi.fn()} />, 'es');
        expect(screen.getByRole('heading', { name: message('worker_onboarding.terms.title', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.terms.cta', 'es') })).toBeInTheDocument();
    });

    it('offers no Back: this is the first screen of the flow', () => {
        renderIntl(<TermsStep saving={false} onSubmit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument();
    });

    it('posts legal.review = accept', async () => {
        const onSubmit = vi.fn();
        renderIntl(<TermsStep saving={false} onSubmit={onSubmit} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([{ stepKey: 'legal.review', value: 'accept' }]);
    });
});
