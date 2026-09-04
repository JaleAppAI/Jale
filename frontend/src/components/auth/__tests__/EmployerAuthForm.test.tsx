// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/messages/en.json';

/**
 * The incident these tests exist for: an employer with the WRONG PASSWORD used
 * the login step's "I never received my confirmation code" link. That link
 * emailed a SIGN-UP confirmation code; entering it called `ConfirmSignUp` on an
 * already-CONFIRMED account, Cognito answered `NotAuthorizedException`, and the
 * shared mapper turned that into "The email or password is incorrect" — on a
 * screen with no password field. He looped three times.
 *
 * Three separate things had to hold for that loop to close, so all three are
 * pinned here rather than in the mapper unit tests alone:
 *   1. the login step no longer offers the link at all (the `forgot_request`
 *      step keeps it — that step IS a genuine dead end for an unconfirmed user),
 *   2. an already-confirmed confirm lands on login with copy that matches the
 *      screen, and
 *   3. a confirm that succeeded but whose sign-in failed says so, instead of
 *      denying the confirm that just worked.
 *
 * Copy is asserted by resolving the REAL `en.json` rather than by hardcoding
 * sentences: these strings carry em dashes and curly quotes, and a character
 * mismatch in a test literal reads exactly like a logic bug. The mock resolves
 * against the same file, so a missing key fails loudly instead of rendering an
 * empty string that would let the "link is gone" assertion pass for the wrong
 * reason.
 */

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path against the real English catalogue. Throws if absent. */
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

/** Stand-in for next-intl's ICU interpolation — `{name}` substitution only. */
function translate(namespace: string, key: string, values?: TranslationValues): string {
    const raw = message(`${namespace}.${key}`);
    if (!values) return raw;
    return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in values ? String(values[name]) : whole,
    );
}

const { push, setTokens, cognito } = vi.hoisted(() => ({
    push: vi.fn(),
    setTokens: vi.fn(),
    cognito: {
        employerSignIn: vi.fn(),
        employerSignUp: vi.fn(),
        employerConfirmSignUp: vi.fn(),
        employerResendConfirmationCode: vi.fn(),
        employerForgotPassword: vi.fn(),
        employerConfirmNewPassword: vi.fn(),
    },
}));

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) =>
        (key: string, values?: TranslationValues) => translate(namespace, key, values),
}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ setTokens }) }));
vi.mock('@/lib/cognito', () => cognito);
// The signup step's city field is a `LocationPicker`, which debounces a real
// dataset query. Stubbed so the Enter-key assertions below are about the form
// and not about a fetch that jsdom cannot serve.
vi.mock('@/lib/location-search', () => ({ queryLocations: vi.fn().mockResolvedValue([]) }));

import EmployerAuthForm from '@/components/auth/EmployerAuthForm';

const NEVER_RECEIVED = message('auth.employer.never_received_code');
const LOGIN_MARKER = message('auth.employer.title');
const RECOVERY_MARKER = message('auth.employer.recovery_title');
const FORGOT_MARKER = message('auth.employer.forgot_title');

/** Cognito's own shape for the two failures this flow turns on. */
const unconfirmedError = { code: 'UserNotConfirmedException', name: 'UserNotConfirmedException' };
const notAuthorizedError = {
    code: 'NotAuthorizedException',
    name: 'NotAuthorizedException',
    message: 'User cannot be confirmed. Current status is CONFIRMED',
};

/**
 * Signs in with credentials Cognito rejects as unconfirmed, which is the
 * auto-recovery path: the form asks for a fresh code and drops the user on the
 * confirm step. Reaching the confirm step at all is therefore an assertion in
 * its own right, not just setup.
 */
async function reachConfirmStepViaSignIn(user: ReturnType<typeof userEvent.setup>) {
    cognito.employerSignIn.mockRejectedValueOnce(unconfirmedError);
    cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);

    await user.type(screen.getByPlaceholderText(message('auth.employer.email_label')), 'employer@example.com');
    await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'WrongPass1!');
    await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.sign_in')}`) }));

    expect(await screen.findByText(RECOVERY_MARKER)).toBeInTheDocument();
}

