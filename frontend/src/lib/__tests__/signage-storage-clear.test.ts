// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFreeSignageDismissals } from '../signage-storage';

describe('clearFreeSignageDismissals', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });
    afterEach(() => vi.restoreAllMocks());

    it('removes every free-plan dismissal of that account, whatever the plan code', () => {
        localStorage.setItem('jale.signage.free.employer_free.acct-a', '1');
        localStorage.setItem('jale.signage.free.employer_basic.acct-a', '1');
        localStorage.setItem('jale.signage.free.employer_free.acct-b', '1');
        localStorage.setItem('jale-theme', 'dark');
        sessionStorage.setItem('jale.signage.lapsed.past_due.acct-a', '1');

        clearFreeSignageDismissals('acct-a');

        expect(localStorage.getItem('jale.signage.free.employer_free.acct-a')).toBeNull();
        expect(localStorage.getItem('jale.signage.free.employer_basic.acct-a')).toBeNull();
        expect(localStorage.getItem('jale.signage.free.employer_free.acct-b')).toBe('1');
        expect(localStorage.getItem('jale-theme')).toBe('dark');
        expect(sessionStorage.getItem('jale.signage.lapsed.past_due.acct-a')).toBe('1');
    });

    it('does nothing without an account', () => {
        localStorage.setItem('jale.signage.free.employer_free.acct-a', '1');
        clearFreeSignageDismissals(null);
        expect(localStorage.getItem('jale.signage.free.employer_free.acct-a')).toBe('1');
    });

    it('never throws when storage is unavailable', () => {
        // One matching key first, so the walk really reaches the refusing call.
        localStorage.setItem('jale.signage.free.employer_free.acct-a', '1');
        vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('blocked'); });
        expect(() => clearFreeSignageDismissals('acct-a')).not.toThrow();
    });
});
