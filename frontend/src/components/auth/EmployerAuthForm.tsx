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
        } catch {
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div>
            <h1>{t('title')}</h1>
            <input
                type="email"
                placeholder={t('email_label')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
            />
            <input
                type="password"
                placeholder={t('password_label')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
            />
            {error && <p>{error}</p>}
            <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={handleSignIn} disabled={isLoading}>
                {isLoading ? tCommon('loading') : t('sign_in')}
            </Button>
        </div>
    );
}
