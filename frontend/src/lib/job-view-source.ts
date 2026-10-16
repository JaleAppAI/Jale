import type { JobViewSource } from './api/worker';

/** How the worker arrived at a job detail page, read once at mount. */
export type JobViewArrival = { fromFeed: boolean; referralJobId: string | null };

/**
 * The view's source (contract K3.6 #17, CCR-6): the feed when the page was
 * opened from it; the public link when the worker came through this job's
 * public page (web apply -> sign-in leaves the job in the referral stash);
 * otherwise direct. No WhatsApp message links to this page, so the web never
 * says `whatsapp`.
 */
export function jobViewSource(arrival: JobViewArrival, jobId: string): JobViewSource {
  if (arrival.fromFeed) return 'feed';
  if (arrival.referralJobId !== null && arrival.referralJobId === jobId) return 'public_link';
  return 'direct';
}
