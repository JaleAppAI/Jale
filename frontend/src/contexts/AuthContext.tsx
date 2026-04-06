'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface AuthState {
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    userType: 'worker' | 'employer' | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    setTokens: (tokens: { accessToken: string; idToken: string; refreshToken: string }, userType: 'worker' | 'employer') => void;
    logout: () => Promise<void>;
    refreshTokens: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children, locale }: { children: React.ReactNode; locale: string }) {
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [refreshToken, setRefreshToken] = useState<string | null>(null);
    const [idToken, setIdToken] = useState<string | null>(null);
    const [userType, setUserType] = useState<'worker' | 'employer' | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const rt = sessionStorage.getItem('refreshToken');
        const raw = sessionStorage.getItem('userType');
        const ut = raw === 'worker' || raw === 'employer' ? raw : null;
        if (rt) {
            setRefreshToken(rt);
            setUserType(ut);
            apiFetch('/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: rt, userType: ut }),
            }).then(async (res) => {
                if (res.ok) {
                    const data = await res.json();
                    setAccessToken(data.accessToken);
                    setIdToken(data.idToken);
                } else {
                    sessionStorage.removeItem('refreshToken');
                    sessionStorage.removeItem('userType');
                    setRefreshToken(null);
                    setUserType(null);
                }
            }).catch(() => {
                sessionStorage.removeItem('refreshToken');
                sessionStorage.removeItem('userType');
                setRefreshToken(null);
                setUserType(null);
            }).finally(() => setIsLoading(false));
        } else {
            setIsLoading(false);
        }
    }, []);

    const setTokens = (tokens: { accessToken: string; idToken: string; refreshToken: string }, ut: 'worker' | 'employer') => {
        setAccessToken(tokens.accessToken);
        setIdToken(tokens.idToken);
        setRefreshToken(tokens.refreshToken);
        setUserType(ut);
        sessionStorage.setItem('refreshToken', tokens.refreshToken);
        sessionStorage.setItem('userType', ut);
    };

    const logout = async () => {
        await apiFetch('/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ accessToken, refreshToken, userType }),
        }).catch(() => {});
        sessionStorage.removeItem('refreshToken');
        sessionStorage.removeItem('userType');
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        setUserType(null);
        window.location.href = `/${locale}/`;
    };

    const refreshTokens = async () => {
        if (!refreshToken) return;
        const res = await apiFetch('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken, userType }) });
        if (!res.ok) {
            sessionStorage.removeItem('refreshToken');
            sessionStorage.removeItem('userType');
            setAccessToken(null);
            setIdToken(null);
            setRefreshToken(null);
            setUserType(null);
            return;
        }
        const data = await res.json();
        setAccessToken(data.accessToken);
        setIdToken(data.idToken);
    };

    return (
        <AuthContext.Provider value={{
            accessToken, refreshToken, idToken, userType,
            isAuthenticated: !!idToken,
            isLoading,
            setTokens, logout, refreshTokens,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
