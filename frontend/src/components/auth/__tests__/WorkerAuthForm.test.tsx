// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/messages/en.json';
import { CLAIM_WAIT_MS } from '@/lib/referral-return';

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

const { push, replace, setTokens, cognito, api, query, assignReturnPath } = vi.hoisted(() => ({
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
    // Mutable, because the referral carry-through is driven ENTIRELY by the
    // URL: the form's mount effect copies `?job=`/`?share=` into the session
    // stash and, on a param-free visit, clears it. A fixed empty
    // `URLSearchParams` can only ever exercise the second branch.
    query: { current: new URLSearchParams() },
    // `location.assign` is non-configurable in jsdom, which is why the hop to a
    // `returnUrl` goes through this one-line seam (see `@/lib/login-url`).
    assignReturnPath: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: TranslationValues) => translate(namespace, key, values),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => query.current }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push, replace }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ setTokens }) }));
vi.mock('@/lib/cognito', () => cognito);
vi.mock('@/lib/api/worker', () => api);
vi.mock('@/lib/login-url', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/login-url')>()),
    assignReturnPath,
}));

import WorkerAuthForm from '@/components/auth/WorkerAuthForm';

const TOKENS = { accessToken: 'a', idToken: 'id-token', refreshToken: 'r' };
const JOB_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';
/** `JALE-7K3M-9QX2` as a person might type it, and as the backend stores it. */
const TYPED_CODE = 'jale-7k3m-9qx2';
const SHARE_CODE = '7K3M9QX2';

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

/** The login door end to end: number, send, the six digits. */
async function signIn(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole('textbox'), '2105550134');
    await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
    await completeOtp(user);
}

/** What the session stash holds right now, parsed. */
function stashed(): unknown {
    const raw = sessionStorage.getItem('pendingReferral');
    return raw ? JSON.parse(raw) : null;
}

/** Cognito's answer to a sign-in for a number it does not recognise. */
function notAuthorized() {
    return Object.assign(new Error('Incorrect username or password.'), { code: 'NotAuthorizedException' });
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    query.current = new URLSearchParams();
    cognito.workerSignIn.mockResolvedValue({});
    cognito.workerSignUp.mockResolvedValue(undefined);
    cognito.workerVerifyOtp.mockResolvedValue(TOKENS);
    api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'onboarding' });
    // A real promise, never `undefined`: the form awaits the claim now.
    api.claimReferral.mockResolvedValue({ claimed: false, recorded: [] });
});

afterEach(() => {
    vi.useRealTimers();
});

/*
 * A worker who signs in with a different number from the one on WhatsApp ends
 * up with two accounts. The hint sits under the phone field on both doors.
 */
