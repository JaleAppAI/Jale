import { describe, expect, it } from 'vitest';
import { jobViewSource } from '../job-view-source';

describe('jobViewSource (CCR-6)', () => {
  it('prefers the feed', () => {
    expect(jobViewSource({ fromFeed: true, referralJobId: 'job-1' }, 'job-1')).toBe('feed');
  });
  it('says public_link when the referral stash names this job', () => {
    expect(jobViewSource({ fromFeed: false, referralJobId: 'job-1' }, 'job-1')).toBe('public_link');
  });
  it('says direct otherwise, including a stash for another job', () => {
    expect(jobViewSource({ fromFeed: false, referralJobId: 'job-2' }, 'job-1')).toBe('direct');
    expect(jobViewSource({ fromFeed: false, referralJobId: null }, 'job-1')).toBe('direct');
  });
});
