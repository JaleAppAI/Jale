'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { employerSignIn } from '@/lib/cognito';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

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
        <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6">
            <Card className="w-full max-w-md p-8 md:p-10 space-y-6">
                <h1 className="text-[1.15rem] font-semibold tracking-[-0.02em] leading-[1.45]">{t('title')}</h1>
                <div className="space-y-4">
                    <Input
                        type="email"
                        placeholder={t('email_label')}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    <Input
                        type="password"
                        placeholder={t('password_label')}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                    />
                    {error && <p className="text-sm text-error">{error}</p>}
                    <Button className="w-full" onClick={handleSignIn} disabled={isLoading}>
                        {isLoading ? tCommon('loading') : t('sign_in')}
                    </Button>
                </div>
            </Card>
        </div>
    );
}