describe('WorkerAuthForm — which number to use', () => {
    it('says to use the WhatsApp number under the sign-in phone field', () => {
        render(<WorkerAuthForm />);
        expect(screen.getByText(message('auth.worker.phone_hint'))).toBeInTheDocument();
    });

    it('says it under the sign-up phone field too', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await goToSignup(user);
        expect(screen.getByText(message('auth.worker.signup_title'))).toBeInTheDocument();
        expect(screen.getByText(message('auth.worker.phone_hint'))).toBeInTheDocument();
    });

    it('puts the hint after the phone field, not above it', () => {
        render(<WorkerAuthForm />);
        const field = screen.getByRole('textbox');
        const hint = screen.getByText(message('auth.worker.phone_hint'));
        expect(field.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
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
        // The phone and the first-party signup source (K3.6) -- never a name.
        expect(Object.keys(arg).sort()).toEqual(['phone', 'signupSource']);
        expect(arg.signupSource).toEqual({ src: null, entry: 'signup_page' });
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

    it('sends a worker who already finished to their home feed', async () => {
        // Not the profile page: a returning worker's first question is "did
        // anything happen?", and /worker/home is the only screen that answers
        // it -- it carries the hire celebration and the details-requested
        // notice. A profile page answers a question nobody asked at login.
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/home'));
        expect(replace).not.toHaveBeenCalled();
    });

    it('sends a worker who came for a shared job straight to that job', async () => {
        // The referral branch outranks the landing page: this worker arrived
        // from a link about one specific job and signing in must not lose it.
        const JOB_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';
        query.current = new URLSearchParams({ job: JOB_ID });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith(`/worker/jobs/${JOB_ID}`));
        expect(push).not.toHaveBeenCalledWith('/worker/home');
    });

    it('falls back to the home feed when a LOGIN cannot read the run', async () => {
        // Most workers signing in have long finished onboarding; dropping them
        // into a flow they completed months ago would be worse than the page
        // they actually asked for.
        api.getWorkerOnboarding.mockRejectedValue(new Error('offline'));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await completeOtp(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/home'));
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

/**
 * `jaleapp.ai/app` sends people here as
 * `/{locale}/auth/worker?step=signup[&job=<uuid>][&share=<CODE>]`: someone who
 * tapped "get the app" is new by definition, and opening on sign-in made them
 * find the sign-up link first.
 */
describe('WorkerAuthForm — the step a link opens on', () => {
    it('opens on sign-up for ?step=signup', () => {
        query.current = new URLSearchParams({ step: 'signup' });
        render(<WorkerAuthForm />);

        expect(screen.getByText(message('auth.worker.signup_title'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('auth.worker.create_account') })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('auth.worker.send_otp') })).not.toBeInTheDocument();
    });

    it.each(['login', 'SIGNUP', 'otp', ''])('opens on sign-in for ?step=%s', (step) => {
        // `otp` above all: there is no code to enter until one was sent.
        query.current = new URLSearchParams({ step });
        render(<WorkerAuthForm />);

        expect(screen.getByRole('button', { name: message('auth.worker.send_otp') })).toBeInTheDocument();
        expect(screen.queryByText(message('auth.worker.signup_title'))).not.toBeInTheDocument();
    });
});

/**
 * The stash is how the job survives the OTP round trip in this tab. It used to
 * be wiped by ANY visit without `job`/`share` -- a `?returnUrl=` login bounce,
 * or the language toggle, which dropped the query -- so the worker reached the
 * end of onboarding with nothing to show for the link they came in on.
 */
describe('WorkerAuthForm — the referral stash survives the visit', () => {
    it('keeps an existing stash on a visit that carries only a returnUrl', () => {
        sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: SHARE_CODE }));
        query.current = new URLSearchParams({ returnUrl: '/en/worker/home' });
        render(<WorkerAuthForm />);

        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: SHARE_CODE });
    });

    it('keeps it on a visit with no query at all', () => {
        sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: null }));
        render(<WorkerAuthForm />);

        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: null });
    });

    it('stashes the share code the way the backend will read it', () => {
        query.current = new URLSearchParams({ job: JOB_ID, share: TYPED_CODE });
        render(<WorkerAuthForm />);

        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: SHARE_CODE });
    });

    it('does not let a malformed link overwrite a good stash', () => {
        sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: null }));
        query.current = new URLSearchParams({ job: '../../evil', share: 'short' });
        render(<WorkerAuthForm />);

        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: null });
    });
});

/**
 * The server records the job at sign-in (decided 2026-10-01), and it has to
 * happen BEFORE `setTokens`: that call makes the auth page swap this form for
 * a skeleton, so anything after it runs in a closure nobody can see.
 */
