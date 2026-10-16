// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { ApiError, SESSION_REFRESH_UNAVAILABLE } from '@/lib/api/errors';
import { useErrorMessage } from '../useErrorMessage';

function wrapper(locale: 'en' | 'es') {
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : es} onError={() => {}}>
                {children}
            </NextIntlClientProvider>
        );
    };
}

describe('useErrorMessage — the two renewal failures', () => {
    it.each([
        ['an outage', new ApiError(503, SESSION_REFRESH_UNAVAILABLE)],
        ['no answer', new ApiError(0, 'offline')],
    ])('says the connectivity sentence for %s, in English', (_name, err) => {
        const { result } = renderHook(() => useErrorMessage(), { wrapper: wrapper('en') });
        expect(result.current(err)).toBe(en.common.errors.offline);
    });

    it('says it in Spanish too', () => {
        const { result } = renderHook(() => useErrorMessage(), { wrapper: wrapper('es') });
        expect(result.current(new ApiError(503, SESSION_REFRESH_UNAVAILABLE))).toBe(es.common.errors.offline);
    });
});
