import type { PoolClient } from 'pg';

type InboxRow = {
  application_id: string;
  worker_id: string;
  worker_name: string | null;
  job_id: string;
  job_title: string;
  job_status: string;
  application_status: string;
  applied_at: string;
  conversation_id: string | null;
  conversation_status: 'open' | 'closed' | null;
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
};

export type InboxItem = InboxRow & { tab: 'active' | 'closed' };

export type InboxJob = { job_id: string; title: string; status: string };

export type EmployerInbox = { items: InboxItem[]; jobs: InboxJob[] };

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
    j.status AS job_status,
    ja.status AS application_status,
    ja.applied_at,
    c.id AS conversation_id,
    c.status AS conversation_status,
    c.last_message_at,
    c.last_worker_message_at,
    last_msg.body AS last_message_preview
  FROM job_applications ja
  JOIN jobs j ON j.id = ja.job_id AND j.employer_id = $1
  JOIN users u ON u.id = ja.worker_id
  LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
  LEFT JOIN LATERAL (
    SELECT jc.id, jc.status, jc.last_message_at, jc.last_worker_message_at, jc.created_at
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

function tabFor(row: InboxRow): 'active' | 'closed' {
  if (!row.conversation_id) return 'active';
  if (row.conversation_status === 'closed' || row.job_status !== 'active') return 'closed';
  return 'active';
}

export async function listEmployerInbox(
  client: PoolClient,
  employerId: string,
): Promise<EmployerInbox> {
  const result = await client.query<InboxRow>(INBOX_QUERY, [employerId]);
  const items: InboxItem[] = result.rows.map((row) => ({ ...row, tab: tabFor(row) }));

  const jobs: InboxJob[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.job_id)) continue;
    seen.add(item.job_id);
    jobs.push({ job_id: item.job_id, title: item.job_title, status: item.job_status });
  }

  return { items, jobs };
}
