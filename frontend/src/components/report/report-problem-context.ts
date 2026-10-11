'use client';

import { createContext, use, useEffect } from 'react';
import type { ReportCategory, SignedInRole } from '@/lib/report/categories';
import type { ReportedError } from './types';

/**
 * The "Report a problem" context object and its two light hooks.
 *
 * Kept apart from the provider (`@/contexts/ReportProblemContext`) on purpose:
 * primitives such as `ErrorState` and the header entry points read this
 * context, and importing the provider module would pull the sheet, the auth
 * context and the router hooks into every one of them. This file imports
 * nothing but React and types.
 */

export type OpenReportOptions = {
    /** Start on this category instead of the one the screen implies. */
    category?: ReportCategory;
    /** The error the screen was showing. It goes into the report's recent errors. */
    error?: ReportedError;
    /** The role a signed-out screen implies, such as a sign-in screen's variant. */
    role?: SignedInRole;
};

export type ReportProblemApi = { openReport: (options?: OpenReportOptions) => void };

export type ReportProblemValue = ReportProblemApi & {
    registerCategoryHint: (category: ReportCategory) => () => void;
};

export const ReportProblemContext = createContext<ReportProblemValue | null>(null);

/**
 * The verb, or null outside the provider. For primitives and shells that also
 * render on their own (tests, loading states): without a provider they render
 * exactly as they did before reporting existed.
 */
export function useOptionalReportProblem(): ReportProblemApi | null {
    return use(ReportProblemContext);
}

/**
 * Registers the category a report opened from this screen should start on,
 * while the calling component is mounted -- for screens a URL cannot describe,
 * such as the apply flow inside a job page. Null registers nothing. A hint that
 * does not belong to the reporter's role is ignored.
 */
export function useReportCategoryHint(category: ReportCategory | null | undefined): void {
    const register = use(ReportProblemContext)?.registerCategoryHint;
    useEffect(() => {
        if (!register || !category) return;
        return register(category);
    }, [register, category]);
}
