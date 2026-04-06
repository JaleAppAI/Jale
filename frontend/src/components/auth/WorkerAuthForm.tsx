'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { workerSignIn, workerVerifyOtp } from '@/lib/cognito';
import { CognitoUser } from 'amazon-cognito-identity-js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

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
        <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6">
            <Card className="w-full max-w-md p-8 md:p-10 space-y-6">
                <h1 className="text-[1.15rem] font-semibold tracking-[-0.02em] leading-[1.45]">{t('title')}</h1>
                {step === 'phone' && (
                    <div className="space-y-4">
                        <Input
                            type="tel"
                            placeholder={t('phone_label')}
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                        />
                        {error && <p className="text-sm text-error">{error}</p>}
                        <Button className="w-full" onClick={handleSendOtp} disabled={isLoading}>
                            {isLoading ? tCommon('loading') : t('send_otp')}
                        </Button>
                    </div>
                )}
                {step === 'otp' && (
                    <div className="space-y-4">
                        <Input
                            type="text"
                            placeholder={t('otp_label')}
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                        />
                        {error && <p className="text-sm text-error">{error}</p>}
                        <div className="flex gap-3">
                            <Button variant="outline" className="flex-1" onClick={handleBack} disabled={isLoading}>
                                {t('back')}
                            </Button>
                            <Button className="flex-1" onClick={handleVerifyOtp} disabled={isLoading}>
                                {isLoading ? tCommon('loading') : t('verify')}
                            </Button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}
