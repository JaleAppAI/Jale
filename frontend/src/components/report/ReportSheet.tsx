'use client';

import { Component, lazy, Suspense, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Sheet, SheetBody } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { recordError } from './seams/report-context';
import { FallbackPanel } from './FallbackPanel';
import type { ReportSession } from './types';

/*
 * The sheet frame is part of every page; the form inside it is not. The form,
 * the API client and the editor load on the first open (or on a likely tap,
 * through `preloadReportFlow`), so nobody downloads them to read a job.
 */
const loadReportFlow = () => import('./ReportFlow');
const ReportFlow = lazy(() => loadReportFlow().then((module) => ({ default: module.ReportFlow })));

/** Starts loading the form ahead of a likely tap: hover, focus or press. */
export function preloadReportFlow(): void {
    loadReportFlow().catch(() => {
        // Nothing to do: the open itself will try again and show its fallback.
    });
}

/**
 * A form that fails to load (a dropped connection mid-download) or to render
 * leaves the sheet with the support contacts instead of taking the page down
 * with it: the nearest route boundary would replace the screen the person is
 * reporting about.
 */
class FormBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        void info;
        recordError({ kind: 'error', message: error.message });
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

export function ReportSheet({ session, onClose }: { session: ReportSession; onClose: () => void }) {
    const t = useTranslations('report_common');
    // Unsent words keep the scrim from closing the sheet: a stray tap above a
    // bottom sheet is easy. Close and Escape still close it.
    const [dirty, setDirty] = useState(false);

    return (
        <Sheet open onClose={onClose} title={t('title')} closeLabel={t('close')} closeOnBackdrop={!dirty}>
            <FormBoundary fallback={<FallbackPanel reason="load_failed" role={session.role} onClose={onClose} />}>
                <Suspense
                    fallback={
                        <SheetBody>
                            <p role="status" className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink-2)]">
                                <Spinner />
                                {t('loading')}
                            </p>
                        </SheetBody>
                    }
                >
                    <ReportFlow session={session} onClose={onClose} onDirtyChange={setDirty} />
                </Suspense>
            </FormBoundary>
        </Sheet>
    );
}
