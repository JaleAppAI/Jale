import { describe, expect, it } from 'vitest';
import { canApplyToJob, visibleJobStatusBadge } from '../jobStatusDisplay';

describe('visibleJobStatusBadge', () => {
  it('names only closed and filled', () => {
    expect(visibleJobStatusBadge('closed')).toBe('closed');
    expect(visibleJobStatusBadge('filled')).toBe('filled');
  });

  it('renders nothing for active, absent, and anything unexpected', () => {
    expect(visibleJobStatusBadge('active')).toBeNull();
    expect(visibleJobStatusBadge(undefined)).toBeNull();
    // The API coalesces paused server-side; if one ever leaks through, the
    // allowlist still suppresses it rather than painting a raw i18n key.
    expect(visibleJobStatusBadge('paused')).toBeNull();
  });
});

describe('canApplyToJob', () => {
  const base = { already_applied: false, missing_docs: [] as unknown[] };

  it('allows an active job with docs complete and no application', () => {
    expect(canApplyToJob({ ...base, status: 'active' })).toBe(true);
  });

  it('treats absent status as active (older payloads)', () => {
    expect(canApplyToJob({ ...base })).toBe(true);
  });

  it('blocks non-active statuses (race protection: job closed mid-session)', () => {
    expect(canApplyToJob({ ...base, status: 'closed' })).toBe(false);
    expect(canApplyToJob({ ...base, status: 'filled' })).toBe(false);
  });

  it('keeps the existing gates', () => {
    expect(canApplyToJob({ ...base, already_applied: true, status: 'active' })).toBe(false);
    expect(canApplyToJob({ ...base, missing_docs: ['resume'], status: 'active' })).toBe(false);
  });
});
