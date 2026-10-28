'use client';
import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerConfirmSignUp, employerSignIn, employerSignUp, employerForgotPassword, employerConfirmNewPassword, employerResendConfirmationCode, type AuthTokens } from '@/lib/cognito';
import { captureSignupSource } from '@/lib/signup-source';
import { isLegalWallError, isMembershipBlockedError, type MembershipBlockedError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { acceptInvite, getMembership } from '@/lib/api/team';
import { clearEmployerMembershipCache } from '@/lib/employer-membership-store';
import { clearPendingInvite, storedInviteTokenFor } from '@/lib/employer-profile-flush';
import { isTeamManagementEnabled } from '@/lib/feature-flags';
import { authErrorKey, confirmErrorKey, forgotErrorKey, resendErrorKey } from '@/lib/auth-errors';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CompanySize, EmployerJobType, EmployerProfilePatch, EmployerTrade } from '@/lib/api/employer';
import { validateEmployerSignupFields, type EmployerSignupField } from '@/lib/employer-profile-form';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { PhoneNumberField } from '@/components/auth/PhoneNumberField';
import { SUPPORT_CONTACT } from '@/lib/support-contact';

const TRADES: EmployerTrade[] = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];
const JOB_TYPES: EmployerJobType[] = ['full-time', 'part-time', 'contract'];
const COMPANY_SIZES: CompanySize[] = ['1-10', '11-50', '51-200', '200+'];

type Step = 'login' | 'signup' | 'confirm' | 'forgot_request' | 'forgot_confirm';

/**
 * How the user arrived at the `confirm` step. It is not cosmetic: a signup
 * confirm has a filled-in form behind it and a password to sign in with, while
 * a recovery confirm has neither, and treating the two the same destroys
 * profile data (see `handleConfirm`).
 */
type ConfirmOrigin = 'signup' | 'signin';

/**
 * Result of a resend attempt. `skipped` means the cooldown swallowed the call —
 * distinct from `sent` because it must NOT restart the cooldown (that would let
 * repeated clicks extend it forever), and distinct from `failed` because the
 * user's newest code is still on its way, so nothing is wrong.
 */
type ResendOutcome =
    | { status: 'sent' }
    | { status: 'skipped' }
    | { status: 'failed'; key: string };

/**
 * Client-side gap between resend requests. Cognito's real cap is 5 resends per
 * user per hour, which this cannot enforce — it exists so a user cannot spend
 * that budget on double-clicks before the first email has even landed.
 */
const RESEND_COOLDOWN_SECONDS = 60;

// Maps each missing-field code to the shared "fields.*" label already used to
// render this form's own inputs, so the summary line and the field labels stay
// in sync with the fields themselves.
const FIELD_LABEL_KEY: Record<EmployerSignupField, string> = {
    company_name: 'fields.company_name',
    contact_name: 'fields.contact_name',
    email: 'fields.email',
    // The signup step labels this field "Create password" (sign-in keeps
    // "Password"), and this map only feeds the signup summary.
    password: 'fields.password_create',
    password_confirm: 'fields.password_confirm',
    phone: 'fields.phone',
    city: 'fields.city',
    service_area: 'fields.service_area',
    hiring_trades: 'fields.hiring_trades',
    typical_job_types: 'fields.typical_job_types',
};

/**
 * Phase 3: an invite the invite page looked up. `email` is the invite's own
 * address, normalised (`trim().toLowerCase()`); the form locks it.
 */
export type EmployerInvite = {
    token: string;
    email: string;
    companyName: string;
    contactName: string | null;
    /** A Jale employer login already has this email: sign in, then accept. */
    existingAccount: boolean;
};

type EmployerAuthFormProps =
    | { mode?: undefined; invite?: undefined }
    | { mode: 'invite'; invite: EmployerInvite };

/**
 * What an invited foreman's sign-up asks for. Everything else on the sign-up
 * step describes a company, and they join the inviting one: a foreman may not
 * write company fields, so collecting them would only lose them.
 */
const INVITE_SIGNUP_FIELDS: readonly EmployerSignupField[] = ['contact_name', 'email', 'password', 'password_confirm', 'phone'];

/**
 * An accept refusal's copy, inside `auth.employer`. Anything unlisted (a
 * transport failure, a 500) reads as the generic line.
 */
const INVITE_ACCEPT_ERROR_KEYS: Record<string, string> = {
    invite_email_mismatch: 'invite.email_mismatch',
    already_member: 'invite.already_member',
    employer_required: 'invite.employer_required',
    invite_not_found: 'invite.not_found',
    invite_expired: 'invite.expired',
    invite_revoked: 'invite.revoked',
    invite_used: 'invite.used',
    busy: 'invite.busy',
};

function inviteAcceptErrorKey(err: unknown): string {
    return (err instanceof ApiError && INVITE_ACCEPT_ERROR_KEYS[err.code]) || 'invite.generic';
}

/**
 * Cognito's answer for a disabled user (a removed or billing-suspended
 * foreman, Phase 3): `NotAuthorizedException` with exactly this message.
 * `authErrorKey` would read it as a wrong password.
 */
function isDisabledAccountError(err: unknown): boolean {
    const e = err as { code?: string; name?: string; message?: string } | null;
    return (e?.code ?? e?.name) === 'NotAuthorizedException' && e?.message === 'User is disabled.';
}

/** Where `useRequireAuth().handleLegalWall` sends a blocked login; the same URL. */
function accessPath(err: MembershipBlockedError): string {
    return err.statusKnown
        ? `/employer/access?reason=${err.reason}${err.hasInvite ? '&invite=1' : ''}`
        : '/employer/access';
}

/**
 * The invite page, WITHOUT a locale: `legalReturnUrl` goes through next-intl's
 * router, which adds the locale itself (a prefixed path became `/en/en/…`).
 * The token is in sessionStorage, so the page finds it again on return.
 */
export const INVITE_PAGE_PATH = '/auth/employer/invite';

/**
 * What an accept came to. `joined` and `blocked` hand the session to the app
 * and land on the dashboard / the access screen; `legal_wall` goes to
 * `/legal/accept` (the return URL is already stored); `refused` stays and
 * shows `key` (inside `auth.employer`).
 */
export type InviteAcceptOutcome =
    | { kind: 'joined' }
    | { kind: 'blocked'; path: string }
    | { kind: 'legal_wall' }
    | { kind: 'refused'; code: string | null; key: string };

