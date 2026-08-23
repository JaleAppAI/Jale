'use client';
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerConfirmSignUp, employerSignIn, employerSignUp, employerForgotPassword, employerConfirmNewPassword, employerResendConfirmationCode } from '@/lib/cognito';
import { authErrorKey, resendErrorKey } from '@/lib/auth-errors';
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
    password: 'fields.password',
    password_confirm: 'fields.password_confirm',
    phone: 'fields.phone',
    city: 'fields.city',
    service_area: 'fields.service_area',
    hiring_trades: 'fields.hiring_trades',
    typical_job_types: 'fields.typical_job_types',
};

export default function EmployerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [step, setStep] = useState<Step>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
    const [confirmationCode, setConfirmationCode] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [contactName, setContactName] = useState('');
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
    const [resetSuccess, setResetSuccess] = useState(false);
    const [forgotEmail, setForgotEmail] = useState('');
    const [resetCode, setResetCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [showNewPasswordConfirm, setShowNewPasswordConfirm] = useState(false);
    const [confirmOrigin, setConfirmOrigin] = useState<ConfirmOrigin>('signup');
    const [isResending, setIsResending] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(0);
    const [resendSuccess, setResendSuccess] = useState(false);
    const [confirmedSuccess, setConfirmedSuccess] = useState(false);
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

    const pendingProfile = (): EmployerProfilePatch => ({
        company_name: companyName.trim(),
        contact_name: contactName.trim(),
        phone: phone.trim(),
        city: city.trim(),
        service_area: serviceArea.trim(),
        hiring_trades: hiringTrades,
        typical_job_types: typicalJobTypes,
        company_size: companySize,
        company_description: companyDescription.trim(),
    });

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
     */
    const enterRecoveryConfirm = (targetEmail: string, outcome: ResendOutcome) => {
        setEmail(targetEmail);
        setResetSuccess(false);
        if (outcome.status === 'failed' && outcome.key === 'errors.already_confirmed') {
            goToStep('login');
            setError(t(outcome.key));
            return;
        }
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
        setResendSuccess(true);
        if (outcome.status === 'sent') setResendCooldown(RESEND_COOLDOWN_SECONDS);
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
            setTokens(tokens, 'employer');
            router.push('/employer/profile');
        } catch (err) {
            // Never console.error the raw exception: a Cognito error object
            // carries the submitted email and the request context, and the
            // browser console is shared with anything else on the page.
            // `authErrorKey` already turns the code into a translated sentence,
            // which is the only thing anyone needs from it.
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
     * The always-available escape hatch, from the login step and from the
     * forgot-password step. The forgot step matters more than it looks:
     * Cognito's forgot-password flow reports success for an UNCONFIRMED user
     * without ever sending anything, so that path otherwise loops forever on
     * "that code expired" with no way out.
     *
     * It takes the address explicitly because the two steps keep it in
     * different state (`email` vs `forgotEmail`), and `handleConfirm` reads
     * `email` — so the forgot step's address has to be promoted, which
     * `enterRecoveryConfirm` does.
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
        const missing = validateEmployerSignupFields({
            company_name: companyName, contact_name: contactName, email, password, password_confirm: passwordConfirm,
            phone, city, service_area: serviceArea, hiring_trades: hiringTrades, typical_job_types: typicalJobTypes,
        });
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
            await employerSignUp({ email, password, companyName, contactName, phone });
            setConfirmationCode('');
            setConfirmOrigin('signup');
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

    const handleConfirm = async () => {
        setError(null);
        setResendSuccess(false);
        setIsLoading(true);
        try {
            await employerConfirmSignUp(email, confirmationCode);
        } catch (err) {
            setError(t(authErrorKey(err)));
            setIsLoading(false);
            return;
        }

        // Only a signup-origin confirm has a filled-in form behind it.
        //
        // Writing it on a recovery confirm was actively destructive: the patch
        // always carries `hiring_trades` and `typical_job_types` keys, and the
        // API treats a PRESENT key as an intentional value (employer-profile.ts
        // gates those two columns on `hasOwnProperty`, not on emptiness). An
        // employer who signed in unconfirmed would have both arrays emptied and
        // `company_size` reset to the '1-10' default the moment they entered
        // their code — losing real profile data to fix an email problem.
        if (confirmOrigin === 'signup') {
            sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(pendingProfile()));
        }

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
            setTokens(tokens, 'employer');
            router.push('/employer/profile');
        } catch (err) {
            // The code has been spent, so leaving the user on the confirm step
            // would strand them behind an input that can never succeed again.
            // The confirm itself worked; login is the correct next screen, and
            // it carries the reason the sign-in did not.
            const key = authErrorKey(err);
            goToStep('login');
            setResetSuccess(false);
            setError(t(key));
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
            setError(t(authErrorKey(err)));
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
        setStep(next);
    };

    // A recovery confirm is not a signup, so it must not be greeted with
    // "Welcome to Jale" and "let's verify your email so you can start hiring" —
    // this user already has an account and is trying to get back into it.
    const isRecoveryConfirm = step === 'confirm' && confirmOrigin === 'signin';
    const heading =
        step === 'login' ? t('hero')
            : step === 'forgot_request' ? t('forgot_title')
                : step === 'forgot_confirm' ? t('forgot_confirm_title')
                    : isRecoveryConfirm ? t('recovery_title')
                        : t('signup_title');
    // The forgot steps carry their instruction inline, next to the field it is
    // about, so they deliberately have no subtitle here. Rendering an empty <p>
    // for them (the old shape) left a paragraph that existed only as a margin.
    const subheading =
        step === 'login' ? t('title')
            : step === 'forgot_request' || step === 'forgot_confirm' ? ''
                : isRecoveryConfirm ? t('recovery_subtitle')
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

                {step === 'login' && (
                    <div className="anim-fade-in flex flex-col gap-4">
                        <Field label={t('fields.email')}>
                            <Input type="email" placeholder={t('email_label')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                        </Field>
                        <Field label={t('fields.password')}>
                            <PasswordInput
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
                        <div className="flex flex-col items-end gap-1.5">
                            <button
                                type="button"
                                onClick={() => { setResetSuccess(false); setForgotEmail(email); goToStep('forgot_request'); }}
                                className={`text-xs ${LINK_BUTTON}`}
                            >
                                {t('forgot_link')}
                            </button>
                            {/* Always reachable, not just after a failed sign-in: the
                                user who needs this usually knows the email never
                                arrived and has no reason to attempt a sign-in first. */}
                            <button
                                type="button"
                                onClick={() => handleNeverReceivedCode(email)}
                                disabled={isResending}
                                className={`text-right text-xs ${LINK_BUTTON}`}
                            >
                                {t('never_received_code')}
                            </button>
                        </div>
                        {error && <FormError>{error}</FormError>}
                        {resetSuccess && (
                            <InlineFeedback tone="success">{t('reset_success')}</InlineFeedback>
                        )}
                        {confirmedSuccess && (
                            <InlineFeedback tone="success">{t('confirmed_sign_in')}</InlineFeedback>
                        )}
                        <Button className="w-full mt-1" size="lg" onClick={handleSignIn} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('sign_in')}
                        </Button>
                        <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setResetSuccess(false); goToStep('signup'); }} />
                    </div>
                )}

                {step === 'signup' && (
                    <div className="anim-fade-in flex flex-col gap-4">
                        <Field label={t('fields.company_name')} error={missingFields.includes('company_name') ? t('errors.required') : undefined}>
                            <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                        </Field>
                        <Field label={t('fields.contact_name')} error={missingFields.includes('contact_name') ? t('errors.required') : undefined}>
                            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
                        </Field>
                        <Field label={t('fields.email')} error={missingFields.includes('email') ? t('errors.required') : undefined}>
                            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                        </Field>
                        <Field label={t('fields.password')} error={missingFields.includes('password') ? t('errors.required') : undefined}>
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
                        <Field label={t('fields.city')} error={missingFields.includes('city') ? t('errors.required') : undefined}>
                            <LocationPicker value={city} onChange={(v) => setCity(v.label)} />
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
                        {error && <FormError>{error}</FormError>}
                        <Button className="w-full mt-1" size="lg" onClick={handleCreateAccount} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('create_account')}
                        </Button>
                        <SwitchPrompt text={t('signin_prompt')} action={t('signin_link')} onClick={() => goToStep('login')} />
                    </div>
                )}

                {step === 'confirm' && (
                    <div className="anim-fade-in flex flex-col gap-4">
                        {/* Back has to follow the origin. Hardcoding 'signup' sent a
                            recovering employer into an empty signup form, which is
                            the one place they must not end up: submitting it hits
                            "an account already exists for this email". */}
                        <BackButton label={t('back')} onClick={() => goToStep(confirmOrigin === 'signin' ? 'login' : 'signup')} />
                        {/* Normalised the same way the Cognito calls normalise it, so a
                            typo'd address is visible here — before the user burns resend
                            attempts on an inbox that will never receive anything. */}
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{t('confirm_subtitle', { email: email.trim().toLowerCase() })}</p>
                        <Field label={t('fields.confirmation_code')}><Input value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field>
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
                        {error && <FormError>{error}</FormError>}
                        {/* A resend in flight may be about to invalidate the code in the
                            box — hold Confirm until we know which code is current. */}
                        <Button className="w-full mt-1" size="lg" onClick={handleConfirm} disabled={confirmationCode.length < 4 || isResending} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('confirm_account')}
                        </Button>
                    </div>
                )}

                {step === 'forgot_request' && (
                    <div className="anim-fade-in flex flex-col gap-4">
                        <BackButton label={t('back')} onClick={() => goToStep('login')} />
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{t('forgot_subtitle')}</p>
                        <Field label={t('fields.email')}>
                            <Input
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
                        <Button className="w-full mt-1" size="lg" onClick={handleForgotRequest} disabled={!forgotEmail.trim()} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('send_code')}
                        </Button>
                    </div>
                )}

                {step === 'forgot_confirm' && (
                    <div className="anim-fade-in flex flex-col gap-4">
                        <BackButton
                            label={t('back')}
                            onClick={() => { setResetCode(''); setNewPassword(''); setNewPasswordConfirm(''); goToStep('forgot_request'); }}
                        />
                        <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">
                            {t('forgot_confirm_subtitle', { email: forgotEmail })}
                        </p>
                        <Field label={t('fields.reset_code')}>
                            <Input
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
                            className="w-full mt-1"
                            size="lg"
                            onClick={handleForgotConfirm}
                            disabled={!resetCode.trim() || !newPassword || !newPasswordConfirm}
                            loading={isLoading}
                            loadingLabel={tCommon('loading')}
                        >
                            {t('set_password')}
                        </Button>
                    </div>
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
