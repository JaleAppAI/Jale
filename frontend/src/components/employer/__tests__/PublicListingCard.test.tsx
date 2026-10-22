// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The job page's public-listing card: the opt-in switch, then the tracked share
 * link, copy, and QR download. Its share logic is shared with the "Job posted"
 * screen (sprint 29), so this pins what the card does today.
 */

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));

const updateJobPublicListing = vi.fn();
const shareEmployerJob = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  updateJobPublicListing: (...args: unknown[]) => updateJobPublicListing(...args),
  shareEmployerJob: (...args: unknown[]) => shareEmployerJob(...args),
}));

const toDataURL = vi.fn();
vi.mock('qrcode', () => ({ toDataURL: (...args: unknown[]) => toDataURL(...args) }));

import { ApiError } from '@/lib/api/errors';
import { PublicListingCard } from '../PublicListingCard';
import { interpolate, message, renderIntl } from './render-intl';

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const SHARE_URL = 'https://example.test/j/ABC123?s=xyz';
const t = (key: string) => message(`employer_job_listing.${key}`);
const writeText = vi.fn();

function renderCard(over: Partial<Parameters<typeof PublicListingCard>[0]> = {}) {
  const onEnabledChange = vi.fn();
  renderIntl(
    <PublicListingCard
      jobId={JOB_ID}
      initialEnabled={false}
      jobStatus="active"
      jobTitle="Drywall Finisher"
      publicCode="ABC123"
      onEnabledChange={onEnabledChange}
      {...over}
    />,
  );
  return { onEnabledChange };
}

const toggle = () => screen.getByRole('switch', { name: t('title') });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockResolvedValue(undefined);
  updateJobPublicListing.mockResolvedValue({ id: JOB_ID, public_code: 'ABC123', public_listing_enabled: true });
  shareEmployerJob.mockResolvedValue({ code: 'xyz', share_url: SHARE_URL });
  toDataURL.mockResolvedValue('data:image/png;base64,AAAA');
});

describe('PublicListingCard', () => {
  it('turns the listing on with the server answer and reports it to the page', async () => {
    const { onEnabledChange } = renderCard();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(updateJobPublicListing).toHaveBeenCalledWith('test-token', JOB_ID, true);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(t('enabled'))).toBeInTheDocument();
  });

  it('fetches the tracked link on demand, then copies it', async () => {
    renderCard({ initialEnabled: true });
    expect(screen.getByText(interpolate(t('subtitle'), { jobTitle: 'Drywall Finisher' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));

    await waitFor(() => expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument());
    expect(shareEmployerJob).toHaveBeenCalledWith('test-token', JOB_ID);
    fireEvent.click(screen.getByRole('button', { name: t('copy_link') }));
    await waitFor(() => expect(screen.getByRole('button', { name: t('copied') })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
  });

  it('announces the copy to assistive technology, not only by relabelling the button', async () => {
    renderCard({ initialEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));
    await waitFor(() => expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: t('copy_link') }));

    await waitFor(() =>
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain(t('copied')));
  });

  it('downloads a QR code of the tracked link', async () => {
    renderCard({ initialEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));
    await waitFor(() => expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument());

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('download_qr') }));
    });
    await waitFor(() => expect(toDataURL).toHaveBeenCalledWith(SHARE_URL, { width: 512, margin: 2 }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    click.mockRestore();
  });

  it('says the job is not public when the share link is refused, and offers the untracked link', async () => {
    shareEmployerJob.mockRejectedValue(new ApiError(404, 'job_not_found'));
    renderCard({ initialEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));

    await waitFor(() => expect(screen.getByText(t('error_not_public'))).toBeInTheDocument());
    expect(screen.getByText(t('fallback_link_label'))).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\/j\/ABC123$/)).toBeInTheDocument();
  });

  it('names a misconfigured share service in its own words', async () => {
    shareEmployerJob.mockRejectedValue(new ApiError(500, 'share_url_misconfigured'));
    renderCard({ initialEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));
    await waitFor(() => expect(screen.getByText(t('error_misconfigured'))).toBeInTheDocument());
  });

  it('forgets the link when the listing is turned off', async () => {
    updateJobPublicListing.mockResolvedValue({ id: JOB_ID, public_code: 'ABC123', public_listing_enabled: false });
    renderCard({ initialEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: t('get_link') }));
    await waitFor(() => expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument());

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByDisplayValue(SHARE_URL)).not.toBeInTheDocument();
  });

  it('says the public page is closed for a job that is not active', () => {
    renderCard({ jobStatus: 'paused' });
    expect(screen.getByText(t('closed_notice'))).toBeInTheDocument();
  });

  it('explains a failed switch in the card', async () => {
    updateJobPublicListing.mockRejectedValue(new ApiError(418, 'something_unexpected'));
    renderCard();
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(t('toggle_error'))).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });
});
