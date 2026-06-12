'use client';
import { useState, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerSignUp, workerVerifyOtp } from '@/lib/cognito';
import { authErrorKey } from '@/lib/auth-errors';
import { formatPhoneNumber, type PhoneCountryCode } from '@/lib/phone';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import type { WorkerAvailability, WorkerExperience, WorkerProfilePatch, WorkerTrade } from '@/lib/api/worker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PhoneNumberField } from '@/components/auth/PhoneNumberField';

const OTP_LENGTH = 6;
const TRADES: WorkerTrade[] = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];
const EXPERIENCE: WorkerExperience[] = ['0-1', '2-4', '5-9', '10+'];
const AVAILABILITY: WorkerAvailability[] = ['full_time', 'part_time', 'weekends', 'flexible'];

type Step = 'login' | 'signup' | 'otp';

export default function WorkerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.worker');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [step, setStep] = useState<Step>('login');
    const [phoneCountryCode, setPhoneCountryCode] = useState<PhoneCountryCode>('+1');
    const [phoneLocalNumber, setPhoneLocalNumber] = useState('');
    const [fullName, setFullName] = useState('');
    const [city, setCity] = useState('');
    const [mainTrade, setMainTrade] = useState<WorkerTrade>('electrician');
    const [mainTradeOther, setMainTradeOther] = useState('');
    const [yearsExperience, setYearsExperience] = useState<WorkerExperience>('0-1');
    const [hasTransportation, setHasTransportation] = useState<boolean>(true);
    const [availability, setAvailability] = useState<WorkerAvailability>('full_time');
    const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
    const [user, setUser] = useState<CognitoUser | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    const resetDigits = () => setDigits(Array(OTP_LENGTH).fill(''));
    const code = digits.join('');
    const phone = formatPhoneNumber(phoneCountryCode, phoneLocalNumber);
    const phoneReady = phoneLocalNumber.replace(/\D/g, '').length >= 7;

    const pendingProfile = (): WorkerProfilePatch => ({
        full_name: fullName.trim(),
        city: city.trim(),
        location: city.trim(),
        main_trade: mainTrade,
        main_trade_other: mainTrade === 'other' ? mainTradeOther.trim() : null,
        years_experience: yearsExperience,
        has_transportation: hasTransportation,
        availability,
    });

    const handleSendOtp = async () => {
        setError(null);
        setIsLoading(true);
        try {
            setUser(await workerSignIn(phone));
            resetDigits();
            setStep('otp');
            setTimeout(() => inputRefs.current[0]?.focus(), 50);
        } catch (err) {
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateAccount = async () => {
        setError(null);
        if (mainTrade === 'other' && !mainTradeOther.trim()) {
            setError(t('errors.trade_other_required'));
            return;
        }
        setIsLoading(true);
        try {
            await workerSignUp({ phone, fullName });
            sessionStorage.setItem('pendingWorkerProfile', JSON.stringify(pendingProfile()));
            setUser(await workerSignIn(phone));
            resetDigits();
            setStep('otp');
            setTimeout(() => inputRefs.current[0]?.focus(), 50);
        } catch (err) {
            setError(t(authErrorKey(err)));
        } finally {
            setIsLoading(false);
        }
    };

    const handleVerifyOtp = async () => {
        if (!user) return;
        setError(null);
        setIsLoading(true);
        try {
            const tokens = await workerVerifyOtp(user, code);
            setTokens(tokens, 'worker');
            router.push('/worker/profile');
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
            inputRefs.current[Math.min(numeric.length, OTP_LENGTH) - 1]?.focus();
            return;
        }
        if (!/^\d?$/.test(value)) return;
        const next = [...digits];
        next[index] = numeric;
        setDigits(next);
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
        inputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
    };

    const otpComplete = digits.every(Boolean);
    const canCreate = fullName.trim() && phoneReady && city.trim() && (mainTrade !== 'other' || mainTradeOther.trim());

    return (
        <div className={`w-full ${step === 'signup' ? 'max-w-md' : 'max-w-sm'} mx-auto px-6 py-10 flex flex-col`} style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
            <div className="jale-wordmark mb-10" style={{ fontSize: '1.75rem' }}>Jale</div>

            {step === 'login' && (
                <div className="flex flex-col gap-5">
                    <AuthHeading title={t('title')} subtitle={t('phone_label')} />
                    <Field label={t('fields.phone')}>
                        <PhoneNumberField
                            countryCode={phoneCountryCode}
                            localNumber={phoneLocalNumber}
                            onCountryCodeChange={setPhoneCountryCode}
                            onLocalNumberChange={setPhoneLocalNumber}
                        />
                    </Field>
                    {error && <ErrorText error={error} />}
                    <Button className="w-full" size="lg" onClick={handleSendOtp} disabled={!phoneReady} loading={isLoading} loadingLabel={tCommon('loading')}>
                        {t('send_otp')}
                    </Button>
                    <SwitchPrompt text={t('signup_prompt')} action={t('signup_link')} onClick={() => { setError(null); setStep('signup'); }} />
                </div>
            )}

            {step === 'signup' && (
                <div className="flex flex-col gap-4">
                    <BackButton onClick={() => { setError(null); setStep('login'); }} label={t('back')} />
                    <AuthHeading title={t('signup_title')} subtitle={t('signup_subtitle')} />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>{t('password_note')}</p>
                    <Field label={t('fields.full_name')}><Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" /></Field>
                    <Field label={t('fields.phone')}>
                        <PhoneNumberField
                            countryCode={phoneCountryCode}
                            localNumber={phoneLocalNumber}
                            onCountryCodeChange={setPhoneCountryCode}
                            onLocalNumberChange={setPhoneLocalNumber}
                        />
                    </Field>
                    <Field label={t('fields.city')}><Input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
                    <Field label={t('fields.main_trade')}>
                        <Select value={mainTrade} onChange={(e) => setMainTrade(e.target.value as WorkerTrade)}>
                            {TRADES.map((trade) => <option key={trade} value={trade}>{t(`trades.${trade}`)}</option>)}
                        </Select>
                    </Field>
                    {mainTrade === 'other' && (
                        <Field label={t('fields.main_trade_other')}><Input value={mainTradeOther} onChange={(e) => setMainTradeOther(e.target.value)} /></Field>
                    )}
                    <Field label={t('fields.years_experience')}>
                        <Select value={yearsExperience} onChange={(e) => setYearsExperience(e.target.value as WorkerExperience)}>
                            {EXPERIENCE.map((exp) => <option key={exp} value={exp}>{t(`experience.${exp.replace('+', 'plus')}`)}</option>)}
                        </Select>
                    </Field>
                    <Field label={t('fields.has_transportation')}>
                        <Select value={hasTransportation ? 'yes' : 'no'} onChange={(e) => setHasTransportation(e.target.value === 'yes')}>
                            <option value="yes">{t('yes')}</option>
                            <option value="no">{t('no')}</option>
                        </Select>
                    </Field>
                    <Field label={t('fields.availability')}>
                        <Select value={availability} onChange={(e) => setAvailability(e.target.value as WorkerAvailability)}>
                            {AVAILABILITY.map((item) => <option key={item} value={item}>{t(`availability.${item}`)}</option>)}
                        </Select>
                    </Field>
                    {error && <ErrorText error={error} />}
                    <Button className="w-full" size="lg" onClick={handleCreateAccount} disabled={!canCreate} loading={isLoading} loadingLabel={tCommon('loading')}>
                        {t('create_account')}
                    </Button>
                </div>
            )}

            {step === 'otp' && (
                <OtpStep
                    title={t('otp_title')}
                    subtitle={t('code_sent', { phone })}
                    backLabel={t('back')}
                    onBack={() => { setError(null); resetDigits(); setStep('login'); }}
                    digits={digits}
                    inputRefs={inputRefs}
                    onChange={handleDigitChange}
                    onKeyDown={handleDigitKeyDown}
                    onPaste={handleDigitPaste}
                    error={error}
                    buttonLabel={t('verify')}
                    isLoading={isLoading}
                    loadingLabel={tCommon('loading')}
                    disabled={!otpComplete || isLoading}
                    onSubmit={handleVerifyOtp}
                />
            )}
        </div>
    );
}

function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div>
            <h1 className="font-bold leading-tight mb-2" style={{ fontSize: '1.4rem', letterSpacing: '-0.03em', color: 'var(--jale-ink)' }}>{title}</h1>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>{subtitle}</p>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</label>
            {children}
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

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button onClick={onClick} className="self-start text-sm font-medium flex items-center gap-1" style={{ background: 'none', border: 0, color: 'var(--jale-ink-2)', cursor: 'pointer', padding: 0 }}>
            &larr; {label}
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
    buttonLabel: string;
    isLoading: boolean;
    loadingLabel: string;
    disabled: boolean;
    onSubmit: () => void;
}) {
    return (
        <div className="flex flex-col gap-5">
            <BackButton onClick={props.onBack} label={props.backLabel} />
            <div>
                <h1 className="font-semibold leading-snug mb-1" style={{ fontSize: '1.15rem', letterSpacing: '-0.02em', color: 'var(--jale-ink)' }}>{props.title}</h1>
                <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>{props.subtitle}</p>
            </div>
            <div className="grid " style={{ gridTemplateColumns: `repeat(${OTP_LENGTH}, 1fr)` }}>
                {props.digits.map((d, i) => (
                    <input
                        key={i}
                        ref={(el) => { props.inputRefs.current[i] = el; }}
                        type="text"
                        inputMode="numeric"
                        autoComplete={i === 0 ? 'one-time-code' : 'off'}
                        maxLength={i === 0 ? OTP_LENGTH : 1}
                        value={d}
                        onChange={(e) => props.onChange(i, e.target.value)}
                        onKeyDown={(e) => props.onKeyDown(i, e)}
                        onPaste={i === 0 ? props.onPaste : undefined}
                        className="text-center font-bold rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] focus:outline-none focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)] focus:bg-white transition-all duration-150"
                        style={{ height: 56, width: '50px', gap: 2, color: 'var(--jale-ink)' }}
                    />
                ))}
            </div>
            {props.error && <ErrorText error={props.error} />}
            <Button className="w-full" size="lg" onClick={props.onSubmit} disabled={props.disabled} loading={props.isLoading} loadingLabel={props.loadingLabel}>
                {props.buttonLabel}
            </Button>
        </div>
    );
}
