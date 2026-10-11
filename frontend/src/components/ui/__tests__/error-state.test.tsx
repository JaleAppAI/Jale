import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ReportProblemContext } from '@/components/report/report-problem-context';
import { ErrorState } from '../error-state';
import type { ErrorKind } from '@/lib/api/errors';

/**
 * `ErrorState` outside the report provider must render exactly what it
 * rendered before "Report a problem" existed: these snapshots were recorded
 * against that code, before the report action was added.
 */

const KINDS: ErrorKind[] = ['offline', 'timeout', 'rate_limited', 'server', 'unknown', 'not_found', 'forbidden'];

describe('ErrorState outside the report provider', () => {
    for (const kind of KINDS) {
        it(`renders ${kind} as before, with and without the actions`, () => {
            const bare = renderIntl(<ErrorState kind={kind} />);
            expect(bare.container.innerHTML).toMatchSnapshot('bare');
            bare.unmount();

            const full = renderIntl(<ErrorState kind={kind} onRetry={() => {}} backHref="/worker/home" compact />);
            expect(full.container.innerHTML).toMatchSnapshot('retry-and-back');
            full.unmount();
        });
    }
});

/**
 * Inside the report provider, every in-screen ErrorState offers "Report this
 * problem" next to "Try again" -- wherever "Try again" shows, except offline,
 * where the report could not be sent either. It reports with the error's kind.
 */
describe('ErrorState inside the report provider', () => {
    function renderInside(ui: ReactElement) {
        const openReport = vi.fn();
        const value = { openReport, registerCategoryHint: vi.fn(() => () => {}) };
        const view = renderIntl(<ReportProblemContext value={value}>{ui}</ReportProblemContext>);
        return { openReport, ...view };
    }

    for (const kind of KINDS) {
        it(`renders ${kind} with the report action exactly where it belongs`, () => {
            const bare = renderInside(<ErrorState kind={kind} />);
            expect(bare.container.innerHTML).toMatchSnapshot('inside-bare');
            bare.unmount();

            const full = renderInside(<ErrorState kind={kind} onRetry={() => {}} backHref="/worker/home" compact />);
            expect(full.container.innerHTML).toMatchSnapshot('inside-retry-and-back');
            full.unmount();
        });
    }

    it('offers the action wherever "Try again" shows, except offline', () => {
        const offered = KINDS.filter((kind) => {
            const view = renderInside(<ErrorState kind={kind} onRetry={() => {}} />);
            const has = screen.queryByRole('button', { name: message('report_common.error_action') }) !== null;
            const retry = screen.queryByRole('button', { name: message('common.retry') }) !== null;
            view.unmount();
            expect(has).toBe(retry && kind !== 'offline');
            return has;
        });
        expect(offered).toEqual(['timeout', 'rate_limited', 'server', 'unknown']);
    });

    it('does not offer it without "Try again"', () => {
        renderInside(<ErrorState kind="server" />);
        expect(screen.queryByRole('button', { name: message('report_common.error_action') })).toBeNull();
    });

    it('opens the report with the kind of the error', async () => {
        const user = userEvent.setup();
        const { openReport } = renderInside(<ErrorState kind="rate_limited" onRetry={() => {}} />);
        await user.click(screen.getByRole('button', { name: message('report_common.error_action') }));
        expect(openReport).toHaveBeenCalledWith({ error: { kind: 'rate_limited' } });
    });

    it('in Spanish too', () => {
        const value = { openReport: vi.fn(), registerCategoryHint: vi.fn(() => () => {}) };
        renderIntl(
            <ReportProblemContext value={value}>
                <ErrorState kind="server" onRetry={() => {}} />
            </ReportProblemContext>,
            'es',
        );
        expect(screen.getByRole('button', { name: 'Reportar este problema' })).toBeInTheDocument();
    });
});

describe('ErrorState with its own report handler', () => {
    it('uses the handler instead of the provider, under the same rule', async () => {
        const user = userEvent.setup();
        const onReport = vi.fn();
        const { unmount } = renderIntl(<ErrorState kind="server" onRetry={() => {}} onReport={onReport} />);
        await user.click(screen.getByRole('button', { name: message('report_common.error_action') }));
        expect(onReport).toHaveBeenCalledTimes(1);
        unmount();

        renderIntl(<ErrorState kind="offline" onRetry={() => {}} onReport={onReport} />);
        expect(screen.queryByRole('button', { name: message('report_common.error_action') })).toBeNull();
    });
});