beforeEach(() => {
    vi.clearAllMocks();
    // jsdom hands every file in this environment the same storage, so a stale
    // key would make the "must not stage a profile patch" assertion pass or
    // fail for reasons belonging to an earlier test.
    sessionStorage.clear();
});

afterEach(() => {
    cleanup();
});

describe('EmployerAuthForm — login step recovery affordances', () => {
    it('does not offer the confirmation-code link on the login step', () => {
        render(<EmployerAuthForm />);

        expect(screen.getByText(LOGIN_MARKER)).toBeInTheDocument();
        // The link only ever fired for a wrong-password user: a correct
        // password on an unconfirmed account already auto-recovers through
        // `UserNotConfirmedException`, which the confirm-step tests cover.
        expect(screen.queryByText(NEVER_RECEIVED)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: NEVER_RECEIVED })).not.toBeInTheDocument();
        // Nothing relabelled may reach the resend either, and rendering the
        // step must not fire one on its own.
        expect(screen.queryAllByRole('button', { name: /code/i })).toHaveLength(0);
        expect(cognito.employerResendConfirmationCode).not.toHaveBeenCalled();

        // The password escape hatch stays: dropping both would leave the step
        // with no recovery at all.
        expect(screen.getByRole('button', { name: message('auth.employer.forgot_link') })).toBeInTheDocument();
    });

    it('keeps the confirmation-code link on the forgot-password step', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);

        await user.click(screen.getByRole('button', { name: message('auth.employer.forgot_link') }));

        // Cognito's forgot-password call reports success for an UNCONFIRMED
        // user without sending anything, so this step is the one genuine dead
        // end and the link is the only way out of it.
        expect(await screen.findByText(FORGOT_MARKER)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: NEVER_RECEIVED })).toBeInTheDocument();
    });
});

describe('EmployerAuthForm — confirm step', () => {
    it('sends an already-confirmed employer back to login with copy that fits the screen', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await reachConfirmStepViaSignIn(user);

        cognito.employerConfirmSignUp.mockRejectedValueOnce(notAuthorizedError);
        await user.type(screen.getByRole('textbox'), '123456');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.confirm_account')}`) }));

        expect(await screen.findByText(LOGIN_MARKER)).toBeInTheDocument();
        expect(screen.getByText(message('auth.employer.errors.already_confirmed'))).toBeInTheDocument();
        // The sentence that caused the loop must be gone: there is no password
        // field on the screen it used to appear on.
        expect(screen.queryByText(message('auth.employer.errors.invalid_credentials'))).not.toBeInTheDocument();
        // Nothing was confirmed here, so the confirmed banner must NOT show —
        // this is what separates this branch from the one below it.
        expect(screen.queryByText(message('auth.employer.confirmed_sign_in'))).not.toBeInTheDocument();
        // One resend, from the auto-recovery. A refused confirm must not spend
        // another attempt against Cognito's 5-per-hour cap.
        expect(cognito.employerResendConfirmationCode).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();
        // A recovery confirm has no signup form behind it, so it must never
        // stage a profile patch: the patch always carries `hiring_trades` and
        // `typical_job_types`, and the API reads a present key as intentional,
        // so staging one here would empty a real employer's trades.
        expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull();
    });

    it('says the confirm worked when only the sign-in behind it failed', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await reachConfirmStepViaSignIn(user);

        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        cognito.employerSignIn.mockRejectedValueOnce({
            code: 'NotAuthorizedException',
            name: 'NotAuthorizedException',
            message: 'Incorrect username or password.',
        });
        await user.type(screen.getByRole('textbox'), '123456');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.confirm_account')}`) }));

        expect(await screen.findByText(LOGIN_MARKER)).toBeInTheDocument();
        // Both lines, together: the account really is confirmed now, and the
        // bare password error alone would deny the confirm that just worked.
        expect(screen.getByText(message('auth.employer.confirmed_sign_in'))).toBeInTheDocument();
        expect(screen.getByText(message('auth.employer.errors.confirmed_sign_in_failed'))).toBeInTheDocument();
        expect(screen.queryByText(message('auth.employer.errors.invalid_credentials'))).not.toBeInTheDocument();
        expect(setTokens).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('keeps the real reason when the post-confirm sign-in failed for some other cause', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await reachConfirmStepViaSignIn(user);

        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        cognito.employerSignIn.mockRejectedValueOnce({
            code: 'TooManyRequestsException',
            name: 'TooManyRequestsException',
        });
        await user.type(screen.getByRole('textbox'), '123456');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.confirm_account')}`) }));

        expect(await screen.findByText(LOGIN_MARKER)).toBeInTheDocument();
        // Only a credentials failure gets the password apology. Blaming the
        // password for a rate limit would send a user who typed it correctly
        // off to reset a password that was never the problem.
        expect(screen.getByText(message('auth.employer.errors.too_many_attempts'))).toBeInTheDocument();
        expect(screen.queryByText(message('auth.employer.errors.confirmed_sign_in_failed'))).not.toBeInTheDocument();
        // The confirm still worked, so the banner still belongs on screen.
        expect(screen.getByText(message('auth.employer.confirmed_sign_in'))).toBeInTheDocument();
    });
});

