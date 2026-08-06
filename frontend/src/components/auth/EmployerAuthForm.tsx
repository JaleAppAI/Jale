'use client';
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerConfirmSignUp, employerSignIn, employerSignUp, employerForgotPassword, employerConfirmNewPassword } from '@/lib/cognito';
import { authErrorKey } from '@/lib/auth-errors';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CompanySize, EmployerJobType, EmployerProfilePatch, EmployerTrade } from '@/lib/api/employer';
import { validateEmployerSignupFields, type EmployerSignupField } from '@/lib/employer-profile-form';
import { Button } from '@/components/ui/button';
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
    const phone = formatPhoneNumber(phoneCountryCode, phoneLocalNumber);

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
            console.error('[EmployerAuth] sign-in error:', err);
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
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
            setStep('confirm');
        } catch (err) {
            console.error('[EmployerAuth] sign-up error:', err);
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleConfirm = async () => {
        setError(null);
        setIsLoading(true);
        try {
            await employerConfirmSignUp(email, confirmationCode);
            sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(pendingProfile()));
            const tokens = await employerSignIn(email, password);
            setTokens(tokens, 'employer');
            router.push('/employer/profile');
        } catch (err) {
            console.error('[EmployerAuth] confirm error:', err);
            setError(t(authErrorKey(err)));
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
            console.error('[EmployerAuth] forgot-password error:', err);
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
            console.error('[EmployerAuth] forgot-confirm error:', err);
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

    return (
        <div className="flex w-full flex-col">
                <h1 className="font-bold leading-tight mb-2" style={{ fontSize: 'clamp(1.6rem, 3vw, 1.9rem)', letterSpacing: '-0.03em', color: 'var(--jale-ink)' }}>
                    {step === 'login' ? t('hero') : step === 'forgot_request' ? t('forgot_title') : step === 'forgot_confirm' ? t('forgot_confirm_title') : t('signup_title')}
                </h1>
                <p className="text-sm leading-relaxed mb-8" style={{ color: 'var(--jale-ink-2)' }}>
                    {step === 'login' ? t('title') : step === 'forgot_request' || step === 'forgot_confirm' ? '' : t('signup_subtitle')}
                </p>

                {step === 'login' && (
                    <div className="flex flex-col gap-4">
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
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => { setError(null); setResetSuccess(false); setForgotEmail(email); setStep('forgot_request'); }}
                                className="text-xs font-medium"
                                style={{ background: 'none', border: 0, color: 'var(--jale-blue-600)', cursor: 'pointer', padding: 0 }}
                            >
                                {t('forgot_link')}
                            </button>
                        </div>
                        {error && <ErrorText error={error} />}
                        {resetSuccess && (
                            <p className="text-sm font-medium rounded-lg px-4 py-3" style={{ background: 'var(--jale-success-bg)', color: 'var(--jale-success)' }}>
                                {t('reset_success')}
                            </p>
                        )}
                        <Button className="w-full mt-1" size="lg" onClick={handleSignIn} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('sign_in')}
                        </Button>
                        <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setError(null); setResetSuccess(false); setStep('signup'); }} />
                    </div>
                )}

                {step === 'signup' && (
                    <div className="flex flex-col gap-4">
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
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>{t('password_note')}</p>
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
                        {error && <ErrorText error={error} />}
                        <Button className="w-full mt-1" size="lg" onClick={handleCreateAccount} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('create_account')}
                        </Button>
                        <SwitchPrompt text={t('signin_prompt')} action={t('signin_link')} onClick={() => { setError(null); setStep('login'); }} />
                    </div>
                )}

                {step === 'confirm' && (
                    <div className="flex flex-col gap-4">
                        <button onClick={() => { setError(null); setStep('signup'); }} className="self-start text-sm font-medium" style={{ background: 'none', border: 0, color: 'var(--jale-ink-2)', cursor: 'pointer', padding: 0 }}>
                            &larr; {t('back')}
                        </button>
                        <Field label={t('fields.confirmation_code')}><Input value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} inputMode="numeric" /></Field>
                        {error && <ErrorText error={error} />}
                        <Button className="w-full mt-1" size="lg" onClick={handleConfirm} disabled={confirmationCode.length < 4} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('confirm_account')}
                        </Button>
                    </div>
                )}

                {step === 'forgot_request' && (
                    <div className="flex flex-col gap-4">
                        <button onClick={() => { setError(null); setStep('login'); }} className="self-start text-sm font-medium" style={{ background: 'none', border: 0, color: 'var(--jale-ink-2)', cursor: 'pointer', padding: 0 }}>
                            &larr; {t('back')}
                        </button>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>{t('forgot_subtitle')}</p>
                        <Field label={t('fields.email')}>
                            <Input
                                type="email"
                                value={forgotEmail}
                                onChange={(e) => setForgotEmail(e.target.value)}
                                autoComplete="email"
                            />
                        </Field>
                        {error && <ErrorText error={error} />}
                        <Button className="w-full mt-1" size="lg" onClick={handleForgotRequest} disabled={!forgotEmail.trim()} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('send_code')}
                        </Button>
                    </div>
                )}

                {step === 'forgot_confirm' && (
                    <div className="flex flex-col gap-4">
                        <button onClick={() => { setError(null); setResetCode(''); setNewPassword(''); setNewPasswordConfirm(''); setStep('forgot_request'); }} className="self-start text-sm font-medium" style={{ background: 'none', border: 0, color: 'var(--jale-ink-2)', cursor: 'pointer', padding: 0 }}>
                            &larr; {t('back')}
                        </button>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>
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
                        {error && <ErrorText error={error} />}
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

// Employer proof panel — rendered in the AuthShell navy brand slot (lg+ only).
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

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</label>
            {children}
            {error && <p className="text-xs text-error">{error}</p>}
        </div>
    );
}

function CheckboxGroup({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
            {error && <p className="text-xs text-error">{error}</p>}
        </div>
    );
}

function ErrorText({ error }: { error: string }) {
    return <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>;
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
            <button
                type="button"
                onClick={onToggle}
                aria-label={visible ? hideLabel : showLabel}
                title={visible ? hideLabel : showLabel}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] focus:outline-none focus:ring-2 focus:ring-[var(--jale-blue-500)]"
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
        <p className="text-center text-sm" style={{ color: 'var(--jale-ink-2)' }}>
            {text}{' '}
            <button onClick={onClick} style={{ background: 'none', border: 0, color: 'var(--jale-blue-600)', fontWeight: 600, cursor: 'pointer', fontSize: 'inherit', padding: 0 }}>
                {action}
            </button>
        </p>
    );
}
