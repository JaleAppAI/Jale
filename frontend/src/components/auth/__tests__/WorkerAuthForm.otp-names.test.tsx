// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The six code boxes are named for a screen reader, in both languages: each
 * says which digit it holds, and together they form a group named by the
 * step's title. Rendered against the real catalogues, so a missing or raw key
 * fails here.
 */

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ setTokens: vi.fn() }) }));
vi.mock('@/lib/cognito', () => ({
    workerSignIn: vi.fn(async () => ({})),
    workerSignUp: vi.fn(async () => undefined),
    workerVerifyOtp: vi.fn(),
}));
vi.mock('@/lib/api/worker', () => ({ claimReferral: vi.fn(), getWorkerOnboarding: vi.fn() }));

import { expectNoRawMessageKeys, interpolate, message, renderIntl, type TestLocale } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';

describe('WorkerAuthForm — the code boxes have names', () => {
    it.each<TestLocale>(['en', 'es'])('names each of the six boxes and their group in %s', async (locale) => {
        const user = userEvent.setup();
        const { container } = renderIntl(<WorkerAuthForm />, locale);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp', locale) }));

        const group = await screen.findByRole('group', { name: message('auth.worker.otp_title', locale) });
        const boxes = within(group).getAllByRole('textbox');
        expect(boxes).toHaveLength(6);
        const names = boxes.map((box, i) => {
            const expected = interpolate(message('auth.worker.otp_digit', locale), { n: i + 1, total: 6 });
            expect(box).toHaveAccessibleName(expected);
            return expected;
        });
        expect(new Set(names).size).toBe(6);
        expectNoRawMessageKeys(container);
    });
});
