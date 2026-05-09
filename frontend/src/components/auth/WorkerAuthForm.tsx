'use client';
import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerVerifyOtp } from '@/lib/cognito';
import { CognitoUser } from 'amazon-cognito-identity-js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const OTP_LENGTH = 6;

export default function WorkerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.worker');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [step, setStep] = useState<'phone' | 'otp'>('phone');
    const [phone, setPhone] = useState('');
    const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
    const [user, setUser] = useState<CognitoUser | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    const handleSendOtp = async () => {
        setError(null);
        setIsLoading(true);
        try {
            setUser(await workerSignIn(phone));
            setStep('otp');
            setTimeout(() => inputRefs.current[0]?.focus(), 50);
        } catch {
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleDigitChange = (index: number, value: string) => {
        if (!/^\d?$/.test(value)) return;
        const next = [...digits];
        next[index] = value;
        setDigits(next);
        if (value && index < OTP_LENGTH - 1) {
            inputRefs.current[index + 1]?.focus();
        }
    };

    const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && !digits[index] && index > 0) {
            inputRefs.current[index - 1]?.focus();
        }
    };

    const handleDigitPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
        if (!pasted) return;
        e.preventDefault();
        const next = Array(OTP_LENGTH).fill('');
        pasted.split('').forEach((d, i) => { next[i] = d; });
        setDigits(next);
        const focusIdx = Math.min(pasted.length, OTP_LENGTH - 1);
        inputRefs.current[focusIdx]?.focus();
    };

    const handleVerifyOtp = async () => {
        if (!user) return;
        setError(null);
        setIsLoading(true);
        try {
            const tokens = await workerVerifyOtp(user, digits.join(''));
            setTokens(tokens, 'worker');
            router.push('/worker/profile');
        } catch {
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    const otpComplete = digits.every(Boolean);

    return (
        <div
            className="w-full max-w-sm mx-auto px-6 py-10 flex flex-col"
            style={{ minHeight: 'calc(100vh - 3.5rem)' }}
        >
            {/* Wordmark */}
            <div className="jale-wordmark mb-10" style={{ fontSize: '1.75rem' }}>Jale</div>

            {step === 'phone' ? (
                <div className="flex flex-col gap-5">
                    <div>
                        <h1
                            className="font-bold leading-tight mb-2"
                            style={{ fontSize: '1.4rem', letterSpacing: '-0.03em', color: 'var(--jale-ink)' }}
                        >
                            {t('title')}
                        </h1>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--jale-ink-2)' }}>
                            {t('phone_label')}
                        </p>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                            Phone number
                        </label>
                        <Input
                            type="tel"
                            placeholder="+1 (555) 000-0000"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            inputMode="tel"
                            autoComplete="tel"
                        />
                    </div>

                    {error && <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>}

                    <Button
                        className="w-full"
                        size="lg"
                        onClick={handleSendOtp}
                        disabled={phone.length < 7 || isLoading}
                    >
                        {isLoading ? tCommon('loading') : t('send_otp')}
                    </Button>

                    <p className="text-center text-xs" style={{ color: 'var(--jale-ink-2)' }}>
                        By continuing you agree to our{' '}
                        <a style={{ color: 'var(--jale-blue-600)', fontWeight: 600 }}>Terms of Service</a>.
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-5">
                    <button
                        onClick={() => { setStep('phone'); setError(null); setDigits(Array(OTP_LENGTH).fill('')); }}
                        className="self-start text-sm font-medium flex items-center gap-1"
                        style={{ background: 'none', border: 0, color: 'var(--jale-ink-2)', cursor: 'pointer', padding: 0 }}
                    >
                        ← {t('back')}
                    </button>

                    <div>
                        <h1
                            className="font-semibold leading-snug mb-1"
                            style={{ fontSize: '1.15rem', letterSpacing: '-0.02em', color: 'var(--jale-ink)' }}
                        >
                            Enter the 6-digit code
                        </h1>
                        <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>
                            Sent to <strong style={{ color: 'var(--jale-ink)' }}>{phone}</strong>
                        </p>
                    </div>

                    {/* OTP boxes */}
                    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${OTP_LENGTH}, 1fr)` }}>
                        {digits.map((d, i) => (
                            <input
                                key={i}
                                ref={(el) => { inputRefs.current[i] = el; }}
                                type="text"
                                inputMode="numeric"
                                maxLength={1}
                                value={d}
                                onChange={(e) => handleDigitChange(i, e.target.value)}
                                onKeyDown={(e) => handleDigitKeyDown(i, e)}
                                onPaste={i === 0 ? handleDigitPaste : undefined}
                                className="text-center font-bold rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] focus:outline-none focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)] focus:bg-white transition-all duration-150"
                                style={{
                                    height: 56,
                                    fontSize: 22,
                                    color: 'var(--jale-ink)',
                                }}
                            />
                        ))}
                    </div>

                    {error && <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>}

                    <Button
                        className="w-full"
                        size="lg"
                        onClick={handleVerifyOtp}
                        disabled={!otpComplete || isLoading}
                    >
                        {isLoading ? tCommon('loading') : t('verify')}
                    </Button>

                    <p className="text-center text-sm" style={{ color: 'var(--jale-ink-2)' }}>
                        Didn't get a code?{' '}
                        <button
                            style={{ background: 'none', border: 0, color: 'var(--jale-blue-600)', fontWeight: 600, cursor: 'pointer', fontSize: 'inherit', padding: 0 }}
                        >
                            Resend
                        </button>
                    </p>
                </div>
            )}
        </div>
    );
}
