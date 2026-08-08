'use client';

import * as React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from './icon';
import { feedbackToneClasses, type FeedbackTone } from './inline-feedback';

/**
 * Ambient toast notifications.
 *
 * Toasts are for messages the user does not have to act on and will not miss if
 * they blink out — "Saved", "Link copied", "Connection lost, retrying". Anything
 * the user must read or respond to belongs in an `InlineFeedback` next to the
 * thing it concerns, or in a `Modal`.
 *
 * Deliberately dependency-free: a queue, a timer per toast, and a fixed
 * container.
 */

type ToastTone = Extract<FeedbackTone, 'success' | 'danger' | 'info'>;

type Toast = {
    id: number;
    tone: ToastTone;
    message: string;
};

export type ToastApi = {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
};

/** Long enough to read a short sentence, short enough not to linger. */
const TOAST_TTL_MS = 5000;

/** Beyond three, the stack becomes a wall and starts covering real UI. */
const MAX_TOASTS = 3;

const toneIcons: Record<ToastTone, IconName> = {
    success: 'check',
    danger: 'alert',
    info: 'message',
};

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Access the toast API. Throws when no provider is mounted — a silently
 * swallowed notification is worse than a loud wiring bug.
 */
export function useToast(): ToastApi {
    const api = useContext(ToastContext);
    if (!api) throw new Error('useToast must be used within a <ToastProvider>');
    return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
    const nextIdRef = useRef(0);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const push = useCallback(
        (tone: ToastTone, message: string) => {
            const id = (nextIdRef.current += 1);
            // `slice(-MAX)` drops the oldest; its timer is reaped by the effect
            // below, which is the single owner of timer teardown.
            setToasts((prev) => [...prev, { id, tone, message }].slice(-MAX_TOASTS));
            timersRef.current.set(
                id,
                setTimeout(() => dismiss(id), TOAST_TTL_MS),
            );
        },
        [dismiss],
    );

    // Reap timers for toasts that are gone (dismissed, or pushed off the stack).
    // Keeping this in one place means no code path can leak a timer.
    useEffect(() => {
        const live = new Set(toasts.map((toast) => toast.id));
        const timers = timersRef.current;
        timers.forEach((timer, id) => {
            if (live.has(id)) return;
            clearTimeout(timer);
            timers.delete(id);
        });
    }, [toasts]);

    // Unmount: nothing may fire into a dead tree.
    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            timers.forEach((timer) => clearTimeout(timer));
            timers.clear();
        };
    }, []);

    const api = useMemo<ToastApi>(
        () => ({
            success: (message: string) => push('success', message),
            error: (message: string) => push('danger', message),
            info: (message: string) => push('info', message),
        }),
        [push],
    );

    return (
        <ToastContext.Provider value={api}>
            {children}
            <ToastViewport toasts={toasts} onDismiss={dismiss} />
        </ToastContext.Provider>
    );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
    const t = useTranslations('common');

    return (
        // Always mounted so the live region exists before the first announcement.
        // z-40 is deliberate: under modals (z-50), over the conversation drawer
        // FAB (z-30). On mobile the bottom offset clears the worker tab bar.
        <div
            aria-live="polite"
            className="pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex flex-col gap-2 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-80"
        >
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    role={toast.tone === 'danger' ? 'alert' : undefined}
                    className="anim-fade-in pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3.5 py-3 text-sm shadow-[var(--shadow-card)]"
                >
                    <span
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${feedbackToneClasses[toast.tone]}`}
                    >
                        <Icon name={toneIcons[toast.tone]} />
                    </span>

                    <span className="min-w-0 flex-1 pt-1 font-medium text-[var(--jale-ink)]">{toast.message}</span>

                    <button
                        type="button"
                        onClick={() => onDismiss(toast.id)}
                        aria-label={t('feedback.dismiss')}
                        className="-mr-1 shrink-0 cursor-pointer rounded p-1 leading-none text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                        <Icon name="x" />
                    </button>
                </div>
            ))}
        </div>
    );
}