/**
 * The second half of the same incident. An employer whose account was never
 * confirmed cannot reset their password AT ALL: the employer pool recovers
 * phone-first, they have no verified email, and Cognito refuses with
 * `InvalidParameterException` + "there is no registered/verified email or
 * phone_number". That message mentions `phone_number`, so the shared mapper
 * answered "Enter a valid phone number" — on a step whose only field is an
 * email address.
 *
 * The reset is unreachable for them by design, so the fix is not better
 * wording: it is to put them on the flow that does work, which is the same
 * confirmation-code recovery the login step already runs.
 */
/**
 * Every step of this form used to be a `Button onClick` with no `<form>`
 * anywhere in the file, so Enter did nothing at all — on a login screen, which
 * is the one place every user expects it to work. Five steps, one keystroke,
 * and the guards have to hold: a primary button that is disabled (or already
 * mid-request) must block Enter exactly as it blocks a click, or the flow will
 * fire twice against Cognito's per-hour caps.
 */
describe('EmployerAuthForm — Enter submits the step it is pressed in', () => {
    it('signs in from the password field, exactly once', async () => {
        const user = userEvent.setup();
        cognito.employerSignIn.mockResolvedValueOnce({ accessToken: 'a', idToken: 'i', refreshToken: 'r' });
        render(<EmployerAuthForm />);

        await user.type(screen.getByPlaceholderText(message('auth.employer.email_label')), 'employer@example.com');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass{Enter}');

        // Once, not twice: the primary button is `type="submit"` and carries no
        // `onClick` of its own. Keeping both would double every request.
        expect(cognito.employerSignIn).toHaveBeenCalledTimes(1);
        expect(cognito.employerSignIn).toHaveBeenCalledWith('employer@example.com', 'S3cret!pass');
    });

    it('still signs in exactly once when the button is clicked', async () => {
        const user = userEvent.setup();
        cognito.employerSignIn.mockResolvedValueOnce({ accessToken: 'a', idToken: 'i', refreshToken: 'r' });
        render(<EmployerAuthForm />);

        await user.type(screen.getByPlaceholderText(message('auth.employer.email_label')), 'employer@example.com');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.sign_in')}`) }));

        expect(cognito.employerSignIn).toHaveBeenCalledTimes(1);
    });

    it('confirms the account from the code field', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await reachConfirmStepViaSignIn(user);

        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        cognito.employerSignIn.mockResolvedValueOnce({ accessToken: 'a', idToken: 'i', refreshToken: 'r' });
        await user.type(screen.getByRole('textbox'), '123456{Enter}');

        expect(cognito.employerConfirmSignUp).toHaveBeenCalledTimes(1);
        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('employer@example.com', '123456');
    });

    it('is blocked while the primary button is disabled', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);

        await user.click(screen.getByRole('button', { name: message('auth.employer.forgot_link') }));
        expect(await screen.findByText(FORGOT_MARKER)).toBeInTheDocument();
        // Send is disabled until an address is typed, so Enter must be too —
        // otherwise the keyboard path skips a guard the mouse path honours.
        await user.type(screen.getByRole('textbox'), '{Enter}');

        expect(cognito.employerForgotPassword).not.toHaveBeenCalled();
    });

    it('is blocked on the confirm step until the code is long enough', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await reachConfirmStepViaSignIn(user);

        await user.type(screen.getByRole('textbox'), '12{Enter}');

        expect(cognito.employerConfirmSignUp).not.toHaveBeenCalled();
    });

    it('is not fired by the controls inside the signup step', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        await user.click(screen.getByRole('button', { name: message('auth.employer.signup_link') }));

        // A `<button>` with no `type` defaults to submit, so wrapping this step
        // in a `<form>` puts every child component's buttons one click away
        // from creating an account. `CheckboxCard` and `LocationPicker` belong
        // to other lanes' files, so this pins their behaviour from outside.
        await user.click(screen.getByText(message('auth.employer.trades.electrician')));
        // `<select>` maps to `combobox` too (country code, company size), so the
        // city field is the one that is an `<input>`.
        const cityField = screen.getAllByRole('combobox').find((el) => el.tagName === 'INPUT');
        expect(cityField).toBeDefined();
        await user.type(cityField!, 'San Antonio{Enter}');

        expect(cognito.employerSignUp).not.toHaveBeenCalled();
    });

    it('opens every step with its first field focused', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);

        // Nothing to click before typing: the field the step is about already
        // has the cursor.
        expect(screen.getByPlaceholderText(message('auth.employer.email_label'))).toHaveFocus();

        await user.click(screen.getByRole('button', { name: message('auth.employer.forgot_link') }));
        expect(await screen.findByText(FORGOT_MARKER)).toBeInTheDocument();
        expect(screen.getByRole('textbox')).toHaveFocus();
    });
});

