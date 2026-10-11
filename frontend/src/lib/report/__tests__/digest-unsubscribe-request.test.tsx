import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The digest unsubscribe page posts with a raw fetch; it must record that
// request, and never the link's token.
const LINK_TOKEN = 'e1'.repeat(32);

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(`token=${LINK_TOKEN}`) }));

import DigestUnsubscribePage from '@/app/[locale]/digest-unsubscribe/page';
import { clearReportBuffers, collectReportContext, type ReportContextV1 } from '../context';

function context(): Required<ReportContextV1> {
  return collectReportContext({ includeTechnical: true, capture: { outcome: 'none', ms: 0 } }) as Required<ReportContextV1>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearReportBuffers();
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('digest unsubscribe page', () => {
  it('records its POST without the token', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() } as Response);
    const user = userEvent.setup();
    render(<DigestUnsubscribePage />);

    await user.click(screen.getByRole('button', { name: 'button' }));

    await waitFor(() => expect(screen.getByText('success_title')).toBeInTheDocument());
    expect(context().requests.map(({ m, p, s }) => ({ m, p, s }))).toEqual([
      { m: 'POST', p: '/public/employer-digest/unsubscribe', s: 200 },
    ]);
    expect(JSON.stringify(context())).not.toContain(LINK_TOKEN);
  });

  it('records a request that never reached the server as status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<DigestUnsubscribePage />);

    await user.click(screen.getByRole('button', { name: 'button' }));

    await waitFor(() => expect(context().requests.map((r) => r.s)).toEqual([0]));
    // The page still offers a retry: recording changed nothing it does.
    expect(screen.getByRole('button', { name: 'button' })).toBeInTheDocument();
  });
});
