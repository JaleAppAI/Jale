// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/messages/en.json';

/**
 * WORKER SIGNUP IS PHONE-ONLY NOW.
 *
 * It used to ask for name, city, trade, years, transportation and
 * availability on one screen BEFORE the account existed, stash the lot in
 * `sessionStorage.pendingWorkerProfile`, and have `/worker/profile` flush it
 * after the OTP. That form is what `/worker/onboarding` replaces: the same
 * questions, one at a time, against the real engine, resumable, and in the
 * order the WhatsApp flow asks them.
 *
 * So the three things pinned here are: the fields are GONE, no stash is
 * written, and a verified worker who is not `ready` lands on the onboarding
 * flow rather than on a profile page with nothing in it.
 */

type MessageNode = string | { [key: string]: MessageNode };

function message(path: string): string {
    let node: MessageNode = en as MessageNode;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) {
            throw new Error(`No en.json message at "${path}"`);
        }
        node = node[segment];
    }
    if (typeof node !== 'string') throw new Error(`"${path}" is not a leaf message`);
    return node;
}

type TranslationValues = Record<string, string | number>;

function translate(namespace: string, key: string, values?: TranslationValues): string {
    const raw = message(`${namespace}.${key}`);
    if (!values) return raw;
    return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

const { push, replace, setTokens, cognito, api } = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    setTokens: vi.fn(),
    cognito: {
        workerSignIn: vi.fn(),
        workerSignUp: vi.fn(),
        workerVerifyOtp: vi.fn(),
    },
    api: {
        claimReferral: vi.fn(),
        getWorkerOnboarding: vi.fn(),
    },
}));

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: TranslationValues) => translate(namespace, key, values),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push, replace }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ setTokens }) }));
vi.mock('@/lib/cognito', () => cognito);
vi.mock('@/lib/api/worker', () => api);

import WorkerAuthForm from '@/components/auth/WorkerAuthForm';

const TOKENS = { accessToken: 'a', idToken: 'id-token', refreshToken: 'r' };

/** The fields the old signup screen asked for, by their (now removed) labels. */
const RETIRED_FIELD_KEYS = [
    'auth.worker.fields.full_name',
    'auth.worker.fields.city',
    'auth.worker.fields.main_trade',
    'auth.worker.fields.years_experience',
    'auth.worker.fields.has_transportation',
    'auth.worker.fields.availability',
];

async function goToSignup(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: message('auth.worker.signup_link') }));
}

async function completeOtp(user: ReturnType<typeof userEvent.setup>) {
    // The six OTP boxes are the only text inputs on that step.
    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < inputs.length; i += 1) {
        await user.type(inputs[i], String((i + 1) % 10));
    }
    await user.click(screen.getByRole('button', { name: message('auth.worker.verify') }));
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    cognito.workerSignIn.mockResolvedValue({});
    cognito.workerSignUp.mockResolvedValue(undefined);
    cognito.workerVerifyOtp.mockResolvedValue(TOKENS);
    api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'onboarding' });
});

describe('WorkerAuthForm — signup is phone only', () => {
    it('asks for nothing but the phone number', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);

        expect(screen.getByText(message('auth.worker.signup_title'))).toBeInTheDocument();
        expect(screen.getByLabelText('Country code')).toBeInTheDocument();
        for (const key of RETIRED_FIELD_KEYS) {
            let label: string | null = null;
            try {
                label = message(key);
            } catch {
                // The key is gone from the catalogue too, which is the point.
            }
            if (label) expect(screen.queryByText(label)).not.toBeInTheDocument();
        }
    });

    it('creates the account and leaves no pendingWorkerProfile stash behind', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.create_account') }));

        await waitFor(() => expect(cognito.workerSignUp).toHaveBeenCalled());
        expect(sessionStorage.getItem('pendingWorkerProfile')).toBeNull();
    });

    it('sends the phone and NOTHING else — no placeholder name', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.create_account') }));

        // The endpoint stopped requiring `fullName`, so the em-dash stand-in
        // that used to be posted here is gone. A real name is collected by the
        // onboarding flow's own step and written to the profile.
        await waitFor(() => expect(cognito.workerSignUp).toHaveBeenCalledTimes(1));
        const [arg] = cognito.workerSignUp.mock.calls[0];
        expect(Object.keys(arg)).toEqual(['phone']);
    });
});

