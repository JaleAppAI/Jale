// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRecordFailed, readRecordFailed, writeRecordFailed } from '../storage';

/*
 * The "this tutorial's outcome did not save" flag (K1.4): kept for the rest of
 * the browser session, per ACCOUNT, so a failed save does not re-open the
 * tutorial on the next page, and one person's flag never hides a tutorial
 * from the next person to sign in on the same phone.
 */

afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
});

describe('record-failed flag', () => {
    it('is remembered for the account that set it', () => {
        writeRecordFailed('employer_welcome', 'account-one');

        expect(readRecordFailed('employer_welcome', 'account-one')).toBe(true);
    });

    it('lives in session storage, scoped to the account', () => {
        writeRecordFailed('worker_apply', 'account-one');

        expect(window.sessionStorage.getItem('jale.tutorial_record_failed.worker_apply.account-one')).toBe('1');
        expect(window.localStorage.length).toBe(0);
    });

    it('does not carry over to another account or another tutorial', () => {
        writeRecordFailed('employer_welcome', 'account-one');

        expect(readRecordFailed('employer_welcome', 'account-two')).toBe(false);
        expect(readRecordFailed('employer_post_job', 'account-one')).toBe(false);
    });

    it('neither reads nor writes without an account', () => {
        writeRecordFailed('employer_welcome', null);

        expect(window.sessionStorage.length).toBe(0);
        expect(readRecordFailed('employer_welcome', null)).toBe(false);
    });

    it('reads as not set, without throwing, when storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });

        expect(() => writeRecordFailed('employer_welcome', 'account-one')).not.toThrow();
        expect(readRecordFailed('employer_welcome', 'account-one')).toBe(false);
    });

    it('is cleared for one role, leaving the other role and unrelated keys alone', () => {
        writeRecordFailed('employer_welcome', 'account-one');
        writeRecordFailed('worker_profile', 'account-two');
        window.sessionStorage.setItem('jale.signage.lapsed.x.account-one', '1');

        clearRecordFailed('employer');

        expect(readRecordFailed('employer_welcome', 'account-one')).toBe(false);
        expect(readRecordFailed('worker_profile', 'account-two')).toBe(true);
        expect(window.sessionStorage.getItem('jale.signage.lapsed.x.account-one')).toBe('1');
    });

    it('is cleared for every role when no role is named', () => {
        writeRecordFailed('employer_welcome', 'account-one');
        writeRecordFailed('worker_profile', 'account-two');

        clearRecordFailed();

        expect(window.sessionStorage.length).toBe(0);
    });
});
