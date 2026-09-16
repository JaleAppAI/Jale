import type { PoolClient } from 'pg';

type InboxRow = {
  application_id: string;
  worker_id: string;
  worker_name: string | null;
  job_id: string;
  job_title: string;
  job_city: string | null;
  job_state_region: string | null;
  job_status: string;
  application_status: string;
  applied_at: string;
  conversation_id: string | null;
  conversation_status: 'open' | 'closed' | null;
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
  // Written only by POST /employer/conversations/{id}/read. The column has
  // existed since migration 028 and nothing wrote it before sprint 26, so on
  // every row older than that endpoint it is NULL -- which this module reads
  // as "never read", i.e. unread whenever the worker has ever written.
  employer_last_read_at: string | null;
};

// `employer_last_read_at` is an INPUT to `unread`, not part of the response:
// the employer UI has no use for the raw stamp, and every field here is a
// field the frontend type (frontend/src/lib/api/employer.ts) has to mirror.
export type InboxItem = Omit<InboxRow, 'employer_last_read_at'> & {
  tab: 'active' | 'closed';
  unread: boolean;
};

export type InboxJob = { job_id: string; title: string; city: string | null; status: string };

export type EmployerInbox = { items: InboxItem[]; jobs: InboxJob[]; unread_count: number };

// One row per non-dismissed application. The first LATERAL picks the
// representative conversation (the open one wins, else the most recent),
// mirroring the job_conversations_open_unique partial index (at most one
// open thread per application). Never-messaged applicants on non-active
// jobs are dropped: no thread exists and the posting is gone.
const INBOX_QUERY = `
  SELECT
    ja.id AS application_id,
    ja.worker_id,
    COALESCE(wp.full_name, u.full_name) AS worker_name,
    j.id AS job_id,
    j.title AS job_title,
    j.city AS job_city,
    j.state_region AS job_state_region,
    j.status AS job_status,
    ja.status AS application_status,
    ja.applied_at,
    c.id AS conversation_id,
    c.status AS conversation_status,
    c.last_message_at,
    c.last_worker_message_at,
    c.employer_last_read_at,
    last_msg.body AS last_message_preview
  FROM job_applications ja
  JOIN jobs j ON j.id = ja.job_id AND j.employer_id = $1
  JOIN users u ON u.id = ja.worker_id
  LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
  LEFT JOIN LATERAL (
    SELECT jc.id, jc.status, jc.last_message_at, jc.last_worker_message_at,
           jc.employer_last_read_at, jc.created_at
    FROM job_conversations jc
    WHERE jc.application_id = ja.id
    ORDER BY (jc.status = 'open') DESC, COALESCE(jc.last_message_at, jc.created_at) DESC
    LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT jcm.body
    FROM job_conversation_messages jcm
    WHERE jcm.conversation_id = c.id
    ORDER BY jcm.created_at DESC
    LIMIT 1
  ) last_msg ON true
  WHERE ja.status <> 'not_interested'
    AND (c.id IS NOT NULL OR j.status = 'active')
  ORDER BY (c.id IS NOT NULL) DESC,
    COALESCE(c.last_message_at, c.created_at, ja.applied_at) DESC
  LIMIT 200`;

// node-postgres returns `timestamptz` as a Date; hand-built fixtures and
// anything that has been through JSON carry the ISO string. Comparing the two
// shapes directly is wrong in both directions (a Date compares by its
// "Thu Sep 10 ..." toString, which is not chronological), so both are
// normalised to epoch millis first -- the same shape
// lib/job-messaging.ts's isWorkerReplyWindowOpen uses.
function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Unread = the worker has written AND the employer has not read since.
//
// Two deliberate asymmetries:
//   * no worker message at all -> never unread, however stale the read stamp
//     is. The badge counts messages waiting on the employer, and an applicant
//     who has only ever been written TO is not one.
//   * the comparison is strict. A read stamped at the exact instant of the
//     worker's last message counts as READ: the read endpoint writes now()
//     after the message has landed, and erring the other way would leave a
//     badge no amount of reading could clear.
function isUnread(
  lastWorkerMessageAt: Date | string | null | undefined,
  employerLastReadAt: Date | string | null | undefined,
): boolean {
  const worker = toMillis(lastWorkerMessageAt);
  if (worker === null) return false;
  const read = toMillis(employerLastReadAt);
  if (read === null) return true;
  return worker > read;
}

function tabFor(row: Omit<InboxRow, 'employer_last_read_at'>): 'active' | 'closed' {
  if (!row.conversation_id) return 'active';
  if (row.conversation_status === 'closed' || row.job_status !== 'active') return 'closed';
  return 'active';
}

export async function listEmployerInbox(
  client: PoolClient,
  employerId: string,
): Promise<EmployerInbox> {
  const result = await client.query<InboxRow>(INBOX_QUERY, [employerId]);
  const items: InboxItem[] = result.rows.map((row) => {
    const { employer_last_read_at: employerLastReadAt, ...rest } = row;
    return {
      ...rest,
      tab: tabFor(rest),
      unread: isUnread(rest.last_worker_message_at, employerLastReadAt),
    };
  });
  // Both tabs. A closed thread the worker answered last is still an unanswered
  // message, and the badge the employer sees is one number over the whole inbox.
  const unreadCount = items.reduce((total, item) => total + (item.unread ? 1 : 0), 0);

  const jobs: InboxJob[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.job_id)) continue;
    seen.add(item.job_id);
    jobs.push({ job_id: item.job_id, title: item.job_title, city: item.job_city, status: item.job_status });
  }

  return { items, jobs, unread_count: unreadCount };
}