describe('WorkerAuthForm — the job is recorded before the session starts', () => {
    it('claims a ?job= link that has no share code, before setTokens', async () => {
        query.current = new URLSearchParams({ job: JOB_ID });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(api.claimReferral).toHaveBeenCalledTimes(1);
        expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
        expect(api.claimReferral.mock.invocationCallOrder[0])
            .toBeLessThan(setTokens.mock.invocationCallOrder[0]);
    });

    it('sends the job and the share code together, the code normalised', async () => {
        query.current = new URLSearchParams({ job: JOB_ID, share: TYPED_CODE });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: SHARE_CODE }));
    });

    it('claims from the stash when this visit itself carries nothing', async () => {
        // The tab came back without the query (a reload of the bare page, a
        // bounce): the stash is the only record of the link.
        sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: null }));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null }));
    });

    it('does not call the claim when there is nothing to record', async () => {
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(api.claimReferral).not.toHaveBeenCalled();
    });

    it('signs the worker in anyway when the claim fails', async () => {
        query.current = new URLSearchParams({ job: JOB_ID });
        api.claimReferral.mockRejectedValue(new Error('500'));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'worker');
        // Nothing to tell the worker: a failed claim is not their problem.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        // And the stash is left for the summary screen's fallback.
        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: null });
    });

    it('stops waiting after about four seconds and signs the worker in anyway', async () => {
        query.current = new URLSearchParams({ job: JOB_ID });
        // A claim that never answers: a request lost on the way out of signal.
        api.claimReferral.mockReturnValue(new Promise(() => {}));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        const boxes = await screen.findAllByRole('textbox');

        // Only the wait runs on the fake clock. Everything up to here was
        // ordinary input on real timers.
        vi.useFakeTimers();
        fireEvent.change(boxes[0], { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: message('auth.worker.verify') }));

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_WAIT_MS - 1); });
        expect(api.claimReferral).toHaveBeenCalledTimes(1);
        // Still waiting: the session has not started yet.
        expect(setTokens).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        vi.useRealTimers();
        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'worker');
    });
});

describe('WorkerAuthForm — the hand-off flag never outlives the sign-in', () => {
    it('clears authFlowCompleting even when routing throws', async () => {
        // The flag lives in sessionStorage. Left set, it tells the auth page to
        // stand down on every later visit in this tab: a signed-in worker would
        // sit on its skeleton forever.
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        push.mockImplementationOnce(() => { throw new Error('navigation failed'); });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/home'));
        expect(sessionStorage.getItem('authFlowCompleting')).toBeNull();
    });
});

/**
 * A finished worker who signs in goes where they were going. The order is the
 * signed-in auth page's own: the job in context, then a safe `returnUrl`, then
 * the home feed.
 */
describe('WorkerAuthForm — where a finished worker goes after signing in', () => {
    it('follows a safe returnUrl', async () => {
        query.current = new URLSearchParams({ returnUrl: '/es/worker/applications?tab=active' });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        // Assigned, not routed: the path already carries its locale.
        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith('/es/worker/applications?tab=active'));
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('follows it too when a LOGIN cannot read the run', async () => {
        // The same "finished worker" guess the home-feed fallback makes, so the
        // same destination order applies.
        query.current = new URLSearchParams({ returnUrl: '/es/worker/applications' });
        api.getWorkerOnboarding.mockRejectedValue(new Error('offline'));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith('/es/worker/applications'));
    });

    it('refuses an off-origin returnUrl and goes home instead', async () => {
        query.current = new URLSearchParams({ returnUrl: 'https://evil.com/en/worker/home' });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith('/worker/home'));
        expect(assignReturnPath).not.toHaveBeenCalled();
    });

    it('lets the job in context win over the returnUrl', async () => {
        query.current = new URLSearchParams({ job: JOB_ID, returnUrl: '/es/worker/applications' });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(push).toHaveBeenCalledWith(`/worker/jobs/${JOB_ID}`));
        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
    });

    it('treats a returnUrl that names a job as the job in context: claimed, then opened at that exact address', async () => {
        query.current = new URLSearchParams({ returnUrl: `/es/worker/jobs/${JOB_ID}?ref=wa` });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        // Assigned, as any returnUrl is: it carries its own locale and query.
        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith(`/es/worker/jobs/${JOB_ID}?ref=wa`));
        expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
        expect(api.claimReferral.mock.invocationCallOrder[0])
            .toBeLessThan(setTokens.mock.invocationCallOrder[0]);
        expect(push).not.toHaveBeenCalled();
    });

    it('keeps the Apply instruction and the locale of a job page the session ended on', async () => {
        // The session died between the summary's Apply and the job page: the
        // bounce carries `apply=1`, and the job page opens the apply flow from it.
        query.current = new URLSearchParams({ returnUrl: `/es/worker/jobs/${JOB_ID}?apply=1` });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith(`/es/worker/jobs/${JOB_ID}?apply=1`));
        expect(api.claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
        expect(push).not.toHaveBeenCalled();
    });

    it('still sends a worker who is not done to onboarding, whatever the returnUrl', async () => {
        query.current = new URLSearchParams({ returnUrl: '/es/worker/applications' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(assignReturnPath).not.toHaveBeenCalled();
    });
});

