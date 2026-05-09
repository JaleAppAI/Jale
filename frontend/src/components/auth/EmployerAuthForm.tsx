'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerSignIn } from '@/lib/cognito';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function EmployerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const handleSignIn = async () => {
        setError(null);
        setIsLoading(true);
        try {
            const tokens = await employerSignIn(email, password);
            setTokens(tokens, 'employer');
            router.push('/employer/profile');
        } catch (err) {
            console.error('[EmployerAuth] sign-in error:', err);
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex w-full" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
            {/* Left: form */}
            <div className="flex flex-1 flex-col justify-center px-10 py-16 max-w-lg">
                <div className="jale-wordmark mb-8" style={{ fontSize: '1.75rem' }}>Jale</div>

                <h1
                    className="font-bold leading-tight mb-2"
                    style={{ fontSize: 'clamp(1.6rem, 3vw, 1.9rem)', letterSpacing: '-0.03em', color: 'var(--jale-ink)' }}
                >
                    Hire skilled<br />workers, fast.
                </h1>
                <p className="text-sm leading-relaxed mb-8" style={{ color: 'var(--jale-ink-2)' }}>
                    {t('title')}
                </p>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                            Work email
                        </label>
                        <Input
                            type="email"
                            placeholder={t('email_label')}
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            autoComplete="email"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                            Password
                        </label>
                        <Input
                            type="password"
                            placeholder={t('password_label')}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                        />
                    </div>

                    {error && <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>}

                    <Button
                        className="w-full mt-1"
                        size="lg"
                        onClick={handleSignIn}
                        disabled={!email || !password || isLoading}
                    >
                        {isLoading ? tCommon('loading') : t('sign_in')}
                    </Button>

                    <p className="text-center text-sm" style={{ color: 'var(--jale-ink-2)' }}>
                        New here?{' '}
                        <a style={{ color: 'var(--jale-blue-600)', fontWeight: 600 }}>Create an account</a>
                    </p>
                </div>
            </div>

            {/* Right: blue panel — hidden on mobile */}
            <div
                className="hidden md:flex flex-1 flex-col items-center justify-center px-12 py-16 text-white"
                style={{
                    background: 'var(--jale-blue-500)',
                    backgroundImage: 'radial-gradient(circle, rgba(255,255,255,.18) 1px, transparent 1px)',
                    backgroundSize: '24px 24px',
                }}
            >
                <div className="max-w-xs">
                    <div
                        className="font-bold leading-none mb-2"
                        style={{ fontSize: '4rem', letterSpacing: '-0.04em' }}
                    >
                        2.4×
                    </div>
                    <div className="text-lg font-semibold mb-4">faster time-to-hire</div>
                    <p className="text-sm leading-relaxed" style={{ opacity: 0.85 }}>
                        Across our pilot in the Bay Area, employers fill blue-collar roles in 36 hours on average — vs. 3.5 days on legacy job boards.
                    </p>

                    <div className="mt-8 grid grid-cols-2 gap-4">
                        {[
                            { value: '36h', label: 'Avg. fill time' },
                            { value: '98%', label: 'Doc verified' },
                            { value: '500+', label: 'Employers' },
                            { value: '10k+', label: 'Workers' },
                        ].map(({ value, label }) => (
                            <div
                                key={value}
                                className="rounded-xl p-4"
                                style={{ background: 'rgba(255,255,255,.15)' }}
                            >
                                <div className="text-xl font-bold leading-none mb-1">{value}</div>
                                <div className="text-xs font-semibold uppercase tracking-wider opacity-80">{label}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