describe('EmployerAuthForm — forgot password for an unconfirmed account', () => {
    /** Cognito's real refusal for an account with no verified contact. */
    const noVerifiedContactError = {
        code: 'InvalidParameterException',
        name: 'InvalidParameterException',
        message: 'Cannot reset password for the user as there is no registered/verified email or phone_number',
    };

    async function requestResetFor(user: ReturnType<typeof userEvent.setup>, address: string) {
        await user.click(screen.getByRole('button', { name: message('auth.employer.forgot_link') }));
        expect(await screen.findByText(FORGOT_MARKER)).toBeInTheDocument();
        await user.type(screen.getByRole('textbox'), address);
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.send_code')}`) }));
    }

    it('sends a new confirmation code and moves to the confirm step', async () => {
        const user = userEvent.setup();
        cognito.employerForgotPassword.mockRejectedValueOnce(noVerifiedContactError);
        cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);
        render(<EmployerAuthForm />);

        await requestResetFor(user, 'unconfirmed@example.com');

        // The confirm step, in recovery mode — not the reset-code step, which
        // is a dead end for this account.
        expect(await screen.findByText(RECOVERY_MARKER)).toBeInTheDocument();
        expect(
            screen.getByText(translate('auth.employer', 'forgot_not_confirmed', { email: 'unconfirmed@example.com' })),
        ).toBeInTheDocument();
        // The address typed on the forgot step has to be promoted: `handleConfirm`
        // reads `email`, and the resend has to go to the same place.
        expect(cognito.employerResendConfirmationCode).toHaveBeenCalledTimes(1);
        expect(cognito.employerResendConfirmationCode).toHaveBeenCalledWith('unconfirmed@example.com');
        expect(
            screen.getByText(translate('auth.employer', 'confirm_subtitle', { email: 'unconfirmed@example.com' })),
        ).toBeInTheDocument();
    });

    it('never blames the phone field for it', async () => {
        const user = userEvent.setup();
        cognito.employerForgotPassword.mockRejectedValueOnce(noVerifiedContactError);
        cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);
        render(<EmployerAuthForm />);

        await requestResetFor(user, 'unconfirmed@example.com');

        await screen.findByText(RECOVERY_MARKER);
        // The sentence that made this incident unreadable. There is no phone
        // field anywhere in this flow.
        expect(screen.queryByText(message('auth.employer.errors.invalid_phone'))).not.toBeInTheDocument();
        // One banner, not two: the recovery notice replaces the generic
        // "we sent a new code" line rather than stacking with it.
        expect(
            screen.queryByText(translate('auth.employer', 'code_sent', { email: 'unconfirmed@example.com' })),
        ).not.toBeInTheDocument();
        // The send that just went out is accounted for against Cognito's
        // 5-per-hour cap, so the Resend affordance is held rather than offered.
        expect(screen.getByText(translate('auth.employer', 'resend_cooldown', { seconds: 60 }))).toBeInTheDocument();
    });

    it('leaves an ordinary reset failure on the forgot step with its own message', async () => {
        const user = userEvent.setup();
        cognito.employerForgotPassword.mockRejectedValueOnce({
            code: 'LimitExceededException',
            name: 'LimitExceededException',
        });
        render(<EmployerAuthForm />);

        await requestResetFor(user, 'employer@example.com');

        // Only the unconfirmed refusal reroutes. A rate limit is about this
        // request, not about the account, so the step and its copy stay put —
        // and nothing may spend a resend attempt on it.
        expect(await screen.findByText(message('auth.employer.errors.too_many_attempts'))).toBeInTheDocument();
        expect(screen.getByText(FORGOT_MARKER)).toBeInTheDocument();
        expect(cognito.employerResendConfirmationCode).not.toHaveBeenCalled();
    });

    it('keeps the reset flow when Cognito accepts the request', async () => {
        const user = userEvent.setup();
        cognito.employerForgotPassword.mockResolvedValueOnce(undefined);
        render(<EmployerAuthForm />);

        await requestResetFor(user, 'employer@example.com');

        expect(await screen.findByText(message('auth.employer.forgot_confirm_title'))).toBeInTheDocument();
        expect(cognito.employerResendConfirmationCode).not.toHaveBeenCalled();
    });
});

