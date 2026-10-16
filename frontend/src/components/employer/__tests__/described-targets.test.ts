import { describe, expect, it } from 'vitest';
import type { ConversationTarget } from '@/contexts/ConversationDrawerContext';
import type { InboxItem } from '@/lib/api/employer';
import {
  DESCRIBED_TARGETS_CAP,
  describedRows,
  forgetThreadedTargets,
  rememberDescribedTarget,
  type DescribedTargets,
} from '../described-targets';

const target = (n: number, over: Partial<ConversationTarget> = {}): ConversationTarget => ({
  application_id: `app-${n}`,
  worker_id: `w-${n}`,
  job_id: 'job-1',
  worker_name: `Prueba ${n}`,
  job_title: 'Roofer',
  job_city: null,
  applied_at: '2026-09-01T00:00:00Z',
  ...over,
});

const item = (applicationId: string, conversationId: string | null): InboxItem => ({
  application_id: applicationId,
  worker_id: 'w',
  worker_name: null,
  job_id: 'job-1',
  job_title: 'Roofer',
  job_city: null,
  job_state_region: null,
  job_status: 'active',
  application_status: 'contacted',
  applied_at: '2026-09-01T00:00:00Z',
  conversation_id: conversationId,
  conversation_status: conversationId ? 'open' : null,
  last_message_at: null,
  last_worker_message_at: null,
  last_message_preview: null,
  tab: 'active',
  unread: false,
});

const empty: DescribedTargets = new Map();

describe('rememberDescribedTarget', () => {
  it('keeps at most 20, evicting the oldest', () => {
    let map = empty;
    for (let n = 1; n <= DESCRIBED_TARGETS_CAP + 1; n += 1) map = rememberDescribedTarget(map, target(n));
    expect(map.size).toBe(20);
    expect(map.has('app-1')).toBe(false);
    expect(map.has('app-21')).toBe(true);
  });

  it('moves a re-opened applicant to the newest end instead of duplicating it', () => {
    let map = rememberDescribedTarget(rememberDescribedTarget(empty, target(1)), target(2));
    map = rememberDescribedTarget(map, target(1, { job_title: 'Framer' }));
    expect([...map.keys()]).toEqual(['app-2', 'app-1']);
    expect(map.get('app-1')?.job_title).toBe('Framer');
  });
});

describe('forgetThreadedTargets', () => {
  it('drops an applicant the inbox lists with a thread, keeps a threadless one', () => {
    const map = rememberDescribedTarget(rememberDescribedTarget(empty, target(1)), target(2));
    const next = forgetThreadedTargets(map, [item('app-1', 'conv-1'), item('app-2', null)]);
    expect([...next.keys()]).toEqual(['app-2']);
  });

  it('returns the same map when nothing drops (no needless re-render)', () => {
    const map = rememberDescribedTarget(empty, target(1));
    expect(forgetThreadedTargets(map, [item('app-9', 'conv-9')])).toBe(map);
  });
});

describe('describedRows', () => {
  it('lists drawable entries newest first, skipping thread rows and id-only requests', () => {
    let map = empty;
    map = rememberDescribedTarget(map, target(1));
    map = rememberDescribedTarget(map, target(2, { job_title: undefined }));
    map = rememberDescribedTarget(map, target(3));
    map = rememberDescribedTarget(map, target(4));
    const rows = describedRows(map, [item('app-4', 'conv-4')]);
    expect(rows.map((r) => r.application_id)).toEqual(['app-3', 'app-1']);
  });
});
