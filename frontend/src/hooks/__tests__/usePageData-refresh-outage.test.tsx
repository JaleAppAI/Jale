// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/i18n/navigation', () => ({ usePathname: () => '/worker/home' }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => { throw err; },
        idToken: 'test-token',
        isAuthenticated: true,
        isLoading: false,
    }),
}));

import { ApiError, SESSION_REFRESH_UNAVAILABLE } from '@/lib/api/errors';
import { usePageData } from '../usePageData';

describe('usePageData — a load that met a renewal outage', () => {
    it('lands in the retryable offline state, not the server-fault one', async () => {
        const { result } = renderHook(() => usePageData<string>({
            fetcher: async () => { throw new ApiError(503, SESSION_REFRESH_UNAVAILABLE); },
        }));

        await waitFor(() => expect(result.current.phase).toBe('error'));
        expect(result.current.errorKind).toBe('offline');
    });
});