/**
 * Accepts the invite for `idToken`'s login and classifies the answer. Never
 * throws. A `joined` answer has cleared the stored invite.
 *
 * `loginIsInvitee`: the login's email is known to be the invite's (invite
 * mode locks it). The backend (130) answers `invite_used` before it compares
 * emails, so only then does `invite_used` plus an active membership mean this
 * person already accepted it (a double submit, or post-confirmation did): the
 * accept is idempotent and lands on the dashboard. For any other login it is
 * the `used` copy. `already_member` always means the invite is still live and
 * the login belongs to another company: its copy, never a redirect.
 */
export async function settleInviteAccept(
    idToken: string,
    inviteToken: string,
    loginIsInvitee: boolean,
): Promise<InviteAcceptOutcome> {
    let refusal: unknown;
    try {
        await acceptInvite(idToken, inviteToken);
        clearPendingInvite();
        return { kind: 'joined' };
    } catch (err) {
        refusal = err;
    }
    if (isLegalWallError(refusal)) {
        try {
            sessionStorage.setItem('legalReturnUrl', INVITE_PAGE_PATH);
        } catch {
            // Storage out of reach: the legal page falls back to its default.
        }
        return { kind: 'legal_wall' };
    }
    if (isMembershipBlockedError(refusal)) return { kind: 'blocked', path: accessPath(refusal) };
    const code = refusal instanceof ApiError ? refusal.code : null;
    if (code === 'invite_used' && loginIsInvitee) {
        try {
            await getMembership(idToken);
            clearPendingInvite();
            return { kind: 'joined' };
        } catch (err) {
            if (isMembershipBlockedError(err)) return { kind: 'blocked', path: accessPath(err) };
            // Any other failure: the `used` copy.
        }
    }
    return { kind: 'refused', code, key: inviteAcceptErrorKey(refusal) };
}

/**
 * The employer sign-in / sign-up form.
 *
 * `mode="invite"` (Phase 3, the invite page only): the email is the invite's
 * and locked; a new account signs up as a foreman (no company fields, Cognito
 * `name` = their own name) and its confirm carries the invite token to the
 * post-confirmation trigger; an existing account signs in, then accepts. In
 * this mode the form lands the session itself, on the dashboard.
 *
 * Without it, the plain page: unchanged from Phase 2, except that with the
 * team flag on its confirm step forwards a stored invite token whose email
 * matches the one being confirmed (I4).
 */