/**
 * Decided 2026-10-01: a number sign-in does not recognise gets a neutral nudge
 * to sign up. NEUTRAL is the operative word: Cognito answers "not authorized"
 * for an unknown number and for a known one alike, and the sentence above the
 * nudge is the same for both, so the screen never confirms or denies that a
 * number has an account.
 */
describe('WorkerAuthForm — an unrecognised number on sign-in', () => {
    it('offers to create the account with the same number, keeping the stash', async () => {
        sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: JOB_ID, shareCode: null }));
        cognito.workerSignIn.mockRejectedValueOnce(notAuthorized());
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));

        expect(await screen.findByText(message('auth.worker.errors.invalid_credentials'))).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: message('auth.worker.signup_nudge') }));

        expect(screen.getByText(message('auth.worker.signup_title'))).toBeInTheDocument();
        expect(screen.getByRole('textbox')).toHaveValue('2105550134');
        // A switch, not a submit: no second text message went out.
        expect(cognito.workerSignIn).toHaveBeenCalledTimes(1);
        // The sign-in error belonged to sign-in; sign-up starts clean.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: null });
    });

    it('creates the account for that number when the worker goes on', async () => {
        cognito.workerSignIn.mockRejectedValueOnce(notAuthorized());
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await user.click(await screen.findByRole('button', { name: message('auth.worker.signup_nudge') }));
        await user.click(screen.getByRole('button', { name: message('auth.worker.create_account') }));

        await waitFor(() => expect(cognito.workerSignUp).toHaveBeenCalledWith({ phone: '+12105550134', signupSource: { src: null, entry: 'signup_page' } }));
    });

    it('keeps its name apart from the "Create an account" link', async () => {
        cognito.workerSignIn.mockRejectedValueOnce(notAuthorized());
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));
        await screen.findByRole('button', { name: message('auth.worker.signup_nudge') });

        expect(message('auth.worker.signup_nudge')).not.toBe(message('auth.worker.signup_link'));
        // Both on screen at once, each still found by its own name.
        expect(screen.getAllByRole('button', { name: message('auth.worker.signup_link') })).toHaveLength(1);
    });

    it('is not offered for a sign-in error that is not about the number', async () => {
        cognito.workerSignIn.mockRejectedValueOnce(Object.assign(new Error('slow down'), { code: 'LimitExceededException' }));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await user.type(screen.getByRole('textbox'), '2105550134');
        await user.click(screen.getByRole('button', { name: message('auth.worker.send_otp') }));

        expect(await screen.findByText(message('auth.worker.errors.too_many_attempts'))).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('auth.worker.signup_nudge') })).not.toBeInTheDocument();
    });

    it('is not offered on the code step, where the same error means too many wrong codes', async () => {
        cognito.workerVerifyOtp.mockRejectedValueOnce(notAuthorized());
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        expect(await screen.findByText(message('auth.worker.errors.invalid_credentials'))).toBeInTheDocument();
        expect(screen.getByText(message('auth.worker.otp_title'))).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('auth.worker.signup_nudge') })).not.toBeInTheDocument();
    });

    it('is gone again once the worker steps back from the code to sign-in', async () => {
        cognito.workerVerifyOtp.mockRejectedValueOnce(notAuthorized());
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);
        await screen.findByText(message('auth.worker.errors.invalid_credentials'));
        await user.click(screen.getByRole('button', { name: message('auth.worker.back') }));

        expect(screen.getByRole('button', { name: message('auth.worker.send_otp') })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('auth.worker.signup_nudge') })).not.toBeInTheDocument();
    });
});

