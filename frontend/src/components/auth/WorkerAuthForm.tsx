'use client';
import { useState, useRef, useEffect, type FormEvent, type MutableRefObject, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerSignUp, workerVerifyOtp } from '@/lib/cognito';
import { authErrorKey } from '@/lib/auth-errors';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { claimReferral, getWorkerOnboarding } from '@/lib/api/worker';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PhoneNumberField } from '@/components/auth/PhoneNumberField';
import {
    stashPendingReferral,
    readPendingReferral,
    clearPendingReferral,
    validateJobId,
    markAuthFlowCompleting,
    clearAuthFlowCompleting,
} from '@/lib/referral-return';

const OTP_LENGTH = 6;
const RESEND_CODE_COOLDOWN_SECONDS = 60;

type Step = 'login' | 'signup' | 'otp';

export default function WorkerAuthForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const t = useTranslations('auth.worker');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    // Referred-stranger web-apply carry-through: stash job/share as soon as
    // they show up on the URL so they survive the multi-step OTP flow
    // (including a page reload mid-flow).
    useEffect(() => {
        const jobId = searchParams.get('job');
        const shareCode = searchParams.get('share');
        if (jobId || shareCode) {
            stashPendingReferral({ jobId, shareCode });
        } else {
            // A plain, param-free visit to this page (e.g. an existing
            // worker logging in directly) must not resurrect a stale
            // referral left over from an earlier, abandoned attempt.
            clearPendingReferral();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [step, setStep] = useState<Step>('login');
    // Which door this OTP screen was reached through. `step` cannot answer it
    // -- both doors set it to 'otp' -- and the two want different fallbacks
    // once the code is accepted (see `handleVerifyOtp`).
    const [isSignup, setIsSignup] = useState(false);
    const [phoneCountryCode, setPhoneCountryCode] = useState<PhoneCountryCode>('+1');
    const [phoneLocalNumber, setPhoneLocalNumber] = useState('');
    const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
    const [user, setUser] = useState<CognitoUser | null>(null);
    const [error, setError] = useState<string | null>(null);
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
        setError(null);
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
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateAccount = async () => {
        setError(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            await workerSignUp({ phone });
            setUser(await workerSignIn(phone));
            resetDigits();
            setResendCooldownSeconds(RESEND_CODE_COOLDOWN_SECONDS);
            setIsSignup(true);
            setStep('otp');
            // Same as `handleSendOtp`: the step's own `autoFocus` does this.
        } catch (err) {
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleResendOtp = async () => {
        if (resendCooldownSeconds > 0) return;
        setError(null);
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
            setError(t(authErrorKey(err)));
        } finally {
            setIsResendingCode(false);
        }
    };

    const handleVerifyOtp = async () => {
        if (!user) return;
        setError(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            const tokens = await workerVerifyOtp(user, code);

            // Claim single ownership of this authenticated transition BEFORE
            // setTokens flips isAuthenticated -- otherwise auth/worker/page's
            // own already-authenticated effect fires on the same tick and
            // both sides claim the referral and race on the redirect.
            markAuthFlowCompleting();
            setTokens(tokens, 'worker');

            const stash = readPendingReferral();
            if (stash?.shareCode) {
                // Fire-and-forget: the claim result is never surfaced to the
                // user, so don't make them wait on it, and a bad/expired
                // code must never break signup.
                claimReferral(tokens.idToken, stash.shareCode).catch(() => {});
            }

            // Signup and login take the SAME next hop now, and the run itself
            // decides it: anyone the engine still considers `onboarding` --
            // a fresh signup, or a returning worker who abandoned the flow
            // half-way (on either door) -- goes to /worker/onboarding.
            //
            // The referral stash is deliberately LEFT in place on that path:
            // the flow's summary screen reads it and hands the worker on to
            // the job they were applying for once onboarding is done.
            //
            // A read that fails (offline, or the endpoint down) must never
            // strand a worker who has just proved their phone number, so it
            // falls back to the destination this form used before.
            let lifecycle: string | null = null;
            try {
                lifecycle = (await getWorkerOnboarding(tokens.idToken)).lifecycle;
            } catch {
                lifecycle = null;
            }

            // A read that failed tells us nothing, so the two doors part ways
            // here. After a SIGNUP there is no profile worth showing and the
            // run is certainly unfinished, so send them to the flow and let it
            // do the error handling it already has (retry, and a way out).
            // After a LOGIN the old destination is still the better guess:
            // most workers signing in are done onboarding, and dropping them
            // into a flow they finished months ago would be worse than the
            // profile page they asked for.
            const unread = lifecycle === null;
            if ((lifecycle && lifecycle !== 'ready') || (unread && isSignup)) {
                router.replace('/worker/onboarding');
            } else {
                const jobId = validateJobId(stash?.jobId);
                router.push(jobId ? `/worker/jobs/${jobId}` : '/worker/profile');
                clearPendingReferral();
            }
            clearAuthFlowCompleting();
        } catch (err) {
            setError(t(authErrorKey(err)));
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
                    {error && <FormError>{error}</FormError>}
                    <Button type="submit" className="w-full" size="lg" disabled={!phoneReady} loading={isLoading} loadingLabel={tCommon('loading')}>
                        {t('send_otp')}
                    </Button>
                    <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setError(null); setStep('signup'); }} />
                </form>
            )}

            {step === 'signup' && (
                <form
                    ref={phoneFormRef}
                    onSubmit={submitStep(handleCreateAccount, !phoneReady)}
                    noValidate
                    className="anim-fade-in flex flex-col gap-4"
                >
                    <BackButton onClick={() => { setError(null); setStep('login'); }} label={t('back')} />
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
                    backLabel={t('back')}
                    onBack={() => {
                        setError(null);
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

function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div>
            <h1 className="mb-2 text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">{title}</h1>
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
    return (
        /* A real `<form>`, so Enter verifies from ANY box once all six digits
           are in — the keystroke a worker reaches for the instant the last
           digit lands. `noValidate` for the same reason as the phone steps, and
           the guard is `props.disabled`: the same expression the button uses
           (incomplete code, verify in flight, resend in flight), so Enter can
           never spend an OTP attempt the button would have refused. */
        <form onSubmit={props.onFormSubmit} noValidate className="anim-fade-in flex flex-col gap-5">
            <BackButton onClick={props.onBack} label={props.backLabel} />
            <AuthHeading title={props.title} subtitle={props.subtitle} />
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${OTP_LENGTH}, 1fr)` }}>
                {props.digits.map((d, i) => (
                    <input
                        key={i}
                        ref={(el) => { props.inputRefs.current[i] = el; }}
                        type="text"
                        inputMode="numeric"
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
