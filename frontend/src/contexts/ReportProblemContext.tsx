'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ReportSheet } from '@/components/report/ReportSheet';
import type { ReportedError, ReportSession } from '@/components/report/types';
import {
    ReportProblemContext,
    type OpenReportOptions,
    type ReportProblemApi,
    type ReportProblemValue,
} from '@/components/report/report-problem-context';
import {
    installErrorCapture,
    recordError,
    recordScreen,
    routePattern,
} from '@/components/report/seams/report-context';
import type { CaptureResult } from '@/components/report/seams/report-capture';
import type { ReportConfig } from '@/lib/api/reports';
import {
    preselectCategory,
    resolveReportRole,
    type ReportCategory,
} from '@/lib/report/categories';

export {
    useOptionalReportProblem,
    useReportCategoryHint,
    type OpenReportOptions,
    type ReportProblemApi,
} from '@/components/report/report-problem-context';

/**
 * "Report a problem", from anywhere in the app.
 *
 * Same arrangement as `ConversationDrawerContext` and `PostJobContext`: the
 * provider owns the surface (it mounts the report sheet) and hands the app one
 * verb, `openReport`. Entry points -- the shell headers, the sign-in screens,
 * the error screens -- call it; nothing else needs to know how a report is
 * made.
 *
 * It also keeps the report context's two always-on feeds running for the
 * session: the error listeners, and the screens visited.
 *
 * `openReport` is stable for the life of the provider, so a provider render
 * (the sheet opening and closing) never re-renders the consumers: the values
 * it reads at the tap -- the route and the session -- come from a ref.
 *
 * The form itself, the API client and the capture all load on first use, so
 * a session that never reports never downloads them.
 */

/** The server still enforces every switch; a failed read must not block the form. */
const OPEN_CONFIG: ReportConfig = { reporting: true, signed_out: true, screenshots: true };
const FAILED_CAPTURE: CaptureResult = { ok: false, reason: 'failed', ms: 0 };

/** `useParams()` carries the locale segment, which the pathname has already dropped. */
function paramsWithoutLocale(params: Record<string, string | string[]> | null): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(params ?? {})) {
        if (name !== 'locale') out[name] = value;
    }
    return out;
}

function describeError(error: ReportedError): string {
    return ['screen error', error.kind, error.status, error.code].filter((part) => part !== undefined && part !== '').join(' ');
}

export function ReportProblemProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, userType } = useAuth();
    const pathname = usePathname();
    const rawParams = useParams<Record<string, string | string[]>>();
    // A string, so the effects below compare by value: `useParams()` is not
    // guaranteed to keep its identity across renders.
    const paramsKey = JSON.stringify(paramsWithoutLocale(rawParams));

    useEffect(() => installErrorCapture(), []);

    useEffect(() => {
        recordScreen(pathname, JSON.parse(paramsKey) as Record<string, string | string[]>);
    }, [pathname, paramsKey]);

    const latest = useRef({ pathname, paramsKey, isAuthenticated, userType });
    useEffect(() => {
        latest.current = { pathname, paramsKey, isAuthenticated, userType };
    });

    // Category hints from mounted components. The latest one wins; a ref, so
    // registering one never re-renders anything.
    const hintsRef = useRef<Array<{ id: number; category: ReportCategory }>>([]);
    const hintIdRef = useRef(0);
    const registerCategoryHint = useCallback((category: ReportCategory) => {
        hintIdRef.current += 1;
        const id = hintIdRef.current;
        hintsRef.current = [...hintsRef.current, { id, category }];
        return () => {
            hintsRef.current = hintsRef.current.filter((hint) => hint.id !== id);
        };
    }, []);

    const [session, setSession] = useState<ReportSession | null>(null);
    const openRef = useRef(false);
    const sessionIdRef = useRef(0);

    const openReport = useCallback((options: OpenReportOptions = {}) => {
        // One form at a time: a second open would throw away what is typed.
        if (openRef.current) return;

        const now = latest.current;
        const signedInRole = now.isAuthenticated ? now.userType : null;
        const pattern = routePattern(now.pathname, JSON.parse(now.paramsKey) as Record<string, string | string[]>).pattern;
        const role = resolveReportRole({ userType: signedInRole, shellRole: options.role ?? null, pattern });
        const hints = hintsRef.current;
        const category = preselectCategory({
            pattern,
            role,
            explicit: options.category,
            hint: hints.length > 0 ? hints[hints.length - 1].category : null,
        });
        if (options.error) {
            recordError({ kind: options.error.status !== undefined ? 'api' : 'error', message: describeError(options.error) });
        }

        // On the tap, in the same tick: the picture of the screen and the
        // switches. The sheet opens alongside; it is marked out of the capture.
        const capture = import('@/components/report/seams/report-capture')
            .then((module) => module.captureViewport())
            .catch(() => FAILED_CAPTURE);
        const config = import('@/lib/api/reports')
            .then((module) => module.getReportConfig())
            .catch(() => OPEN_CONFIG);

        openRef.current = true;
        sessionIdRef.current += 1;
        setSession({
            id: sessionIdRef.current,
            role,
            signedIn: signedInRole !== null,
            category,
            capture,
            config,
        });
    }, []);

    const closeReport = useCallback(() => {
        openRef.current = false;
        setSession(null);
    }, []);

    const value = useMemo<ReportProblemValue>(
        () => ({ openReport, registerCategoryHint }),
        [openReport, registerCategoryHint],
    );

    return (
        <ReportProblemContext value={value}>
            {children}
            {session ? <ReportSheet key={session.id} session={session} onClose={closeReport} /> : null}
        </ReportProblemContext>
    );
}

/** The verb. Throws outside the provider, like its siblings. */
export function useReportProblem(): ReportProblemApi {
    const ctx = use(ReportProblemContext);
    if (!ctx) throw new Error('useReportProblem must be used inside ReportProblemProvider');
    return ctx;
}