describe('WorkerAuthForm — where a verified worker lands', () => {
    it('sends a worker who is still onboarding to the flow', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(api.getWorkerOnboarding).toHaveBeenCalledWith('id-token');
        expect(push).not.toHaveBeenCalled();
    });

    it('sends a worker who already finished to their profile', async () => {
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/profile'));
        expect(replace).not.toHaveBeenCalled();
    });

    it('falls back to the previous destination when a LOGIN cannot read the run', async () => {
        // Most workers signing in have long finished onboarding; dropping them
        // into a flow they completed months ago would be worse than the page
        // they actually asked for.
        api.getWorkerOnboarding.mockRejectedValue(new Error('offline'));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/profile'));
    });

    it('sends a SIGNUP to the flow even when the run cannot be read', async () => {
        // The other direction: an account made seconds ago has no profile
        // worth showing and certainly has not finished onboarding, so the
        // flow -- which has its own retry and its own way out -- is the
        // honest destination.
        api.getWorkerOnboarding.mockRejectedValue(new Error('offline'));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.create_account') }));
        await completeOtp(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(push).not.toHaveBeenCalled();
    });
});

/**
 * This form had no `<form>` element either, so Enter did nothing on any of its
 * three steps — including the six-box OTP screen, where a worker types the last
 * digit and the obvious next move is Enter, not "find the button".
 *
 * The guards matter as much as the submit does: `workerSignIn` texts a code, so
 * an Enter that skipped the `phoneReady` check would spend an SMS on a
 * half-typed number, and one that skipped the completeness check would burn an
 * OTP attempt on an incomplete code.
 */
describe('WorkerAuthForm — Enter submits the step it is pressed in', () => {
    it('sends the code from the phone field, exactly once', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        await user.type(screen.getByRole('textbox'), '2105550134{Enter}');

        await waitFor(() => expect(cognito.workerSignIn).toHaveBeenCalledTimes(1));
        expect(await screen.findByText(message('auth.worker.otp_title'))).toBeInTheDocument();
    });

    it('creates the account from the signup step', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);

        await user.type(screen.getByRole('textbox'), '2105550134{Enter}');

        await waitFor(() => expect(cognito.workerSignUp).toHaveBeenCalledTimes(1));
    });

    it('is blocked while the number is too short to text', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        await user.type(screen.getByRole('textbox'), '21055{Enter}');

        expect(cognito.workerSignIn).not.toHaveBeenCalled();
    });

    it('verifies from any OTP box once all six are filled', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));

        const boxes = await screen.findAllByRole('textbox');
        for (let i = 0; i < boxes.length; i += 1) {
            await user.type(boxes[i], String(i + 1));
        }
        // Back into the middle of the code: the keystroke has to work wherever
        // the cursor happens to be, not only in the last box.
        await user.click(boxes[2]);
        await user.keyboard('{Enter}');

        await waitFor(() => expect(cognito.workerVerifyOtp).toHaveBeenCalledTimes(1));
        expect(cognito.workerVerifyOtp.mock.calls[0][1]).toBe('123456');
    });

    it('is blocked on an incomplete OTP', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));

        const boxes = await screen.findAllByRole('textbox');
        await user.type(boxes[0], '123');
        await user.keyboard('{Enter}');

        expect(cognito.workerVerifyOtp).not.toHaveBeenCalled();
    });

    it('opens each step with its first field focused', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        expect(screen.getByRole('textbox')).toHaveFocus();

        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));

        const boxes = await screen.findAllByRole('textbox');
        await waitFor(() => expect(boxes[0]).toHaveFocus());
    });
});
