// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { TrustScorePill } from '../TrustScorePill';

const wrap = (ui: React.ReactElement, locale: 'en' | 'es' = 'en') => (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : es}>
        {ui}
    </NextIntlClientProvider>
);

describe('TrustScorePill', () => {
    it('renders the score', () => {
        render(wrap(<TrustScorePill score={78} />));
        expect(screen.getByText('Trust 78')).toBeInTheDocument();
    });

    it('renders nothing when the worker has no trust score', () => {
        // Absent must read as absent. A "Trust 0" pill beside a strong match
        // would libel every worker who simply never took the assessment.
        const { container } = render(wrap(<TrustScorePill score={null} />));
        expect(container).toBeEmptyDOMElement();
    });

    it('renders a real zero', () => {
        render(wrap(<TrustScorePill score={0} />));
        expect(screen.getByText('Trust 0')).toBeInTheDocument();
    });

    it('speaks Spanish', () => {
        render(wrap(<TrustScorePill score={78} />, 'es'));
        expect(screen.getByText('Confianza 78')).toBeInTheDocument();
    });
});
