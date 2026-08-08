'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { classifyError, errorMessageKey, type ErrorKind } from '@/lib/api/errors';

/**
 * Turns any thrown value into a sentence the user should actually see.
 *
 * This exists so no call site ever renders `err.message`. A thrown message is
 * a backend error CODE (`job_limit_reached`), a provider string, or an
 * exception text -- none of which are copy, none of which are translated, and
 * some of which leak server detail. Classifying first means the user gets one
 * of a small set of reviewed, bilingual sentences no matter what failed.
 *
 * `overrides` is for the surface that has something more useful to say about a
 * specific kind ("that job is full" instead of the generic conflict line). It
 * is keyed by `ErrorKind`, not by backend code, so an override cannot
 * accidentally become a passthrough for server text.
 *
 * @example
 * const errorMessage = useErrorMessage();
 * try { await save(); }
 * catch (err) { setError(errorMessage(err, { conflict: t('already_applied') })); }
 */
export function useErrorMessage(): (
    err: unknown,
    overrides?: Partial<Record<ErrorKind, string>>,
) => string {
    const t = useTranslations('common');

    return useCallback(
        (err: unknown, overrides?: Partial<Record<ErrorKind, string>>) => {
            const { kind } = classifyError(err);
            return overrides?.[kind] ?? t(errorMessageKey(kind));
        },
        [t],
    );
}