/**
 * A correct code must start the session whatever the browser does with
 * storage. Where site data is blocked the `sessionStorage` property access
 * itself throws, and where storage is switched off (some in-app web views)
 * the property is null. Both used to stop the sign-in after the code was
 * accepted, with a sign-up error and no session.
 */
describe('WorkerAuthForm — storage the browser will not hand over', () => {
    let restore: (() => void) | null = null;

    afterEach(() => {
        restore?.();
        restore = null;
    });

    function storageIs(get: () => unknown) {
        const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        Object.defineProperty(window, 'sessionStorage', { configurable: true, get });
        restore = () => {
            if (original) Object.defineProperty(window, 'sessionStorage', original);
            else delete (window as { sessionStorage?: unknown }).sessionStorage;
        };
    }

    it.each<[string, () => unknown]>([
        ['throws on access', () => { throw new DOMException('The operation is insecure.', 'SecurityError'); }],
        ['is null', () => null],
    ])('starts the session and routes the worker when storage %s', async (_label, get) => {
        query.current = new URLSearchParams({ job: JOB_ID });
        storageIs(get);
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'worker');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

/**
 * The job opened last wins. A sign-in bounced from job B's page
 * (`?returnUrl=/{locale}/worker/jobs/<B>`) is about B, whatever an earlier,
 * unfinished referral left in this tab's stash. The server shows the NEWEST
 * unapplied referred job on the onboarding strip and on the summary, so B must
 * be recorded last; the leftover referral is still claimed, first and on its
 * own, so its referrer keeps the credit and its job stays pinned. Never inside
 * B's claim: the server records a claim's job before the job its share code
 * names, which would make the leftover job the newest.
 */
describe('WorkerAuthForm — the job opened last wins over a leftover referral', () => {
    const LEFTOVER_JOB_ID = '2b7c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
    const LEFTOVER_CODE = '4M7P9R2T';
    const BOUNCE = `/es/worker/jobs/${JOB_ID}`;

    function leftover(referral: { jobId: string | null; shareCode: string | null }) {
        sessionStorage.setItem('pendingReferral', JSON.stringify(referral));
    }

    const claimed = () => api.claimReferral.mock.calls.map(([, body]) => body);

    it('claims the leftover first and the bounced-from job last, then opens that job', async () => {
        leftover({ jobId: LEFTOVER_JOB_ID, shareCode: null });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith(BOUNCE));
        expect(claimed()).toEqual([
            { jobId: LEFTOVER_JOB_ID, shareCode: null },
            { jobId: JOB_ID, shareCode: null },
        ]);
        expect(push).not.toHaveBeenCalled();
        expect(stashed()).toBeNull();
    });

    it('records the bounced-from job last for a worker still onboarding, and leaves it as the fallback', async () => {
        leftover({ jobId: LEFTOVER_JOB_ID, shareCode: null });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(claimed()).toEqual([
            { jobId: LEFTOVER_JOB_ID, shareCode: null },
            { jobId: JOB_ID, shareCode: null },
        ]);
        // Should neither claim land, the summary screen falls back to the stash:
        // it now names the job the worker opened last.
        expect(stashed()).toEqual({ jobId: JOB_ID, shareCode: null });
    });

    it("sends a leftover's share code with the leftover's own claim, never with the job opened last", async () => {
        leftover({ jobId: LEFTOVER_JOB_ID, shareCode: LEFTOVER_CODE });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith(BOUNCE));
        expect(claimed()).toEqual([
            { jobId: LEFTOVER_JOB_ID, shareCode: LEFTOVER_CODE },
            { jobId: JOB_ID, shareCode: null },
        ]);
    });

    it('claims a leftover link that names no job on its own, before the bounced-from job', async () => {
        leftover({ jobId: null, shareCode: LEFTOVER_CODE });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(claimed()).toEqual([
            { jobId: null, shareCode: LEFTOVER_CODE },
            { jobId: JOB_ID, shareCode: null },
        ]);
    });

    it('makes one claim, keeping the share code, when the leftover is for the same job', async () => {
        leftover({ jobId: JOB_ID, shareCode: LEFTOVER_CODE });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(assignReturnPath).toHaveBeenCalledWith(BOUNCE));
        expect(claimed()).toEqual([{ jobId: JOB_ID, shareCode: LEFTOVER_CODE }]);
    });

    it('sends the job opened last only once the leftover claim has settled, and even when it failed', async () => {
        leftover({ jobId: LEFTOVER_JOB_ID, shareCode: LEFTOVER_CODE });
        query.current = new URLSearchParams({ returnUrl: BOUNCE });
        let failFirst!: (err: Error) => void;
        api.claimReferral.mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }));
        const user = userEvent.setup();
        render(<WorkerAuthForm />);
        await signIn(user);

        await waitFor(() => expect(api.claimReferral).toHaveBeenCalledTimes(1));
        expect(claimed()).toEqual([{ jobId: LEFTOVER_JOB_ID, shareCode: LEFTOVER_CODE }]);
        failFirst(new Error('500'));

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/onboarding'));
        expect(claimed()).toEqual([
            { jobId: LEFTOVER_JOB_ID, shareCode: LEFTOVER_CODE },
            { jobId: JOB_ID, shareCode: null },
        ]);
        expect(api.claimReferral.mock.invocationCallOrder[1])
            .toBeLessThan(setTokens.mock.invocationCallOrder[0]);
    });

    it("reads this visit's own link at verify time, so a stash that cannot be written loses nothing", async () => {
        const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
        });
        try {
            query.current = new URLSearchParams({ job: JOB_ID, share: TYPED_CODE });
            api.getWorkerOnboarding.mockResolvedValue({ lifecycle: 'ready' });
            const user = userEvent.setup();
            render(<WorkerAuthForm />);
            await signIn(user);

            await waitFor(() => expect(push).toHaveBeenCalledWith(`/worker/jobs/${JOB_ID}`));
            expect(claimed()).toEqual([{ jobId: JOB_ID, shareCode: SHARE_CODE }]);
        } finally {
            if (original) Object.defineProperty(window, 'sessionStorage', original);
        }
    });
});

