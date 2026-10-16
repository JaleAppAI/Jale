'use client';
import { useState, useRef, useEffect, useId, type FormEvent, type MutableRefObject, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerSignUp, workerVerifyOtp } from '@/lib/cognito';
import { authErrorKey } from '@/lib/auth-errors';
import { captureSignupSource, clearSignupSource, signupSourceBody } from '@/lib/signup-source';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { claimReferral, getWorkerOnboarding } from '@/lib/api/worker';
import { assignReturnPath, sanitizeReturnPath } from '@/lib/login-url';
import { normalizeShareCode } from '@/lib/share-code';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PhoneNumberField } from '@/components/auth/PhoneNumberField';
import {
    CLAIM_WAIT_MS,
    stashPendingReferral,
    readPendingReferral,
    clearPendingReferral,
    validateJobId,
    jobIdFromReturnPath,
    settleWithin,
    markAuthFlowCompleting,
    clearAuthFlowCompleting,
    type PendingReferral,
} from '@/lib/referral-return';

const OTP_LENGTH = 6;
const RESEND_CODE_COOLDOWN_SECONDS = 60;

/**
 * The sign-in answer the "create my account with this number" nudge follows.
 * Cognito gives it for an unknown number AND for a known one alike, so the
 * nudge reveals nothing about whether a number has an account.
 */
const UNRECOGNISED_NUMBER = 'errors.invalid_credentials';

type Step = 'login' | 'signup' | 'otp';

/** Where the job a sign-in is about came from. */
type ReferralSource = 'visit' | 'returnUrl' | 'stash';

const hasReferral = (referral: PendingReferral | null): referral is PendingReferral =>
    referral !== null && (referral.jobId !== null || referral.shareCode !== null);

/**
 * The referrals a sign-in records, in the order it sends them, and the one it
 * is about.
 *
 * The job opened last wins: this visit's own link, else the job page a login
 * bounce came from, else what an earlier visit in this tab left in the stash.
 * The server shows the NEWEST unapplied referred job on the onboarding strip
 * and the summary, so the job in context is always claimed last. A leftover
 * referral for anything else is claimed too -- first, and on its own -- so its
 * referrer keeps the credit and its job stays pinned. Never in one claim with
 * the job in context: the server records a claim's job before the job its
 * share code names, which would make the leftover job the newest.
 *
 * A visit with its own link left nothing behind to keep: the mount replaced
 * the stash with that link.
 */
function signInReferrals(
    visit: PendingReferral,
    returnJobId: string | null,
    stash: PendingReferral | null,
): { claims: PendingReferral[]; current: PendingReferral | null; source: ReferralSource | null } {
    if (hasReferral(visit)) return { claims: [visit], current: visit, source: 'visit' };
    const leftover = hasReferral(stash) ? stash : null;
    if (returnJobId) {
        if (leftover?.jobId === returnJobId) {
            const current = { jobId: returnJobId, shareCode: leftover.shareCode };
            return { claims: [current], current, source: 'returnUrl' };
        }
        const current = { jobId: returnJobId, shareCode: null };
        return { claims: leftover ? [leftover, current] : [current], current, source: 'returnUrl' };
    }
    return leftover ? { claims: [leftover], current: leftover, source: 'stash' } : { claims: [], current: null, source: null };
}