export default function EmployerAuthForm(props: EmployerAuthFormProps = {}) {
    const invite = props.mode === 'invite' ? props.invite : null;
    const inviteMode = invite !== null;
    const t = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();
    const router = useRouter();

    const [step, setStep] = useState<Step>(() => (invite && !invite.existingAccount ? 'signup' : 'login'));
    const [email, setEmail] = useState(() => invite?.email ?? '');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
    const [confirmationCode, setConfirmationCode] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [contactName, setContactName] = useState(() => invite?.contactName ?? '');
    const [phoneCountryCode, setPhoneCountryCode] = useState<PhoneCountryCode>('+1');
    const [phoneLocalNumber, setPhoneLocalNumber] = useState('');
    const [city, setCity] = useState('');
    const [serviceArea, setServiceArea] = useState('');
    const [hiringTrades, setHiringTrades] = useState<EmployerTrade[]>([]);
    const [typicalJobTypes, setTypicalJobTypes] = useState<EmployerJobType[]>([]);
    const [companySize, setCompanySize] = useState<CompanySize>('1-10');
    const [companyDescription, setCompanyDescription] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [missingFields, setMissingFields] = useState<EmployerSignupField[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    // The employer sign-up page is a first-party entry (analytics #16, K3.6).
    // Read from the address on arrival, once -- the `?apply=1` precedent in
    // the worker job page -- rather than through `useSearchParams`, which this
    // form does not otherwise need. An invite sign-up is not a company sign-up,
    // so invite mode records none.
    useEffect(() => {
        if (inviteMode) return;
        captureSignupSource({ src: new URLSearchParams(window.location.search).get('src'), entry: 'signup_page' });
    }, [inviteMode]);
    const [resetSuccess, setResetSuccess] = useState(false);
    const [forgotEmail, setForgotEmail] = useState('');
    const [resetCode, setResetCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [showNewPasswordConfirm, setShowNewPasswordConfirm] = useState(false);
    const [confirmOrigin, setConfirmOrigin] = useState<ConfirmOrigin>('signup');
    /**
     * The confirm step was reached from "Forgot password?" (F4). There, an
     * account that turns out to be CONFIRMED is one whose email was never
     * verified: no reset code can reach it, so the forgot flow must not be
     * offered back to it as the way out.
     */
    const [recoveryFromForgot, setRecoveryFromForgot] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(0);
    const [resendSuccess, setResendSuccess] = useState(false);
    const [confirmedSuccess, setConfirmedSuccess] = useState(false);
    // Set only by the forgot-password recovery below. It replaces the generic
    // "we sent a new code" line rather than adding to it: this user did not ask
    // for a confirmation code, so the banner has to say why they are looking at
    // one and what finishing it gets them.
    const [notConfirmedNotice, setNotConfirmedNotice] = useState(false);
    const phone = formatPhoneNumber(phoneCountryCode, phoneLocalNumber);

    // Counts the cooldown down to zero. Depending on `resendCooldown` rather
    // than on a ref means the interval is torn down the moment it reaches zero
    // (and on unmount), so nothing keeps ticking behind a navigation.
    useEffect(() => {
        if (resendCooldown <= 0) return undefined;
        const timer = setInterval(() => {
            setResendCooldown((seconds) => (seconds <= 1 ? 0 : seconds - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    /**
     * `forInvite`: the confirm carried an invite token, so this login joins a
     * company as a foreman. Only `{ contact_name, phone }` is staged: a
     * foreman's PATCH may not carry company fields, and the flush adds
     * `signup_source` only beside `company_name` (I4).
     */
    const pendingProfile = (forInvite: boolean): EmployerProfilePatch => forInvite ? {
        contact_name: contactName.trim(),
        phone: phone.trim(),
    } : {
        company_name: companyName.trim(),
        contact_name: contactName.trim(),
        phone: phone.trim(),
        city: city.trim(),
        service_area: serviceArea.trim(),
        hiring_trades: hiringTrades,
        typical_job_types: typicalJobTypes,
        company_size: companySize,
        company_description: companyDescription.trim(),
    };

    /**
     * Asks Cognito for a new confirmation code — the single funnel for all
     * three entry points (the two recovery links, and the confirm step's own
     * Resend button), so the cooldown cannot be bypassed by taking a different
     * route to the same call.
     *
     * `skipped` is not a failure: Cognito's cap is 5 resends per user per hour,
     * and a code sent seconds ago is still the newest one. Without a guard here,
     * clicking a recovery link a few times — or retrying a sign-in that keeps
     * failing — would spend that whole budget and lock the user out of the only
     * recovery path they have for an hour.
     *
     * It never throws: every caller needs the user to keep moving whether or
     * not the resend landed, because someone who already has a valid code must
     * still reach the input for it.
     */
    const requestNewCode = async (targetEmail: string): Promise<ResendOutcome> => {
        if (resendCooldown > 0 || isResending) return { status: 'skipped' };
        setIsResending(true);
        try {
            await employerResendConfirmationCode(targetEmail);
            return { status: 'sent' };
        } catch (err) {
            return { status: 'failed', key: resendErrorKey(err) };
        } finally {
            setIsResending(false);
        }
    };

    /**
     * Enters the confirm step in recovery mode after a resend attempt.
     *
     * `goToStep` clears `error`, so the failure message has to be set AFTER it
     * — otherwise the reset wins and the user gets a silent no-op. Same reason
     * the success line lives in its own state instead of reusing `error`.
     *
     * An already-confirmed account is the one case that does not belong on the
     * confirm step at all: there is no code coming, so the user is left on
     * login where the sentence ("already confirmed — sign in") matches the
     * screen they are looking at.
     *
     * `notice` picks which success line the step opens with. Both mean "the
     * newest code is on its way", but a user who came from the forgot-password
     * step asked for a password reset and is being handed a confirmation code
     * instead, so that arrival needs the sentence that explains the swap.
     */
    const enterRecoveryConfirm = (
        targetEmail: string,
        outcome: ResendOutcome,
        notice: 'code_sent' | 'not_confirmed' = 'code_sent',
        from: 'signin' | 'forgot' = 'signin',
    ) => {
        setEmail(targetEmail);
        setResetSuccess(false);
        if (outcome.status === 'failed' && outcome.key === 'errors.already_confirmed') {
            if (from === 'forgot') {
                // Confirmed, yet ForgotPassword found no verified contact: the
                // email was never verified, so neither a reset code nor a
                // confirmation code can reach it. Stay on this step with a
                // sentence that does not send them back into the same flow.
                setError(t('errors.reset_unavailable', { email: SUPPORT_CONTACT.email }));
                return;
            }
            goToStep('login');
            setError(t(outcome.key));
            return;
        }
        setRecoveryFromForgot(from === 'forgot');
        setConfirmationCode('');
        setConfirmOrigin('signin');
        goToStep('confirm');
        if (outcome.status === 'failed') {
            setError(t(outcome.key));
            // A refused resend still spent an attempt against the hourly cap,
            // so hold the button rather than inviting an immediate retry.
            setResendCooldown(RESEND_COOLDOWN_SECONDS);
            return;
        }
        // 'sent' and 'skipped' both mean the newest code is already on its way,
        // so the same confirmation is true for both — but only a call that
        // actually went out restarts the cooldown.
        if (notice === 'not_confirmed') setNotConfirmedNotice(true);
        else setResendSuccess(true);
        if (outcome.status === 'sent') setResendCooldown(RESEND_COOLDOWN_SECONDS);
    };

    /**
     * Invite mode: hands the signed-in session to the app and lands it. The
     * membership cache is dropped first, since this login's company just
     * changed.
     */
    const landInviteSession = (tokens: AuthTokens, path = '/employer/dashboard') => {
        clearEmployerMembershipCache();
        setTokens(tokens, 'employer');
        router.replace(path);
    };

    /**
     * Invite mode, after a successful sign-in: accept, then land. Never
     * throws; a refusal is shown on the login step and the session is NOT
     * handed to the app (the person asked to join, not to sign in). The
     * login's email is the invite's (locked), so `invite_used` with an active
     * membership is this person's own earlier accept (`settleInviteAccept`).
     */
    const joinInvite = async (current: EmployerInvite, tokens: AuthTokens) => {
        const outcome = await settleInviteAccept(tokens.idToken, current.token, true);
        switch (outcome.kind) {
            case 'joined':
                landInviteSession(tokens);
                return;
            case 'blocked':
                landInviteSession(tokens, outcome.path);
                return;
            case 'legal_wall':
                // Terms first (they need the session), then back to the page.
                setTokens(tokens, 'employer');
                router.replace('/legal/accept');
                return;
            case 'refused':
                setError(t(outcome.key));
        }
    };

    const handleSignIn = async () => {
        setError(null);
        if (!email.trim() || !password) {
            setError(t('errors.required'));
            return;
        }
        setIsLoading(true);
        try {
            const tokens = await employerSignIn(email, password);
            if (invite) {
                await joinInvite(invite, tokens);
                return;
            }
            // No navigation here: the auth page lands every fresh session (the
            // dashboard, or `returnUrl`). A push from the form raced it.
            setTokens(tokens, 'employer');
        } catch (err) {
            // Never console.error the raw exception: a Cognito error object
            // carries the submitted email and the request context, and the
            // browser console is shared with anything else on the page.
            // `authErrorKey` already turns the code into a translated sentence,
            // which is the only thing anyone needs from it.
            if (isTeamManagementEnabled() && isDisabledAccountError(err)) {
                setError(t('account_disabled'));
                return;
            }
            const key = authErrorKey(err);
            if (key === 'errors.account_not_confirmed') {
                // The credentials were fine; the account was simply never
                // confirmed. Getting a fresh code moving and dropping the user
                // straight onto the code input is the whole recovery path —
                // otherwise they are told to check an email they never got,
                // with no way to ask for another.
                enterRecoveryConfirm(email, await requestNewCode(email));
                return;
            }
            setError(t(key));
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * The escape hatch on the forgot-password step, and only there. That step
     * needs it: Cognito's forgot-password flow reports success for an
     * UNCONFIRMED user without ever sending anything, so it otherwise loops
     * forever on "that code expired" with no way out.
     *
     * It used to be offered on the login step too. It is not any more — a
     * user with the right password and an unconfirmed account is recovered
     * automatically by `handleSignIn`, so the link there could only ever fire
     * for someone whose password was wrong, and it answered them with a
     * password error on a screen with no password field.
     *
     * It takes the address explicitly because the remaining caller keeps it in
     * `forgotEmail` while `handleConfirm` reads `email`, so the forgot step's
     * address has to be promoted — which `enterRecoveryConfirm` does.
     */
    const handleNeverReceivedCode = async (targetEmail: string) => {
        setError(null);
        setResendSuccess(false);
        if (!targetEmail.trim()) {
            setError(t('errors.required'));
            return;
        }
        enterRecoveryConfirm(targetEmail, await requestNewCode(targetEmail));
    };

    /** Resend from the confirm step itself. The cooldown lives in `requestNewCode`. */
    const handleResendCode = async () => {
        setError(null);
        setResendSuccess(false);
        // The forgot-password notice describes the send that BROUGHT the user
        // here. Once they ask for another code it is stale, and leaving it up
        // would stack two success banners about two different sends.
        setNotConfirmedNotice(false);
        const outcome = await requestNewCode(email);
        // The cooldown label is already on screen explaining the wait, so a
        // skipped call needs no second message.
        if (outcome.status === 'skipped') return;
        if (outcome.status === 'failed') {
            setError(t(outcome.key));
            // Already-confirmed is the one refusal with nothing left to resend,
            // so it does not hold a button the user should stop using anyway.
            if (outcome.key !== 'errors.already_confirmed') setResendCooldown(RESEND_COOLDOWN_SECONDS);
            return;
        }
        // The old code may still be live, and we cannot promise either way, so
        // clear the box rather than leave a stale value looking authoritative.
        setConfirmationCode('');
        setResendSuccess(true);
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
    };

    const handleCreateAccount = async () => {
        setError(null);
        const allMissing = validateEmployerSignupFields({
            company_name: companyName, contact_name: contactName, email, password, password_confirm: passwordConfirm,
            phone, city, service_area: serviceArea, hiring_trades: hiringTrades, typical_job_types: typicalJobTypes,
        });
        // Invite mode shows only its own fields, so it asks only for those.
        const missing = inviteMode ? allMissing.filter((field) => INVITE_SIGNUP_FIELDS.includes(field)) : allMissing;
        setMissingFields(missing);
        if (missing.length > 0) {
            setError(t('errors.missing_summary', {
                fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
            }));
            return;
        }
        if (password !== passwordConfirm) {
            setError(t('errors.password_mismatch'));
            return;
        }
        setIsLoading(true);
        try {
            if (inviteMode) {
                await employerSignUp({ email, password, companyName: '', contactName, phone }, { invite: true });
            } else {
                await employerSignUp({ email, password, companyName, contactName, phone });
            }
            setConfirmationCode('');
            setConfirmOrigin('signup');
            setRecoveryFromForgot(false);
            setResendSuccess(false);
            // Sign-up itself just sent a code, so it counts as the first send:
            // start the cooldown now rather than letting an immediate resend
            // spend a second attempt against Cognito's hourly cap.
            setResendCooldown(RESEND_COOLDOWN_SECONDS);
            setStep('confirm');
        } catch (err) {
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * Hands the signup form's answers to the next successful sign-in, which is
     * what consumes them. ONLY a signup-origin confirm has a filled-in form
     * behind it.
     *
     * Writing it on a recovery confirm was actively destructive: the patch
     * always carries `hiring_trades` and `typical_job_types` keys, and the API
     * treats a PRESENT key as an intentional value (employer-profile.ts gates
     * those two columns on `hasOwnProperty`, not on emptiness). An employer who
     * signed in unconfirmed would have both arrays emptied and `company_size`
     * reset to the '1-10' default the moment they entered their code — losing
     * real profile data to fix an email problem.
     */
    const savePendingSignupProfile = (forInvite: boolean) => {
        if (confirmOrigin !== 'signup') return;
        sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(pendingProfile(forInvite)));
    };

    /**
     * The invite token this confirm carries to the post-confirmation trigger,
     * or null. Only ever for the invite's own address (I4): invite mode's
     * email is locked, but the forgot-password step can still promote another
     * one onto the confirm step. The plain page forwards a stored token only
     * with the team flag on, and only when the stored email matches.
     */
    const confirmInviteToken = (): string | null => {
        if (invite) return email.trim().toLowerCase() === invite.email.trim().toLowerCase() ? invite.token : null;
        if (!isTeamManagementEnabled()) return null;
        return storedInviteTokenFor(email);
    };

    const handleConfirm = async () => {
        setError(null);
        setResendSuccess(false);
        setIsLoading(true);
        const inviteToken = confirmInviteToken();
        try {
            if (inviteToken) {
                await employerConfirmSignUp(email, confirmationCode, { inviteToken });
            } else {
                await employerConfirmSignUp(email, confirmationCode);
            }
        } catch (err) {
            // `confirmErrorKey`, not `authErrorKey`: a confirm against an
            // ALREADY-CONFIRMED account rejects with `NotAuthorizedException`,
            // which the shared mapper reads as "the email or password is
            // incorrect" — a sentence about a field this step does not have.
            const key = confirmErrorKey(err);
            if (key === 'errors.already_confirmed') {
                // Same reasoning as `enterRecoveryConfirm`: there is no code
                // coming for this account, so the confirm step is a dead end.
                // Login is the screen the sentence describes. `goToStep` clears
                // `error`, so the message is set after it.
                //
                // The answers are persisted first. This refusal means the
                // account IS confirmed — it just was not confirmed by THIS
                // submit (a second tab, or a code entered elsewhere) — so a
                // signup still owes its profile patch to the sign-in that
                // follows. Routing to login without it would strand the form's
                // answers on a step the user can no longer get back to.
                savePendingSignupProfile(inviteToken !== null || inviteMode);
                goToStep('login');
                setResetSuccess(false);
                // From the forgot flow, "confirmed" means the email was never
                // verified: the usual "use Forgot password?" advice is the loop.
                setError(recoveryFromForgot
                    ? t('errors.reset_unavailable', { email: SUPPORT_CONTACT.email })
                    : t(key));
            } else {
                setError(t(key));
            }
            setIsLoading(false);
            return;
        }

        savePendingSignupProfile(inviteToken !== null || inviteMode);
        // The confirm carried the token: post-confirmation has settled the
        // invite, so the stored copy is spent.
        if (inviteToken) clearPendingInvite();

        // The recovery entry points collect an email and nothing else, so there
        // is no password to sign in with. The account IS confirmed now, so send
        // the user to login rather than firing an unauthenticated sign-in that
        // would report "the email or password is incorrect" over a success.
        if (!password) {
            setIsLoading(false);
            goToStep('login');
            setResetSuccess(false);
            setConfirmedSuccess(true);
            return;
        }

        try {
            const tokens = await employerSignIn(email, password);
            if (inviteMode) {
                // Post-confirmation accepted the invite by its token; the
                // invite page does not land sessions, so the form does.
                landInviteSession(tokens);
                return;
            }
            // No navigation here: the auth page lands every fresh session (the
            // dashboard, or `returnUrl`). A push from the form raced it.
            setTokens(tokens, 'employer');
        } catch (err) {
            // The code has been spent, so leaving the user on the confirm step
            // would strand them behind an input that can never succeed again.
            // The confirm itself worked; login is the correct next screen, and
            // it carries the reason the sign-in did not.
            //
            // Both lines are shown together, and the bad-credentials sentence
            // is swapped for one that admits the confirm succeeded: on its own,
            // "the email or password is incorrect" reads as a denial of the
            // confirmation that just went through, and sends the user back to
            // ask for another code they do not need.
            const key = authErrorKey(err);
            goToStep('login');
            setResetSuccess(false);
            setConfirmedSuccess(true);
            setError(t(key === 'errors.invalid_credentials' ? 'errors.confirmed_sign_in_failed' : key));
        } finally {
            setIsLoading(false);
        }
    };

    const handleForgotRequest = async () => {
        setError(null);
        setIsLoading(true);
        try {
            await employerForgotPassword(forgotEmail);
            setStep('forgot_confirm');
        } catch (err) {
            // `forgotErrorKey`, not `authErrorKey`: Cognito refuses a reset for
            // an account with no verified contact with
            // `InvalidParameterException` and a message that mentions
            // `phone_number`, which the shared mapper reads as a bad phone
            // field — "Enter a valid phone number", on a step whose only field
            // is an email address.
            const key = forgotErrorKey(err);
            if (key === 'errors.account_not_confirmed') {
                // A reset is not merely failing here, it is UNREACHABLE: the
                // pool recovers phone-first and an unconfirmed employer has no
                // verified email, so asking again can never work. The recovery
                // that does work is the confirmation code — the same flow
                // `handleSignIn` runs for `UserNotConfirmedException` — so the
                // address is promoted onto the confirm step (`handleConfirm`
                // reads `email`, not `forgotEmail`) and the code is on its way
                // before the user sees the step.
                enterRecoveryConfirm(forgotEmail, await requestNewCode(forgotEmail), 'not_confirmed', 'forgot');
                return;
            }
            setError(t(key));
        } finally {
            setIsLoading(false);
        }
    };

    const handleForgotConfirm = async () => {
        setError(null);
        if (newPassword !== newPasswordConfirm) {
            setError(t('errors.password_mismatch'));
            return;
        }
        setIsLoading(true);
        try {
            await employerConfirmNewPassword(forgotEmail, resetCode, newPassword);
            setResetSuccess(true);
            setStep('login');
        } catch (err) {
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    /**
     * `onSubmit` for one step. Every step is a real `<form>` now, so Enter
     * works on all five — before this, the whole file had no `<form>` element
     * and the keystroke every user tries first on a login screen did nothing.
     *
     * The guard is the point. It repeats the primary button's own `disabled`
     * expression rather than trusting the browser to refuse implicit
     * submission behind a disabled default button: `isLoading` is folded in
     * here too, so a second Enter during a slow Cognito call cannot fire a
     * second request (the resend and confirm paths spend attempts against
     * per-hour caps, so a double submit is not merely wasteful).
     */
    const submitStep = (handler: () => void, disabled = false) =>
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (disabled || isLoading) return;
            handler();
        };

    const toggleTrade = (trade: EmployerTrade) => {
        setHiringTrades((current) => current.includes(trade) ? current.filter((item) => item !== trade) : [...current, trade]);
    };
    const toggleJobType = (jobType: EmployerJobType) => {
        setTypicalJobTypes((current) => current.includes(jobType) ? current.filter((item) => item !== jobType) : [...current, jobType]);
    };

    /**
     * Leaving a step drops that step's transient feedback. Without this, the
     * red "this field is required" marks from an abandoned signup attempt are
     * still lit when the user comes back to it, describing a submit that no
     * longer happened. Purely display state — nothing here touches Cognito.
     */
    const goToStep = (next: Step) => {
        setError(null);
        setMissingFields([]);
        // Same reasoning as the field marks: the "we sent a new code" line and
        // the "your account is confirmed" line each describe one step's last
        // action. Callers that want them set them again after this returns.
        setResendSuccess(false);
        setConfirmedSuccess(false);
        setNotConfirmedNotice(false);
        setStep(next);
    };

    // A recovery confirm is not a signup, so it must not be greeted with
    // "Create your employer account" — this user already has an account and is
    // trying to get back into it.
    const isRecoveryConfirm = step === 'confirm' && confirmOrigin === 'signin';
    // Invite mode names the company on the two steps a person arrives on.
    const inviteIntro = invite && (step === 'login' || step === 'signup');
    const inviteCopy = invite ? { companyName: invite.companyName, email: invite.email } : null;
    const heading =
        inviteIntro && inviteCopy ? t('invite.title', { companyName: inviteCopy.companyName })
        : step === 'login' ? t('hero')
            : step === 'forgot_request' ? t('forgot_title')
                : step === 'forgot_confirm' ? t('forgot_confirm_title')
                    : isRecoveryConfirm ? t('recovery_title')
                        : t('signup_title');
    // The forgot steps carry their instruction inline, next to the field it is
    // about, so they deliberately have no subtitle here. Rendering an empty <p>
    // for them (the old shape) left a paragraph that existed only as a margin.
    const subheading =
        inviteIntro && inviteCopy ? t(step === 'login' ? 'invite.rejoin_body' : 'invite.body', inviteCopy)
        : step === 'login' ? t('title')
            : step === 'forgot_request' || step === 'forgot_confirm' ? ''
                : isRecoveryConfirm ? t('recovery_subtitle')
                    // The signup's own code step: the code has arrived, so the
                    // "we'll email you a code" line no longer fits.
                    : step === 'confirm' ? t('signup_confirm_subtitle')
                        : t('signup_subtitle');

    return (
        <div className="flex w-full flex-col">
                {/* `key={step}` remounts the header so `.anim-fade-in` replays
                    with the step body underneath it — the title and the fields
                    it introduces arrive together instead of the title snapping
                    while the body fades. */}
                <div key={step} className="anim-fade-in mb-8 flex flex-col gap-2">
                    <h1 className="text-[clamp(1.6rem,3vw,1.9rem)] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
                        {heading}
                    </h1>
                    {subheading ? (
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{subheading}</p>
                    ) : null}
                </div>

                {/* `noValidate` on every step, deliberately. These steps do their
                    own validation and render it inline (per-field marks plus a
                    summary banner), and until now no `<form>` existed at all, so
                    no constraint validation ever ran. Leaving it on would add a
                    SECOND, competing mechanism: a browser bubble on the first
                    `type="email"` field, which also silently swallows the submit
                    before the form's own guards and Cognito's own error copy get
                    a turn. The change here is "Enter submits", nothing else. */}
                {step === 'login' && (
                    <form onSubmit={submitStep(handleSignIn)} noValidate className="anim-fade-in flex flex-col gap-4">
                        <Field label={t('fields.email')}>
                            {/* Invite mode: the invite's address, locked. */}
                            <Input autoFocus={!inviteMode} readOnly={inviteMode} type="email" placeholder={t('email_label')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                        </Field>
                        <Field label={t('fields.password')}>
                            <PasswordInput
                                autoFocus={inviteMode}
                                placeholder={t('password_label')}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                                visible={showPassword}
                                onToggle={() => setShowPassword((value) => !value)}
                                showLabel={t('show_password')}
                                hideLabel={t('hide_password')}
                            />
                        </Field>
                        {/* One link here, not two. An "I never received my confirmation
                            code" link used to sit beneath the forgot-password one and
                            was REMOVED: it emailed a SIGN-UP code, so entering that
                            code called ConfirmSignUp on an account that was usually
                            already confirmed, and Cognito's NotAuthorizedException came
                            back as "the email or password is incorrect" — on a step
                            with no password field. A real employer read that as a
                            reason to request yet another code and looped three times.

                            Nothing is lost by dropping it: the only person it could
                            help from THIS step has the right password and an
                            unconfirmed account, and `handleSignIn` already recovers
                            that case on its own via `UserNotConfirmedException`. So
                            the link could only ever fire for someone whose password
                            was wrong — the exact case it answered incoherently.

                            The `forgot_request` step keeps it; that step is a genuine
                            dead end, and the comment there says why. */}
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => { setResetSuccess(false); setForgotEmail(email); goToStep('forgot_request'); }}
                                className={`text-xs ${LINK_BUTTON}`}
                            >
                                {t('forgot_link')}
                            </button>
                        </div>
                        {error && <FormError>{error}</FormError>}
                        {resetSuccess && (
                            <InlineFeedback tone="success">{t('reset_success')}</InlineFeedback>
                        )}
                        {confirmedSuccess && (
                            <InlineFeedback tone="success">{t('confirmed_sign_in')}</InlineFeedback>
                        )}
                        <Button type="submit" className="w-full mt-1" size="lg" loading={isLoading} loadingLabel={tCommon('loading')}>
                            {inviteMode ? t('invite.rejoin_submit') : t('sign_in')}
                        </Button>
                        {/* An existing account has nothing to sign up for. */}
                        {invite?.existingAccount ? null : (
                            <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setResetSuccess(false); goToStep('signup'); }} />
                        )}
                    </form>
                )}

                {step === 'signup' && (
                    <form onSubmit={submitStep(handleCreateAccount)} noValidate className="anim-fade-in flex flex-col gap-4">
                        {/* Invite mode: no company fields (this one or the ones
                            after the phone). A foreman joins the inviting company. */}
                        {inviteMode ? null : (
                            <Field label={t('fields.company_name')} error={missingFields.includes('company_name') ? t('errors.required') : undefined}>
                                <Input autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                            </Field>
                        )}
                        <Field label={t('fields.contact_name')} error={missingFields.includes('contact_name') ? t('errors.required') : undefined}>
                            <Input autoFocus={inviteMode} value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
                        </Field>
                        <Field label={t('fields.email')} error={missingFields.includes('email') ? t('errors.required') : undefined}>
                            <Input type="email" readOnly={inviteMode} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                        </Field>
                        <Field label={t('fields.password_create')} error={missingFields.includes('password') ? t('errors.required') : undefined}>
                            <PasswordInput
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="new-password"
                                visible={showPassword}
                                onToggle={() => setShowPassword((value) => !value)}
                                showLabel={t('show_password')}
                                hideLabel={t('hide_password')}
                            />
                        </Field>
                        <Field label={t('fields.password_confirm')} error={missingFields.includes('password_confirm') ? t('errors.required') : undefined}>
                            <PasswordInput
                                value={passwordConfirm}
                                onChange={(e) => setPasswordConfirm(e.target.value)}
                                autoComplete="new-password"
                                visible={showPasswordConfirm}
                                onToggle={() => setShowPasswordConfirm((value) => !value)}
                                showLabel={t('show_password')}
                                hideLabel={t('hide_password')}
                            />
                        </Field>
                        <p className="text-xs leading-relaxed text-[var(--jale-ink-2)]">{t('password_note')}</p>
                        <Field label={t('fields.phone')} error={missingFields.includes('phone') ? t('errors.required') : undefined}>
                            <PhoneNumberField
                                countryCode={phoneCountryCode}
                                localNumber={phoneLocalNumber}
                                onCountryCodeChange={setPhoneCountryCode}
                                onLocalNumberChange={setPhoneLocalNumber}
                            />
                        </Field>
                        {inviteMode ? null : (
                            <>
                                <Field label={t('fields.city')} error={missingFields.includes('city') ? t('errors.required') : undefined}>
                                    {/* Enter inside the city combobox picks a suggestion; it
                                        must never submit the account. `LocationPicker` only
                                        calls `preventDefault` when one of its options is
                                        actually highlighted, so a user who types a city and
                                        presses Enter to "accept" it would otherwise create
                                        the account from a half-typed address. The field lives
                                        in another lane's file, so the guard sits here — on
                                        the wrapper, after the picker's own handler has had
                                        its turn. */}
                                    <div onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}>
                                        <LocationPicker value={city} onChange={(v) => setCity(v.label)} />
                                    </div>
                                </Field>
                                <Field label={t('fields.service_area')} error={missingFields.includes('service_area') ? t('errors.required') : undefined}>
                                    <Input value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} />
                                </Field>
                                <CheckboxGroup label={t('fields.hiring_trades')} error={missingFields.includes('hiring_trades') ? t('errors.required') : undefined}>
                                    {TRADES.map((trade) => <CheckboxCard key={trade} checked={hiringTrades.includes(trade)} label={t(`trades.${trade}`)} onChange={() => toggleTrade(trade)} />)}
                                </CheckboxGroup>
                                <CheckboxGroup label={t('fields.typical_job_types')} error={missingFields.includes('typical_job_types') ? t('errors.required') : undefined}>
                                    {JOB_TYPES.map((jobType) => <CheckboxCard key={jobType} checked={typicalJobTypes.includes(jobType)} label={t(`job_types.${jobType.replace('-', '_')}`)} onChange={() => toggleJobType(jobType)} />)}
                                </CheckboxGroup>
                                <Field label={t('fields.company_size')}>
                                    <Select value={companySize} onChange={(e) => setCompanySize(e.target.value as CompanySize)}>
                                        {COMPANY_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                                    </Select>
                                </Field>
                                <Field label={t('fields.company_description')}>
                                    <Textarea rows={3} value={companyDescription} onChange={(e) => setCompanyDescription(e.target.value)} />
                                </Field>
                            </>
                        )}
                        {error && <FormError>{error}</FormError>}
                        <Button type="submit" className="w-full mt-1" size="lg" loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('create_account')}
                        </Button>
                        <SwitchPrompt text={t('signin_prompt')} action={t('signin_link')} onClick={() => goToStep('login')} />
                    </form>
                )}

                {step === 'confirm' && (
                    <form
                        onSubmit={submitStep(handleConfirm, confirmationCode.length < 4 || isResending)}
                        noValidate
                        className="anim-fade-in flex flex-col gap-4"
                    >
                        {/* Back has to follow the origin. Hardcoding 'signup' sent a
                            recovering employer into an empty signup form, which is
                            the one place they must not end up: submitting it hits
                            "an account already exists for this email". */}
                        <BackButton label={t('back')} onClick={() => goToStep(confirmOrigin === 'signin' ? 'login' : 'signup')} />
                        {/* Normalised the same way the Cognito calls normalise it, so a
                            typo'd address is visible here — before the user burns resend
                            attempts on an inbox that will never receive anything. */}
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{t('confirm_subtitle', { email: email.trim().toLowerCase() })}</p>
                        <Field label={t('fields.confirmation_code')}><Input autoFocus value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field>
                        <p className="text-xs leading-relaxed text-[var(--jale-ink-2)]">{t('check_spam')}</p>
                        <div className="flex justify-end">
                            {/* On cooldown this is plain text, not a disabled button:
                                a disabled link-styled button still answers hover and
                                reads as clickable. */}
                            {resendCooldown > 0 ? (
                                <span className="text-xs text-[var(--jale-ink-2)]">{t('resend_cooldown', { seconds: resendCooldown })}</span>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleResendCode}
                                    disabled={isResending}
                                    className={`text-xs ${LINK_BUTTON}`}
                                >
                                    {t('resend_code')}
                                </button>
                            )}
                        </div>
                        {resendSuccess && (
                            // Normalised the same way the resend normalised it, so the
                            // banner shows the address the code actually went to
                            // rather than the casing the user happened to type.
                            <InlineFeedback tone="success">{t('code_sent', { email: email.trim().toLowerCase() })}</InlineFeedback>
                        )}
                        {notConfirmedNotice && (
                            // `info`, not `success`: nothing the user asked for
                            // succeeded. They asked to reset a password and are
                            // being told why they are looking at a confirmation
                            // code instead.
                            <InlineFeedback tone="info">{t('forgot_not_confirmed', { email: email.trim().toLowerCase() })}</InlineFeedback>
                        )}
                        {error && <FormError>{error}</FormError>}
                        {/* A resend in flight may be about to invalidate the code in the
                            box — hold Confirm until we know which code is current. */}
                        <Button type="submit" className="w-full mt-1" size="lg" disabled={confirmationCode.length < 4 || isResending} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('confirm_account')}
                        </Button>
                    </form>
                )}

                {step === 'forgot_request' && (
                    <form
                        onSubmit={submitStep(handleForgotRequest, !forgotEmail.trim())}
                        noValidate
                        className="anim-fade-in flex flex-col gap-4"
                    >
                        <BackButton label={t('back')} onClick={() => goToStep('login')} />
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{t('forgot_subtitle')}</p>
                        <Field label={t('fields.email')}>
                            <Input
                                autoFocus
                                type="email"
                                value={forgotEmail}
                                onChange={(e) => setForgotEmail(e.target.value)}
                                autoComplete="email"
                            />
                        </Field>
                        {/* Mirrored here on purpose. Cognito's forgot-password call
                            reports success for an UNCONFIRMED user without sending
                            anything, so this step is a dead end for exactly the
                            people who need recovery — they get "that code expired"
                            forever. This link is the only real way out of it. */}
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => handleNeverReceivedCode(forgotEmail)}
                                disabled={isResending}
                                className={`text-right text-xs ${LINK_BUTTON}`}
                            >
                                {t('never_received_code')}
                            </button>
                        </div>
                        {error && <FormError>{error}</FormError>}
                        <Button type="submit" className="w-full mt-1" size="lg" disabled={!forgotEmail.trim()} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('send_code')}
                        </Button>
                    </form>
                )}

                {step === 'forgot_confirm' && (
                    <form
                        onSubmit={submitStep(
                            handleForgotConfirm,
                            !resetCode.trim() || !newPassword || !newPasswordConfirm,
                        )}
                        noValidate
                        className="anim-fade-in flex flex-col gap-4"
                    >
                        <BackButton
                            label={t('back')}
                            onClick={() => { setResetCode(''); setNewPassword(''); setNewPasswordConfirm(''); goToStep('forgot_request'); }}
                        />
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">
                            {t('forgot_confirm_subtitle', { email: forgotEmail })}
                        </p>
                        <Field label={t('fields.reset_code')}>
                            <Input
                                autoFocus
                                value={resetCode}
                                onChange={(e) => setResetCode(e.target.value)}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                            />
                        </Field>
                        <Field label={t('fields.new_password')}>
                            <PasswordInput
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                autoComplete="new-password"
                                visible={showNewPassword}
                                onToggle={() => setShowNewPassword((v) => !v)}
                                showLabel={t('show_password')}
                                hideLabel={t('hide_password')}
                            />
                        </Field>
                        <Field label={t('fields.password_confirm')}>
                            <PasswordInput
                                value={newPasswordConfirm}
                                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                                autoComplete="new-password"
                                visible={showNewPasswordConfirm}
                                onToggle={() => setShowNewPasswordConfirm((v) => !v)}
                                showLabel={t('show_password')}
                                hideLabel={t('hide_password')}
                            />
                        </Field>
                        {error && <FormError>{error}</FormError>}
                        <Button
                            type="submit"
                            className="w-full mt-1"
                            size="lg"
                            disabled={!resetCode.trim() || !newPassword || !newPasswordConfirm}
                            loading={isLoading}
                            loadingLabel={tCommon('loading')}
                        >
                            {t('set_password')}
                        </Button>
                    </form>
                )}
        </div>
    );
}

/**
 * Employer proof panel — rendered in the AuthShell navy brand slot (lg+ only).
 *
 * This is BRAND SURFACE, so it follows AuthShell's rule rather than the token
 * rule: it sits on the fixed navy ground that renders identically in light and
 * dark, so its own colours are fixed too. Tokenising them would look identical
 * today and re-tint the brand the day the blue ramp gains a `.dark` override —
 * on a panel whose whole job is to be the same mark for every visitor.
 *
 * Contrast against #181855: white 17.8:1, white/90 ~14:1, white/70 ~8.4:1 —
 * AA or better at every size here, in both themes, because the ground is fixed.
 */
export function EmployerBrandPanel() {
    const t = useTranslations('auth.employer');
    const bullets = [
        t('panel_bullet_1'),
        t('panel_bullet_2'),
        t('panel_bullet_3'),
        t('panel_bullet_4'),
        t('panel_bullet_5'),
    ];
    return (
        <div className="max-w-sm text-white">
            <div className="font-extrabold leading-tight" style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', letterSpacing: '-0.03em' }}>
                {t('panel_title')}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/70">{t('panel_body')}</p>
            <ul className="mt-6 flex flex-col gap-3">
                {bullets.map((bullet) => (
                    <li key={bullet} className="flex items-center gap-3 text-sm text-white/90">
                        <span
                            aria-hidden
                            /* Brand-surface literals, per the note above. */
                            className="flex h-6 w-6 flex-none items-center justify-center rounded-full"
                            style={{ background: 'rgba(1,121,255,.2)', color: '#5ea8ff' }}
                        >
                            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                                <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </span>
                        {bullet}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/**
 * Field-level validation stays where it belongs — under its own field — so the
 * user can see WHICH input is unhappy. The banner above the submit button says
 * how many; this says which.
 *
 * `--jale-danger-text`, not `--jale-danger`: the base danger token is tuned for
 * a white ground and only reaches ~4.1:1 on `--jale-card` (#ebebeb), which
 * fails AA at this 12px size. The -text pair is the one that holds (~6.3:1
 * light, ~8.2:1 dark). No `role="alert"` here on purpose — a failed submit can
 * light ten of these at once, and the summary banner already announces.
 */
function FieldError({ children }: { children: ReactNode }) {
    return <p className="text-xs font-medium text-[var(--jale-danger-text)]">{children}</p>;
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</label>
            {children}
            {error && <FieldError>{error}</FieldError>}
        </div>
    );
}

function CheckboxGroup({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
            {error && <FieldError>{error}</FieldError>}
        </div>
    );
}

/**
 * Form-level failures: the Cognito outcome (already a translated sentence via
 * `authErrorKey`) and the missing-field summary. `InlineFeedback` gives them
 * the tinted danger surface and `role="alert"`.
 */
function FormError({ children }: { children: ReactNode }) {
    return <InlineFeedback tone="danger">{children}</InlineFeedback>;
}

/**
 * `--jale-blue-700`, not `-600`: only 700 flips in the dark theme. Blue-600
 * stays #0064d6 under `.dark` and lands at ~2.98:1 on the dark card — below AA.
 * Same reasoning as the `.stat-icon` note in globals.css.
 */
const LINK_BUTTON =
    'cursor-pointer rounded border-0 bg-transparent p-0 font-semibold text-[var(--jale-blue-700)] ' +
    'underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex cursor-pointer items-center gap-1 self-start rounded border-0 bg-transparent p-0 text-sm font-medium text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
            <span aria-hidden="true">&larr;</span> {label}
        </button>
    );
}

function PasswordInput({
    visible,
    onToggle,
    showLabel,
    hideLabel,
    className = '',
    ...props
}: InputHTMLAttributes<HTMLInputElement> & {
    visible: boolean;
    onToggle: () => void;
    showLabel: string;
    hideLabel: string;
}) {
    return (
        <div className="relative">
            <Input
                {...props}
                type={visible ? 'text' : 'password'}
                className={`pr-12 ${className}`}
            />
            {/* The `after:` overlay grows the POINTER target to the 44px
                minimum without changing the 32px box's layout — same trick as
                `ui/theme-toggle`. Focus uses the app-wide `--shadow-focus`
                recipe instead of a bespoke ring. */}
            <button
                type="button"
                onClick={onToggle}
                aria-label={visible ? hideLabel : showLabel}
                title={visible ? hideLabel : showLabel}
                className={[
                    'absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center',
                    'cursor-pointer rounded-md text-[var(--jale-ink-2)] transition-colors',
                    'hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)]',
                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                    "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                ].join(' ')}
            >
                {visible ? <EyeOffIcon /> : <EyeIcon />}
            </button>
        </div>
    );
}

function EyeIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
            <circle cx="12" cy="12" r="2.7" />
        </svg>
    );
}

function EyeOffIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l18 18" />
            <path d="M10.6 10.6a2.7 2.7 0 0 0 3.8 3.8" />
            <path d="M7.4 7.7C4.5 9.4 2.5 12 2.5 12s3.5 6 9.5 6c1.7 0 3.2-.5 4.5-1.2" />
            <path d="M13.8 6.2C18.7 7.1 21.5 12 21.5 12s-.9 1.5-2.4 3" />
        </svg>
    );
}

function SwitchPrompt({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
    return (
        <p className="text-center text-sm text-[var(--jale-ink-2)]">
            {text}{' '}
            <button type="button" onClick={onClick} className={`text-[length:inherit] ${LINK_BUTTON}`}>
                {action}
            </button>
        </p>
    );
}
