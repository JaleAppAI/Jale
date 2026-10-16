// @vitest-environment jsdom
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const params = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({ useSearchParams: () => params.current }));
vi.mock('@/lib/api/publicJob', () => ({
  sendOpenBeacon: vi.fn(),
  getReferrerContext: vi.fn(async () => null),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { ReferralContext } from '../ReferralContext';

const stash = () => JSON.parse(sessionStorage.getItem('jale.signup-source') as string);

beforeEach(() => {
  sessionStorage.clear();
  params.current = new URLSearchParams();
});

describe('public job page — the signup source (K3.6)', () => {
  it('stashes the link\'s code as a job-link entry, from the client island', () => {
    params.current = new URLSearchParams('src=flyer');
    renderIntl(<StrictMode><ReferralContext code="ABC123" /></StrictMode>);
    expect(stash()).toMatchObject({ src: 'flyer', entry: 'job_link' });
  });

  it('records a job-link entry without a code', () => {
    renderIntl(<ReferralContext code="ABC123" />);
    expect(stash()).toMatchObject({ src: null, entry: 'job_link' });
  });

  it('never overwrites an earlier touch', () => {
    sessionStorage.setItem('jale.signup-source', JSON.stringify({ src: 'qr', entry: 'app', capturedAt: 'x' }));
    params.current = new URLSearchParams('src=flyer');
    renderIntl(<ReferralContext code="ABC123" />);
    expect(stash()).toMatchObject({ src: 'qr', entry: 'app' });
  });
});