export default function WorkerAuthForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const t = useTranslations('auth.worker');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    // Referred-stranger web-apply carry-through: stash job/share as soon as
    // they show up on the URL so they survive the multi-step OTP flow
    // (including a page reload mid-flow).
    //
    // A visit WITHOUT them never clears the stash. Those visits are exactly
    // what it exists for -- a `?returnUrl=` login bounce, a reload of the bare
    // page -- and the server holds the job now anyway, so the stash is only a
    // fallback that a finished sign-in or the summary screen clears. Malformed
    // values count as absent, so a broken link cannot overwrite a good stash.
    useEffect(() => {
        const jobId = validateJobId(searchParams.get('job'));
        const shareCode = normalizeShareCode(searchParams.get('share'));
        if (jobId || shareCode) stashPendingReferral({ jobId, shareCode });
        // Where this visitor came from (analytics #16, K3.6), first touch
        // only. `step=signup` is the /app link's door (see `step` below).
        captureSignupSource({
            src: searchParams.get('src'),
            entry: searchParams.get('step') === 'signup' ? 'app' : 'signup_page',
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // `?step=signup` -- the `jaleapp.ai/app` link -- opens on sign-up: someone
    // who tapped "get the app" is new by definition. Anything else, including
    // `?step=otp` (there is no code to enter yet), opens on sign-in.
    const [step, setStep] = useState<Step>(() => (searchParams.get('step') === 'signup' ? 'signup' : 'login'));
    // Which door this OTP screen was reached through. `step` cannot answer it
    // -- both doors set it to 'otp' -- and the two want different fallbacks
    // once the code is accepted (see `handleVerifyOtp`).
    const [isSignup, setIsSignup] = useState(false);
    const [phoneCountryCode, setPhoneCountryCode] = useState<PhoneCountryCode>('+1');
    const [phoneLocalNumber, setPhoneLocalNumber] = useState('');
    const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
    const [user, setUser] = useState<CognitoUser | null>(null);
    // The KEY, not the sentence: the nudge below has to know which error it
    // is looking at, and a translated string is no way to ask.
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const error = errorKey ? t(errorKey) : null;
    const [isLoading, setIsLoading] = useState(false);
    const [isResendingCode, setIsResendingCode] = useState(false);
    const [resendSuccess, setResendSuccess] = useState(false);
    const [resendCooldownSeconds, setResendCooldownSeconds] = useState(0);
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
    // Whichever phone step is mounted — only ever one at a time.
    const phoneFormRef = useRef<HTMLFormElement | null>(null);

    const resetDigits = () => setDigits(Array(OTP_LENGTH).fill(''));
    const code = digits.join('');
    const phone = formatPhoneNumber(phoneCountryCode, phoneLocalNumber);
    const phoneReady = phoneLocalNumber.replace(/\D/g, '').length >= 7;

    useEffect(() => {
        if (resendCooldownSeconds <= 0) return;
        const timeoutId = window.setTimeout(() => {
            setResendCooldownSeconds((seconds) => Math.max(0, seconds - 1));
        }, 1000);
        return () => window.clearTimeout(timeoutId);
    }, [resendCooldownSeconds]);

    /**
     * Opens each phone step with the number field focused, the way the OTP step
     * does it with `autoFocus` on its first box.
     *
     * It is done from here rather than with an `autoFocus` prop because the
     * input lives inside `PhoneNumberField`, which takes no such prop and
     * belongs to another lane's file. An effect keyed on `step` — never a timer
     * — so the focus is in place before the step is interactive and can never
     * land in the middle of someone's typing. (A deferred
     * `setTimeout(..., 50)` used to do the OTP focus, and it was exactly that
     * bug: the timer could fire between two keystrokes and drag the cursor back
     * to the first box, dropping a digit.)
     */
    useEffect(() => {
        if (step !== 'login' && step !== 'signup') return;
        phoneFormRef.current?.querySelector<HTMLInputElement>('input[type="tel"]')?.focus();
    }, [step]);

    const handleSendOtp = async () => {
        setErrorKey(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            setUser(await workerSignIn(phone));
            resetDigits();
            setResendCooldownSeconds(RESEND_CODE_COOLDOWN_SECONDS);
            setIsSignup(false);
            setStep('otp');
            // No deferred focus call: the OTP step mounts fresh and its first
            // box carries `autoFocus`, which React applies on mount. The old
            // `setTimeout(..., 50)` here could fire mid-keystroke and yank the
            // cursor back to box one, losing a digit.
        } catch (err) {
            setErrorKey(authErrorKey(err));
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateAccount = async () => {
        setErrorKey(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            await workerSignUp({ phone, signupSource: signupSourceBody() });
            // Sent once: the server keeps the first one per user.
            clearSignupSource();
            setUser(await workerSignIn(phone));
            resetDigits();
            setResendCooldownSeconds(RESEND_CODE_COOLDOWN_SECONDS);
            setIsSignup(true);
            setStep('otp');
            // Same as `handleSendOtp`: the step's own `autoFocus` does this.
        } catch (err) {
            setErrorKey(authErrorKey(err));
        } finally {
            setIsLoading(false);
        }
    };

    const handleResendOtp = async () => {
        if (resendCooldownSeconds > 0) return;
        setErrorKey(null);
        setResendSuccess(false);
        setIsResendingCode(true);
        try {
            setUser(await workerSignIn(phone));
            resetDigits();
            setResendSuccess(true);
            setResendCooldownSeconds(RESEND_CODE_COOLDOWN_SECONDS);
            // The step is already mounted, so `autoFocus` cannot help here and
            // the boxes were just cleared — focus the first one directly. Still
            // no timer: the boxes are the same DOM nodes across this re-render.
            inputRefs.current[0]?.focus();
        } catch (err) {
            setErrorKey(authErrorKey(err));
        } finally {
            setIsResendingCode(false);
        }
    };

    const handleVerifyOtp = async () => {
        if (!user) return;
        setErrorKey(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            const tokens = await workerVerifyOtp(user, code);

            // The job this sign-in is about, decided ONCE so the claims and the
            // redirect below cannot disagree (see `signInReferrals`). This
            // visit's own link is read from the address itself, so a stash the
            // browser refused to write loses nothing. A `returnUrl` of
            // `/{locale}/worker/jobs/<uuid>` is that job just as surely as a
            // `?job=` is.
            const returnPath = sanitizeReturnPath(searchParams.get('returnUrl'));
            const stash = readPendingReferral();
            const { claims, current, source } = signInReferrals(
                {
                    jobId: validateJobId(searchParams.get('job')),
                    shareCode: normalizeShareCode(searchParams.get('share')),
                },
                jobIdFromReturnPath(returnPath),
                stash ? { jobId: validateJobId(stash.jobId), shareCode: normalizeShareCode(stash.shareCode) } : null,
            );
            const jobId = current?.jobId ?? null;
            // The summary screen's way back to the job should no claim land:
            // it must name the job in context, not a leftover.
            if (current && source === 'returnUrl') stashPendingReferral(current);

            // Record them server-side NOW, while this form is still mounted:
            // `setTokens` below makes the auth page swap it for a skeleton, and
            // nothing after that can show anything. One after the other, so
            // the job in context is recorded last; a failed claim does not
            // stop the next. The wait is bounded and the outcome ignored -- a
            // claim never blocks or redirects a sign-in -- and nothing is
            // cancelled when the wait ends: a slow claim still lands, the ones
            // after it follow, and onboarding reads the job back on a later
            // response. No retry here either: `apiFetch` already retries the
            // `user_not_provisioned` 409 a brand-new account can hit.
            if (claims.length > 0) {
                await settleWithin(async () => {
                    for (const claim of claims) {
                        await claimReferral(tokens.idToken, claim).catch(() => undefined);
                    }
                }, CLAIM_WAIT_MS);
            }

            // Claim single ownership of this authenticated transition BEFORE
            // setTokens flips isAuthenticated -- otherwise auth/worker/page's
            // own already-authenticated effect fires on the same tick and
            // both sides race on the redirect. Released in `finally`, so
            // nothing below can leave it set: it lives in sessionStorage, and
            // a stuck flag would make that page stand down on every later
            // visit in this tab.
            markAuthFlowCompleting();
            try {
                setTokens(tokens, 'worker');

                // Signup and login take the SAME next hop now, and the run
                // itself decides it: anyone the engine still considers
                // `onboarding` -- a fresh signup, or a returning worker who
                // abandoned the flow half-way (on either door) -- goes to
                // /worker/onboarding.
                //
                // The referral stash is deliberately LEFT in place on that
                // path: if the claims above never landed, it is the summary
                // screen's only way back to the job.
                //
                // A read that fails (offline, or the endpoint down) must never
                // strand a worker who has just proved their phone number, so
                // it falls back to the destination this form used before.
                let lifecycle: string | null = null;
                try {
                    lifecycle = (await getWorkerOnboarding(tokens.idToken)).lifecycle;
                } catch {
                    lifecycle = null;
                }

                // A read that failed tells us nothing, so the two doors part
                // ways here. After a SIGNUP there is no profile worth showing
                // and the run is certainly unfinished, so send them to the flow
                // and let it do the error handling it already has (retry, and a
                // way out). After a LOGIN the finished-worker destination is
                // still the better guess: most workers signing in are done
                // onboarding, and dropping them into a flow they completed
                // months ago would be worse than the app they came back to use.
                //
                // That destination is, in order -- the same order the
                // already-signed-in branch of auth/worker/page.tsx follows:
                //   1. the job in context: a worker who arrived about one
                //      specific job goes to that job -- at the returnUrl
                //      itself when that is where the job came from;
                //   2. a safe `returnUrl`: where the sign-in bounce came from.
                //      Already locale-prefixed, so it is ASSIGNED -- the
                //      next-intl router would add a second locale on top;
                //   3. /worker/home, NOT the profile page. A returning worker
                //      signs in to find out whether anything happened, and the
                //      home feed is the only screen that answers: it carries
                //      the hire celebration and the details-requested notice.
                const unread = lifecycle === null;
                if ((lifecycle && lifecycle !== 'ready') || (unread && isSignup)) {
                    router.replace('/worker/onboarding');
                } else {
                    if (jobId && source !== 'returnUrl') router.push(`/worker/jobs/${jobId}`);
                    else if (returnPath) assignReturnPath(returnPath);
                    else router.push('/worker/home');
                    clearPendingReferral();
                }
            } finally {
                clearAuthFlowCompleting();
            }
        } catch (err) {
            setErrorKey(authErrorKey(err));
        } finally {
            setIsLoading(false);
        }
    };

    const handleDigitChange = (index: number, value: string) => {
        const numeric = value.replace(/\D/g, '').slice(0, OTP_LENGTH);
        if (numeric.length > 1) {
            const next = Array(OTP_LENGTH).fill('');
            numeric.split('').forEach((digit, digitIndex) => { next[digitIndex] = digit; });
            setDigits(next);
            setResendSuccess(false);
            inputRefs.current[Math.min(numeric.length, OTP_LENGTH) - 1]?.focus();
            return;
        }
        if (!/^\d?$/.test(value)) return;
        const next = [...digits];
        next[index] = numeric;
        setDigits(next);
        setResendSuccess(false);
        if (numeric && index < OTP_LENGTH - 1) inputRefs.current[index + 1]?.focus();
    };

    const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && !digits[index] && index > 0) inputRefs.current[index - 1]?.focus();
    };

    const handleDigitPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
        if (!pasted) return;
        e.preventDefault();
        const next = Array(OTP_LENGTH).fill('');
        pasted.split('').forEach((d, i) => { next[i] = d; });
        setDigits(next);
        setResendSuccess(false);
        inputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
    };

    const otpComplete = digits.every(Boolean);

    /**
     * `onSubmit` for one step, so Enter works on all three — this form had no
     * `<form>` element at all, so the keystroke did nothing, including on the
     * OTP screen where typing the sixth digit and pressing Enter is the whole
     * interaction.
     *
     * The guard repeats the primary button's `disabled` expression instead of
     * relying on the browser refusing implicit submission behind a disabled
     * default button. It is not belt-and-braces: `workerSignIn` sends an SMS
     * and a verify spends an attempt, so a submit that skipped `phoneReady` or
     * `otpComplete` would cost the worker a real message or a real attempt.
     */
    const submitStep = (handler: () => void, disabled = false) =>
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (disabled || isLoading) return;
            handler();
        };

    return (
        <div className="flex w-full flex-col">
            {/* Each step is its own subtree, so switching steps mounts a fresh
                node and `.anim-fade-in` replays for the ENTERING step only. The
                keyframe moves opacity and a 4px transform — neither is a
                layout property, so nothing reflows around it. */}
            {/* `noValidate` on each step: the steps validate their own input
                (`phoneReady`, `otpComplete`) and render Cognito's answer inline.
                No `<form>` existed here before, so no constraint validation ever
                ran — turning it on now would add a second, competing mechanism
                that swallows the submit behind a browser bubble. */}
            {step === 'login' && (
                <form
                    ref={phoneFormRef}
                    onSubmit={submitStep(handleSendOtp, !phoneReady)}
                    noValidate
                    className="anim-fade-in flex flex-col gap-5"
                >
                    <AuthHeading title={t('title')} subtitle={t('phone_label')} />
                    <Field label={t('fields.phone')}>
                        <PhoneNumberField
                            countryCode={phoneCountryCode}
                            localNumber={phoneLocalNumber}
                            onCountryCodeChange={setPhoneCountryCode}
                            onLocalNumberChange={setPhoneLocalNumber}
                        />
                    </Field>
                    {error ? (
                        <div className="flex flex-col gap-2.5">
                            <FormError>{error}</FormError>
                            {/* Decided 2026-10-01: a number sign-in does not
                                recognise gets a NEUTRAL way to sign up instead.
                                Same sentence above it for everyone, so nothing
                                here says whether the number has an account.
                                `type="button"`: inside this form a bare button
                                would submit it and text another code. The
                                number is shared state, so sign-up opens with it
                                already in the field. */}
                            {errorKey === UNRECOGNISED_NUMBER ? (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="w-full"
                                    onClick={() => { setErrorKey(null); setStep('signup'); }}
                                >
                                    {t('signup_nudge')}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    <Button type="submit" className="w-full" size="lg" disabled={!phoneReady} loading={isLoading} loadingLabel={tCommon('loading')}>
                        {t('send_otp')}
                    </Button>
                    <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setErrorKey(null); setStep('signup'); }} />
                </form>
            )}

            {step === 'signup' && (
                <form
                    ref={phoneFormRef}
                    onSubmit={submitStep(handleCreateAccount, !phoneReady)}
                    noValidate
                    className="anim-fade-in flex flex-col gap-4"
                >
                    <BackButton onClick={() => { setErrorKey(null); setStep('login'); }} label={t('back')} />
                    <AuthHeading title={t('signup_title')} subtitle={t('signup_subtitle')} />
                    <p className="text-xs leading-relaxed text-[var(--jale-ink-2)]">{t('password_note')}</p>
                    <Field label={t('fields.phone')}>
                        <PhoneNumberField
                            countryCode={phoneCountryCode}
                            localNumber={phoneLocalNumber}
                            onCountryCodeChange={setPhoneCountryCode}
                            onLocalNumberChange={setPhoneLocalNumber}
                        />
                    </Field>
                    {error && <FormError>{error}</FormError>}
                    <Button type="submit" className="w-full" size="lg" disabled={!phoneReady} loading={isLoading} loadingLabel={tCommon('loading')}>
                        {t('create_account')}
                    </Button>
                </form>
            )}

            {step === 'otp' && (
                <OtpStep
                    title={t('otp_title')}
                    subtitle={t('code_sent', { phone })}
                    digitLabel={(n) => t('otp_digit', { n, total: OTP_LENGTH })}
                    backLabel={t('back')}
                    onBack={() => {
                        setErrorKey(null);
                        setResendSuccess(false);
                        setResendCooldownSeconds(0);
                        resetDigits();
                        setStep('login');
                    }}
                    digits={digits}
                    inputRefs={inputRefs}
                    onChange={handleDigitChange}
                    onKeyDown={handleDigitKeyDown}
                    onPaste={handleDigitPaste}
                    error={error}
                    resendSuccess={resendSuccess}
                    resendSuccessMessage={t('resend_success')}
                    resendPrompt={t('resend_prompt')}
                    resendLabel={t('resend_code')}
                    resendWaitLabel={t('resend_wait', { seconds: resendCooldownSeconds })}
                    canResend={resendCooldownSeconds <= 0}
                    isResending={isResendingCode}
                    onResend={handleResendOtp}
                    buttonLabel={t('verify')}
                    isLoading={isLoading}
                    loadingLabel={tCommon('loading')}
                    disabled={!otpComplete || isLoading || isResendingCode}
                    onFormSubmit={submitStep(handleVerifyOtp, !otpComplete || isResendingCode)}
                />
            )}
        </div>
    );
}

function AuthHeading({ title, subtitle, id }: { title: string; subtitle: string; id?: string }) {
    return (
        <div>
            <h1 id={id} className="mb-2 text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">{title}</h1>
            <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{subtitle}</p>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</label>
            {children}
        </div>
    );
}

/**
 * Form-level failures — the ones that came back from Cognito, already mapped to
 * a translated sentence by `authErrorKey`. `InlineFeedback` carries the tinted
 * danger surface and `role="alert"`, so the message is announced instead of
 * just appearing as a slightly red line.
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

function OtpStep(props: {
    title: string;
    subtitle: string;
    /** The name of box `n` (1-based) for a screen reader: "Digit n of 6". */
    digitLabel: (n: number) => string;
    backLabel: string;
    onBack: () => void;
    digits: string[];
    inputRefs: MutableRefObject<(HTMLInputElement | null)[]>;
    onChange: (index: number, value: string) => void;
    onKeyDown: (index: number, e: React.KeyboardEvent<HTMLInputElement>) => void;
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
    error: string | null;
    resendSuccess: boolean;
    resendSuccessMessage: string;
    resendPrompt: string;
    resendLabel: string;
    resendWaitLabel: string;
    canResend: boolean;
    isResending: boolean;
    onResend: () => void;
    buttonLabel: string;
    isLoading: boolean;
    loadingLabel: string;
    disabled: boolean;
    /** The step's `<form onSubmit>`; it carries the same guard as `disabled`. */
    onFormSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
    const titleId = useId();
    return (
        /* A real `<form>`, so Enter verifies from ANY box once all six digits
           are in — the keystroke a worker reaches for the instant the last
           digit lands. `noValidate` for the same reason as the phone steps, and
           the guard is `props.disabled`: the same expression the button uses
           (incomplete code, verify in flight, resend in flight), so Enter can
           never spend an OTP attempt the button would have refused. */
        <form onSubmit={props.onFormSubmit} noValidate className="anim-fade-in flex flex-col gap-5">
            <BackButton onClick={props.onBack} label={props.backLabel} />
            <AuthHeading id={titleId} title={props.title} subtitle={props.subtitle} />
            {/* One group named by the step's title, and a name per box, so a
                screen reader says which digit each box is for. */}
            <div
                role="group"
                aria-labelledby={titleId}
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${OTP_LENGTH}, 1fr)` }}
            >
                {props.digits.map((d, i) => (
                    <input
                        key={i}
                        ref={(el) => { props.inputRefs.current[i] = el; }}
                        type="text"
                        inputMode="numeric"
                        aria-label={props.digitLabel(i + 1)}
                        // React applies this on mount, synchronously — which is
                        // why the deferred focus timers this step used to rely
                        // on are gone.
                        autoFocus={i === 0}
                        autoComplete={i === 0 ? 'one-time-code' : 'off'}
                        maxLength={i === 0 ? OTP_LENGTH : 1}
                        value={d}
                        onChange={(e) => props.onChange(i, e.target.value)}
                        onKeyDown={(e) => props.onKeyDown(i, e)}
                        onPaste={i === 0 ? props.onPaste : undefined}
                        /* Same recipe as `ui/input`, including `--input-focus`
                           for the focused fill: `bg-white` would stay white in
                           the dark theme and blow out the card. */
                        className="rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] text-center font-bold text-[var(--jale-ink)] transition-[background-color,border-color,box-shadow] duration-150 focus:border-[var(--jale-blue-500)] focus:bg-[var(--input-focus)] focus:shadow-[var(--shadow-focus)] focus:outline-none"
                        style={{ height: 56, width: '100%', minWidth: 0 }}
                    />
                ))}
            </div>
            {props.error && <FormError>{props.error}</FormError>}
            {props.resendSuccess && (
                <InlineFeedback tone="success">{props.resendSuccessMessage}</InlineFeedback>
            )}
            <Button type="submit" className="w-full" size="lg" disabled={props.disabled} loading={props.isLoading} loadingLabel={props.loadingLabel}>
                {props.buttonLabel}
            </Button>
            <p className="text-center text-sm text-[var(--jale-ink-2)]">
                {props.resendPrompt}{' '}
                <button
                    type="button"
                    onClick={props.onResend}
                    disabled={props.isLoading || props.isResending || !props.canResend}
                    className={`text-[length:inherit] disabled:cursor-not-allowed disabled:opacity-60 ${LINK_BUTTON}`}
                >
                    {props.isResending
                        ? props.loadingLabel
                        : props.canResend
                            ? props.resendLabel
                            : props.resendWaitLabel}
                </button>
            </p>
        </form>
    );
}
