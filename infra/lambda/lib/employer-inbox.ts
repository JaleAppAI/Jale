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
  // existed since migration 028 and nothing wrote it before sprint 26;
  // migration 096 backfilled that history, so a NULL here now means a
  // conversation created since the backfill that has never been read.
  employer_last_read_at: string | null;
  // created_at of the newest INBOUND message, or NULL when the worker has
  // never actually written. This -- NOT last_worker_message_at -- is what the
  // badge compares against; see isUnread below for why.
  last_inbound_message_at: string | null;
};

// `employer_last_read_at` and `last_inbound_message_at` are INPUTS to
// `unread`, not part of the response: the employer UI has no use for either
// raw stamp, and every field here is a field the frontend type
// (frontend/src/lib/api/employer.ts) has to mirror. `last_worker_message_at`
// DOES stay -- the drawer's reply-window hint reads it.
export type InboxItem = Omit<InboxRow, 'employer_last_read_at' | 'last_inbound_message_at'> & {
  tab: 'active' | 'closed';
  unread: boolean;
};

export type InboxJob = { job_id: string; title: string; city: string | null; status: string };

export type EmployerInbox = { items: InboxItem[]; jobs: InboxJob[]; unread_count: number };

// One row per application the employer can still act on. The first LATERAL
// picks the representative conversation (the open one wins, else the most
// recent), mirroring the job_conversations_open_unique partial index (at most
// one open thread per application). Never-messaged applicants on non-active
// jobs are dropped: no thread exists and the posting is gone.
//
// A dismissed (not_interested) applicant is dropped ONLY when no conversation
// exists. Inbound WhatsApp routing (lib/job-messaging.ts:657-688) targets a
// thread by worker_id + status='open' and never consults the application's
// status, so the worker's replies keep arriving in the thread of somebody the
// employer dismissed. Since the drawer reads this same list, filtering those
// rows out made that thread unreachable from every employer surface while
// messages kept landing in it. The row carries application_status, so the UI
// can still show it as dismissed.
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
    last_inbound.created_at AS last_inbound_message_at,
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
  -- A SIBLING of last_msg, not a filter on it: the preview is the newest
  -- message in either direction, the badge is the newest one FROM the worker.
  -- Those are different rows whenever the employer has replied last, so one
  -- join cannot serve both. Served by idx_job_messages_conversation_created
  -- (025:44-45) with direction as a filter.
  LEFT JOIN LATERAL (
    SELECT jcm.created_at
    FROM job_conversation_messages jcm
    WHERE jcm.conversation_id = c.id
      AND jcm.direction = 'inbound'
    ORDER BY jcm.created_at DESC
    LIMIT 1
  ) last_inbound ON true
  WHERE (ja.status <> 'not_interested' OR c.id IS NOT NULL)
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

// Unread = a message ARRIVED from the worker AND the employer has not read
// since.
//
// ── WHY NOT last_worker_message_at ───────────────────────────────────────
// Because that column does not mean "the worker sent a message". It means
// "the worker engaged". `openWorkerConversation` (lib/job-messaging.ts:813)
// stamps it when the worker taps "Open conversation" and inserts NO message
// row -- the only three writers of job_conversation_messages are :503
// (employer outbound), :617 (system outbound) and :692 (worker inbound).
// Keyed on it, the badge announced a message that does not exist, and the
// preview next to that badge showed the EMPLOYER's own last text.
//
// So the badge keys on the newest INBOUND message instead, and
// last_worker_message_at is left exactly as it is: the 24-hour Twilio reply
// window (isWorkerReplyWindowOpen, job-messaging.ts) is built on that
// "engaged" meaning, and a worker who opens a thread really does re-open the
// send window. Two different questions, two different columns.
//
// Two deliberate asymmetries:
//   * no inbound message at all -> never unread, however stale the read stamp
//     is. The badge counts messages waiting on the employer, and an applicant
//     who has only ever been written TO is not one.
//   * the comparison is strict. A read stamped at the exact instant of the
//     last inbound message counts as READ: the read endpoint writes now()
//     after the message has landed, and erring the other way would leave a
//     badge no amount of reading could clear.
function isUnread(
  lastInboundMessageAt: Date | string | null | undefined,
  employerLastReadAt: Date | string | null | undefined,
): boolean {
  const worker = toMillis(lastInboundMessageAt);
  if (worker === null) return false;
  const read = toMillis(employerLastReadAt);
  if (read === null) return true;
  return worker > read;
}

function tabFor(row: Omit<InboxRow, 'employer_last_read_at' | 'last_inbound_message_at'>): 'active' | 'closed' {
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
    const {
      employer_last_read_at: employerLastReadAt,
      last_inbound_message_at: lastInboundMessageAt,
      ...rest
    } = row;
    return {
      ...rest,
      tab: tabFor(rest),
      unread: isUnread(lastInboundMessageAt, employerLastReadAt),
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
