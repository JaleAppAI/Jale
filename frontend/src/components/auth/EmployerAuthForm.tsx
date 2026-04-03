'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerSignIn } from '@/lib/cognito';
import { Button } from '@/components/ui/button';

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
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
            <div className="w-full max-w-sm rounded-lg border bg-card p-8 space-y-6">
                <h1 className="text-xl font-semibold">{t('title')}</h1>
                <div className="space-y-4">
                    <input
                        type="email"
                        placeholder={t('email_label')}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                        type="password"
                        placeholder={t('password_label')}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button className="w-full" onClick={handleSignIn} disabled={isLoading}>
                        {isLoading ? tCommon('loading') : t('sign_in')}
                    </Button>
                </div>
            </div>
        </main>
    );
}
