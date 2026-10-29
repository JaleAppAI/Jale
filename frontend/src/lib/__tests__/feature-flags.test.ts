import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTeamManagementEnabled } from '../feature-flags';

describe('isTeamManagementEnabled', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('only "true" enables the flag', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        expect(isTeamManagementEnabled()).toBe(true);

        for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
            vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', value);
            expect(isTeamManagementEnabled()).toBe(false);
        }

        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', undefined);
        expect(isTeamManagementEnabled()).toBe(false);
    });
});