describe('EmployerAuthForm — sign-in call', () => {
    /**
     * The form forwards what the user typed, verbatim: normalisation belongs to
     * `@/lib/cognito` (every other employer call already normalises there, and
     * four sibling call sites in this same form pass raw state too). Pinning
     * the raw hand-off here and the `.trim().toLowerCase()` in
     * `cognito-employer-sign-in.test.ts` keeps that seam where it is instead of
     * duplicating the rule into the component.
     *
     * Note what actually survives the input: `type="email"` strips leading and
     * trailing whitespace per the HTML spec, so the trim is nearly moot — but
     * the CASING reaches the wrapper untouched, and casing is precisely what
     * `employerSignIn` used to hand Cognito while every other employer call
     * lower-cased it.
     */
    it('hands the typed address to the Cognito wrapper with its casing intact', async () => {
        const user = userEvent.setup();
        cognito.employerSignIn.mockResolvedValueOnce({
            accessToken: 'a', idToken: 'i', refreshToken: 'r',
        });
        render(<EmployerAuthForm />);

        await user.type(screen.getByPlaceholderText(message('auth.employer.email_label')), '  Foo@Example.com ');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.sign_in')}`) }));

        expect(cognito.employerSignIn).toHaveBeenCalledWith('Foo@Example.com', 'S3cret!pass');
    });

    it('shows the normalised address on the confirm step it routes to', async () => {
        const user = userEvent.setup();
        render(<EmployerAuthForm />);
        cognito.employerSignIn.mockRejectedValueOnce(unconfirmedError);
        cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);

        await user.type(screen.getByPlaceholderText(message('auth.employer.email_label')), '  Foo@Example.com ');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.sign_in')}`) }));

        // The address Cognito will actually match on — shown so a typo is
        // visible before the user spends resend attempts on it.
        expect(
            await screen.findByText(translate('auth.employer', 'confirm_subtitle', { email: 'foo@example.com' })),
        ).toBeInTheDocument();
    });
});
