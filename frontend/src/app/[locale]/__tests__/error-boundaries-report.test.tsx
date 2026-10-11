import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The error boundaries and "Report a problem": the route boundaries record the
 * error they caught and offer the report next to "Try again"; the last-resort
 * boundary, which has no providers at all, shows the support address and the
 * WhatsApp keyword in both languages, and no form.
 */

const { recordError } = vi.hoisted(() => ({ recordError: vi.fn() }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
}));
vi.mock('@/components/report/seams/report-context', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/report/seams/report-context')>()),
    recordError,
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ReportProblemContext } from '@/components/report/report-problem-context';
import { SUPPORT_CONTACT } from '@/lib/support-contact';
import LocaleError from '../error';
import PublicJobError from '../j/[code]/error';
import GlobalError from '../../global-error';

function inside(ui: ReactElement) {
    const openReport = vi.fn();
    const view = renderIntl(
        <ReportProblemContext value={{ openReport, registerCategoryHint: () => () => {} }}>{ui}</ReportProblemContext>,
    );
    return { openReport, ...view };
}

const fakeError = Object.assign(new Error('fake render failure'), { digest: 'fake-digest' });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('[locale]/error', () => {
    it('records the error it caught, once', () => {
        inside(<LocaleError error={fakeError} reset={() => {}} />);
        expect(recordError).toHaveBeenCalledTimes(1);
        expect(recordError).toHaveBeenCalledWith({ kind: 'error', message: expect.stringContaining('fake render failure') });
    });

    it('offers the report next to "Try again", carrying the error', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(<LocaleError error={fakeError} reset={() => {}} />);
        expect(screen.getByRole('button', { name: message('common.retry') })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: message('report_common.error_action') }));
        expect(openReport).toHaveBeenCalledWith({ error: { kind: 'unknown' } });
    });

    it('renders as before outside the provider', () => {
        renderIntl(<LocaleError error={fakeError} reset={() => {}} />);
        expect(screen.queryByRole('button', { name: message('report_common.error_action') })).toBeNull();
        expect(screen.getByRole('button', { name: message('common.retry') })).toBeInTheDocument();
    });
});

describe('j/[code]/error', () => {
    it('records the error and offers the report through ErrorState', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(<PublicJobError error={fakeError} reset={() => {}} />);
        expect(recordError).toHaveBeenCalledWith({ kind: 'error', message: expect.stringContaining('fake render failure') });
        await user.click(screen.getByRole('button', { name: message('report_common.error_action') }));
        expect(openReport).toHaveBeenCalledWith({ error: { kind: 'server' } });
    });
});

describe('global-error', () => {
    const html = renderToStaticMarkup(<GlobalError error={fakeError} reset={() => {}} />);

    it('shows the support address as a mail link, and the WhatsApp keyword, in both languages', () => {
        const mailLinks = html.match(new RegExp(`href="mailto:${SUPPORT_CONTACT.email}"`, 'g')) ?? [];
        expect(mailLinks).toHaveLength(2);
        expect(html).toContain(`“${SUPPORT_CONTACT.whatsappKeyword}”`);
        expect(html).toContain(`«${SUPPORT_CONTACT.whatsappKeyword}»`);
        expect(html).toContain('Need help?');
        expect(html).toContain('¿Necesitas ayuda?');
    });

    it('has no form', () => {
        expect(html).not.toMatch(/<form|<input|<textarea/);
    });
});
