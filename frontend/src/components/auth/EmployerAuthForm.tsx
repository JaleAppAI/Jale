'use client';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerConfirmSignUp, employerSignIn, employerSignUp } from '@/lib/cognito';
import { authErrorKey } from '@/lib/auth-errors';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CompanySize, EmployerJobType, EmployerProfilePatch, EmployerTrade } from '@/lib/api/employer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { PhoneNumberField } from '@/components/auth/PhoneNumberField';

const TRADES: EmployerTrade[] = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];
const JOB_TYPES: EmployerJobType[] = ['full-time', 'part-time', 'contract'];
const COMPANY_SIZES: CompanySize[] = ['1-10', '11-50', '51-200', '200+'];

type Step = 'login' | 'signup' | 'confirm';

export default function EmployerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [step, setStep] = useState<Step>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
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
    const [isLoading, setIsLoading] = useState(false);
    const phone = formatPhoneNumber(phoneCountryCode, phoneLocalNumber);
    const phoneReady = phoneLocalNumber.replace(/\D/g, '').length >= 7;

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

    const toggleTrade = (trade: EmployerTrade) => {
        setHiringTrades((current) => current.includes(trade) ? current.filter((item) => item !== trade) : [...current, trade]);
    };
    const toggleJobType = (jobType: EmployerJobType) => {
        setTypicalJobTypes((current) => current.includes(jobType) ? current.filter((item) => item !== jobType) : [...current, jobType]);
    };

    const canCreate = companyName.trim() && contactName.trim() && email.trim() && password && passwordConfirm && phoneReady &&
        city.trim() && serviceArea.trim() && hiringTrades.length > 0 && typicalJobTypes.length > 0;

    return (
        <div className="flex w-full" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
            <div className="flex flex-1 flex-col justify-center py-8 px-10 max-w-lg">

                <h1 className="font-bold leading-tight mb-2" style={{ fontSize: 'clamp(1.6rem, 3vw, 1.9rem)', letterSpacing: '-0.03em', color: 'var(--jale-ink)' }}>
                    {step === 'login' ? t('hero') : t('signup_title')}
                </h1>
                <p className="text-sm leading-relaxed mb-8" style={{ color: 'var(--jale-ink-2)' }}>
                    {step === 'login' ? t('title') : t('signup_subtitle')}
                </p>

                {step === 'login' && (
                    <div className="flex flex-col gap-4">
                        <Field label={t('fields.email')}>
                            <Input type="email" placeholder={t('email_label')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                        </Field>
                        <Field label={t('fields.password')}>
                            <Input type="password" placeholder={t('password_label')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                        </Field>
                        {error && <ErrorText error={error} />}
                        <Button className="w-full mt-1" size="lg" onClick={handleSignIn} disabled={!email || !password} loading={isLoading} loadingLabel={tCommon('loading')}>
                            {t('sign_in')}
                        </Button>
                        <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setError(null); setStep('signup'); }} />
                    </div>
                )}

                {step === 'signup' && (
                    <div className="flex flex-col gap-4">
                        <Field label={t('fields.company_name')}><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></Field>
                        <Field label={t('fields.contact_name')}><Input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" /></Field>
                        <Field label={t('fields.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
                        <Field label={t('fields.password')}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
                        <Field label={t('fields.password_confirm')}><Input type="password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} autoComplete="new-password" /></Field>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>{t('password_note')}</p>
                        <Field label={t('fields.phone')}>
                            <PhoneNumberField
                                countryCode={phoneCountryCode}
                                localNumber={phoneLocalNumber}
                                onCountryCodeChange={setPhoneCountryCode}
                                onLocalNumberChange={setPhoneLocalNumber}
                            />
                        </Field>
                        <Field label={t('fields.city')}><Input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
                        <Field label={t('fields.service_area')}><Input value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} /></Field>
                        <CheckboxGroup label={t('fields.hiring_trades')}>
                            {TRADES.map((trade) => <CheckboxCard key={trade} checked={hiringTrades.includes(trade)} label={t(`trades.${trade}`)} onChange={() => toggleTrade(trade)} />)}
                        </CheckboxGroup>
                        <CheckboxGroup label={t('fields.typical_job_types')}>
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
                        <Button className="w-full mt-1" size="lg" onClick={handleCreateAccount} disabled={!canCreate} loading={isLoading} loadingLabel={tCommon('loading')}>
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
            </div>

            <div className="hidden md:flex flex-1 flex-col items-center justify-center px-12 py-16 text-white" style={{ background: 'var(--jale-blue-500)' }}>
                <div className="max-w-xs">
                    <div className="font-bold leading-none mb-2" style={{ fontSize: '4rem', letterSpacing: '-0.04em' }}>2.4x</div>
                    <div className="text-lg font-semibold mb-4">{t('panel_title')}</div>
                    <p className="text-sm leading-relaxed" style={{ opacity: 0.85 }}>{t('panel_body')}</p>
                </div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</label>
            {children}
        </div>
    );
}

function CheckboxGroup({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
        </div>
    );
}

function ErrorText({ error }: { error: string }) {
    return <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>;
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
