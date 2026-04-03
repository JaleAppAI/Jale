'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerVerifyOtp } from '@/lib/cognito';
import { CognitoUser } from 'amazon-cognito-identity-js';
import { Button } from '@/components/ui/button';

export default function WorkerAuthForm() {
    const router = useRouter();
    const t = useTranslations('auth.worker');
    const tCommon = useTranslations('common');
    const { setTokens } = useAuth();

    const [step, setStep] = useState<'phone' | 'otp'>('phone');
    const [phone, setPhone] = useState('');
    const [otp, setOtp] = useState('');
    const [user, setUser] = useState<CognitoUser | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const handleSendOtp = async () => {
        setError(null);
        setIsLoading(true);
        try {
            setUser(await workerSignIn(phone));
            setStep('otp');
        } catch {
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleVerifyOtp = async () => {
        if (!user) return;
        setError(null);
        setIsLoading(true);
        try {
            const tokens = await workerVerifyOtp(user, otp);
            setTokens(tokens, 'worker');
            router.push('/worker/profile');
        } catch {
            setError(tCommon('error'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleBack = () => {
        setStep('phone');
        setError(null);
    };

    return (
        <>
            {step === 'phone' && (
                <div>
                    <h1>{t('title')}</h1>
                    <input
                        type="tel"
                        placeholder={t('phone_label')}
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                    />
                    {error && <p>{error}</p>}
                    <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={handleSendOtp} disabled={isLoading}>
                        {isLoading ? tCommon('loading') : t('send_otp')}
                    </Button>
                </div>
            )}
            {step === 'otp' && (
                <div>
                    <h1>{t('title')}</h1>
                    <input
                        type="text"
                        placeholder={t('otp_label')}
                        value={otp}
                        onChange={(e) => setOtp(e.target.value)}
                    />
                    {error && <p>{error}</p>}
                    <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={handleBack} disabled={isLoading}>
                        {t('back')}
                    </Button>
                    <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={handleVerifyOtp} disabled={isLoading}>
                        {isLoading ? tCommon('loading') : t('verify')}
                    </Button>
                </div>
            )}
        </>
    );
}