describe('WorkerAuthForm — where the signup came from (K3.6, T-c)', () => {
    async function createAccount(user: ReturnType<typeof userEvent.setup>) {
        await user.type(screen.getByRole('textbox'), '2100000000');
        await user.click(screen.getByRole('button', { name: message('auth.worker.create_account') }));
        await waitFor(() => expect(cognito.workerSignUp).toHaveBeenCalledTimes(1));
        return cognito.workerSignUp.mock.calls[0][0];
    }

    it('sends the /app link\'s code, once', async () => {
        query.current = new URLSearchParams('step=signup&src=qr');
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        expect((await createAccount(user)).signupSource).toEqual({ src: 'qr', entry: 'app' });
        expect(sessionStorage.getItem('jale.signup-source')).toBeNull();
    });

    it('drops a code that is not one of Jale\'s own', async () => {
        query.current = new URLSearchParams('step=signup&src=evil-code');
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        expect((await createAccount(user)).signupSource).toEqual({ src: null, entry: 'app' });
    });

    it('keeps the first touch of the visit', async () => {
        sessionStorage.setItem('jale.signup-source', JSON.stringify({ src: 'flyer', entry: 'job_link', capturedAt: '2026-10-14T00:00:00.000Z' }));
        query.current = new URLSearchParams('step=signup&src=qr');
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        expect((await createAccount(user)).signupSource).toEqual({ src: 'flyer', entry: 'job_link' });
    });

    it('still signs up when storage refuses', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        query.current = new URLSearchParams('step=signup&src=qr');
        const user = userEvent.setup();
        render(<WorkerAuthForm />);

        expect((await createAccount(user)).signupSource).toBeNull();
        vi.restoreAllMocks();
    });
});
