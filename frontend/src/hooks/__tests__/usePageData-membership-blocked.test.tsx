// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { handleLegalWall } = vi.hoisted(() => ({ handleLegalWall: vi.fn() }));

vi.mock('@/i18n/navigation', () => ({ usePathname: () => '/employer/dashboard' }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall,
        idToken: 'test-token',
        isAuthenticated: true,
        isLoading: false,
    }),
}));

import { MembershipBlockedError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { usePageData } from '../usePageData';

beforeEach(() => {
    handleLegalWall.mockReset();
});

describe('usePageData — a blocked company membership (Phase 3)', () => {
    it('a MembershipBlockedError on load goes to handleLegalWall and holds the skeleton, not the forbidden state', async () => {
        const blocked = new MembershipBlockedError('removed', true);
        const { result } = renderHook(() => usePageData<string>({
            fetcher: async () => { throw blocked; },
        }));

        await waitFor(() => expect(handleLegalWall).toHaveBeenCalledTimes(1));
        expect(handleLegalWall.mock.calls[0][0]).toBe(blocked);
        expect(result.current.phase).toBe('loading');
        expect(result.current.errorKind).toBeNull();
    });

    it('a plain 403 (flag off: no MembershipBlockedError) is still the forbidden state', async () => {
        const { result } = renderHook(() => usePageData<string>({
            fetcher: async () => { throw new ApiError(403, 'membership_inactive'); },
        }));

        await waitFor(() => expect(result.current.phase).toBe('error'));
        expect(result.current.errorKind).toBe('forbidden');
        expect(handleLegalWall).not.toHaveBeenCalled();
    });
});
