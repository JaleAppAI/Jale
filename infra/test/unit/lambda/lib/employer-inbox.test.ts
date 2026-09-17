const mockQuery = jest.fn();
const client: any = { query: mockQuery };

import { listEmployerInbox } from '../../../../lambda/lib/employer-inbox';

const EMPLOYER = 'eeeeeeee-0000-0000-0000-000000000001';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: 'Maria Garcia',
    job_id: 'job-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_state_region: 'TX',
    job_status: 'active',
    application_status: 'pending',
    applied_at: '2026-07-01T00:00:00Z',
    conversation_id: null,
    conversation_status: null,
    last_message_at: null,
    last_worker_message_at: null,
    last_message_preview: null,
    employer_last_read_at: null,
    last_inbound_message_at: null,
    ...overrides,
  };
}

function rowsResult(rows: any[]) {
  return { rows, rowCount: rows.length };
}

describe('listEmployerInbox', () => {
  beforeEach(() => jest.clearAllMocks());

  it('assigns tab=active to an open conversation on an active job', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ conversation_id: 'c-1', conversation_status: 'open' }),
    ]));
    const inbox = await listEmployerInbox(client, EMPLOYER);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].tab).toBe('active');
  });

  it('assigns tab=closed when the conversation is closed', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ conversation_id: 'c-1', conversation_status: 'closed' }),
    ]));
    const inbox = await listEmployerInbox(client, EMPLOYER);
    expect(inbox.items[0].tab).toBe('closed');
  });

  it('assigns tab=closed when the job closed but the conversation is still open', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ conversation_id: 'c-1', conversation_status: 'open', job_status: 'closed' }),
    ]));
    const inbox = await listEmployerInbox(client, EMPLOYER);
    expect(inbox.items[0].tab).toBe('closed');
  });

  it('assigns tab=active to a never-messaged applicant on an active job', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([baseRow()]));
    const inbox = await listEmployerInbox(client, EMPLOYER);
    expect(inbox.items[0].tab).toBe('active');
    expect(inbox.items[0].conversation_id).toBeNull();
  });

  it('derives a deduped jobs list preserving first-seen order', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ application_id: 'app-1', job_id: 'job-1', job_title: 'Line Cook' }),
      baseRow({ application_id: 'app-2', job_id: 'job-2', job_title: 'Dishwasher', job_status: 'closed', conversation_id: 'c-2', conversation_status: 'closed' }),
      baseRow({ application_id: 'app-3', job_id: 'job-1', job_title: 'Line Cook' }),
    ]));
    const inbox = await listEmployerInbox(client, EMPLOYER);
    expect(inbox.jobs).toEqual([
      { job_id: 'job-1', title: 'Line Cook', city: 'Austin', status: 'active' },
      { job_id: 'job-2', title: 'Dishwasher', city: 'Austin', status: 'closed' },
    ]);
  });

  it('excludes not_interested applicants and scopes to the employer in SQL', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerInbox(client, EMPLOYER);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ja\.status <> 'not_interested'/);
    expect(sql).toMatch(/j\.employer_id = \$1/);
    expect(params).toEqual([EMPLOYER]);
  });

  it('drops never-messaged applicants on non-active jobs in SQL', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerInbox(client, EMPLOYER);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/c\.id IS NOT NULL OR j\.status = 'active'/);
  });

  it('picks the open conversation over closed ones as the representative thread', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerInbox(client, EMPLOYER);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY \(jc\.status = 'open'\) DESC/);
  });

  it('orders conversations before never-messaged applicants', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerInbox(client, EMPLOYER);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY\s+\(c\.id IS NOT NULL\) DESC/);
  });

  it('selects the job city and state for each row', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerInbox(client, EMPLOYER);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/j\.city AS job_city/);
    expect(sql).toMatch(/j\.state_region AS job_state_region/);
  });

  // ── T3a: the unread flag and its rollup ─────────────────────────────────
  //
  // `employer_last_read_at` has existed on job_conversations since migration
  // 028 and nothing wrote it before sprint 26, so every pre-existing row
  // arrived NULL. Migration 096 backfills that history; from here on a NULL
  // stamp means a conversation created after the backfill and never read.
  //
  // The comparison is deliberately strict (`>`), so a read stamped at the
  // exact instant of the last inbound message counts as read -- the read
  // endpoint writes `now()` after the message landed, and an off-by-one in
  // the other direction would leave a badge nobody can clear.
  describe('unread', () => {
    // ── WHY NOT last_worker_message_at (round 2) ──────────────────────────
    //
    // That column is a "the worker engaged" signal, NOT "the worker sent a
    // message". `openWorkerConversation` (lib/job-messaging.ts:813) stamps it
    // on the worker tapping "Open conversation" and inserts NO message row --
    // the only three inserts into job_conversation_messages are at :503
    // (employer outbound), :617 (system outbound) and :692 (worker inbound).
    // Deriving the badge from it therefore announced a message that does not
    // exist, and the preview beside that badge showed the EMPLOYER's own last
    // text. The badge now keys on the newest INBOUND message instead.
    //
    // last_worker_message_at is deliberately left alone: the 24-hour Twilio
    // reply window (isWorkerReplyWindowOpen) is built on exactly that
    // "engaged" meaning, and narrowing it would close the send window early.
    it('does NOT mark a thread unread when the worker only OPENED it and never wrote', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          // openWorkerConversation's exact footprint: engaged, no message.
          last_worker_message_at: '2026-09-10T12:00:00Z',
          last_inbound_message_at: null,
          employer_last_read_at: null,
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(false);
      expect(inbox.unread_count).toBe(0);
    });

    it('marks a thread with a real inbound message the employer has never read as unread', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_worker_message_at: '2026-09-10T12:00:00Z',
          last_inbound_message_at: '2026-09-10T12:00:00Z',
          employer_last_read_at: null,
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(true);
    });

    it('is not unread once the employer read AFTER the last inbound message', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: '2026-09-10T12:00:00Z',
          employer_last_read_at: '2026-09-10T12:00:01Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(false);
    });

    it('is unread again when the worker wrote AFTER the employer read', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: '2026-09-10T12:00:02Z',
          employer_last_read_at: '2026-09-10T12:00:01Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(true);
    });

    it('is not unread when no inbound message exists, however long ago it was read', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: null,
          employer_last_read_at: null,
        }),
        baseRow({
          application_id: 'app-2',
          conversation_id: 'c-2',
          conversation_status: 'open',
          last_inbound_message_at: null,
          employer_last_read_at: '2020-01-01T00:00:00Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items.map((i) => i.unread)).toEqual([false, false]);
    });

    it('treats equal timestamps as READ (strict >, not >=)', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: '2026-09-10T12:00:00Z',
          employer_last_read_at: '2026-09-10T12:00:00Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(false);
    });

    // node-postgres hands back `timestamptz` as a Date, not the ISO string the
    // other fixtures use. A comparison written for strings alone would order
    // Date objects by their `toString()` -- "Thu Sep 10 ..." -- which is not
    // chronological. Both shapes, and a mix of the two, must agree.
    it('compares Date values, and a Date against a string, chronologically', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: new Date('2026-09-10T12:00:02Z'),
          employer_last_read_at: new Date('2026-09-10T12:00:01Z'),
        }),
        baseRow({
          application_id: 'app-2',
          conversation_id: 'c-2',
          conversation_status: 'open',
          last_inbound_message_at: new Date('2026-09-10T12:00:01Z'),
          employer_last_read_at: '2026-09-10T12:00:02Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items.map((i) => i.unread)).toEqual([true, false]);
    });

    // A never-messaged applicant has no conversation row at all, so every
    // conversation column comes back NULL from the LEFT JOIN LATERAL.
    it('is not unread for a never-messaged applicant (no conversation row)', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([baseRow()]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].conversation_id).toBeNull();
      expect(inbox.items[0].unread).toBe(false);
    });

    it('counts unread items across BOTH tabs into unread_count', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({ application_id: 'a1', conversation_id: 'c-1', conversation_status: 'open', last_inbound_message_at: '2026-09-10T12:00:00Z' }),
        baseRow({ application_id: 'a2', conversation_id: 'c-2', conversation_status: 'closed', last_inbound_message_at: '2026-09-10T12:00:00Z' }),
        baseRow({ application_id: 'a3', conversation_id: 'c-3', conversation_status: 'open', last_inbound_message_at: '2026-09-10T12:00:00Z', employer_last_read_at: '2026-09-11T00:00:00Z' }),
        baseRow({ application_id: 'a4' }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items.map((i) => i.unread)).toEqual([true, true, false, false]);
      expect(inbox.unread_count).toBe(2);
    });

    it('reports unread_count 0 for an empty inbox', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.unread_count).toBe(0);
    });

    it('selects the employer read stamp and the newest INBOUND message from SQL', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      await listEmployerInbox(client, EMPLOYER);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/c\.employer_last_read_at/);
      // ...and the LATERAL must project it, or the outer reference is a 42703.
      expect(sql).toMatch(/jc\.employer_last_read_at/);
      // The unread source: a sibling LATERAL restricted to inbound messages.
      expect(sql).toMatch(/last_inbound\.created_at AS last_inbound_message_at/);
      expect(sql).toMatch(/jcm\.direction = 'inbound'/);
    });

    // The preview is the newest message of ANY direction; the badge is the
    // newest INBOUND one. Two different rows, so two different LATERALs -- a
    // single join cannot serve both.
    it('keeps the preview LATERAL unfiltered by direction', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      await listEmployerInbox(client, EMPLOYER);
      const [sql] = mockQuery.mock.calls[0];
      const preview = sql.slice(sql.indexOf('last_msg.body'), sql.indexOf(') last_msg'));
      expect(preview).not.toMatch(/direction/);
    });

    // Both are inbox INPUT, not inbox output: the employer UI has no use for
    // either, and every field in this response is a field the frontend type
    // has to mirror.
    it('leaks neither employer_last_read_at nor last_inbound_message_at into the items', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({ conversation_id: 'c-1', conversation_status: 'open', employer_last_read_at: '2026-09-11T00:00:00Z', last_inbound_message_at: '2026-09-10T00:00:00Z' }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(Object.keys(inbox.items[0])).not.toContain('employer_last_read_at');
      expect(Object.keys(inbox.items[0])).not.toContain('last_inbound_message_at');
      // ...but last_worker_message_at stays: the drawer's reply-window hint
      // reads it.
      expect(Object.keys(inbox.items[0])).toContain('last_worker_message_at');
    });
  });

  // ── T3a round 2: a dismissed applicant with a LIVE thread ────────────────
  //
  // Inbound routing (lib/job-messaging.ts:657-688) picks its target by
  // `jc.worker_id` and `jc.status = 'open'` and never looks at the
  // application's status, so a worker's WhatsApp reply still lands in the
  // thread of an applicant the employer marked not-interested. Filtering
  // those rows out of the inbox -- now the drawer's only source -- made that
  // thread unreachable from every employer surface while messages kept
  // arriving in it.
  describe('dismissed applicants', () => {
    it('keeps a not_interested applicant whose conversation still exists', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      await listEmployerInbox(client, EMPLOYER);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/\(ja\.status <> 'not_interested' OR c\.id IS NOT NULL\)/);
      // The other half of the WHERE is untouched: a never-messaged applicant
      // on a dead posting is still dropped.
      expect(sql).toMatch(/\(c\.id IS NOT NULL OR j\.status = 'active'\)/);
    });

    it('still surfaces the dismissal to the UI through application_status', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          application_status: 'not_interested',
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_inbound_message_at: '2026-09-10T12:00:00Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].application_status).toBe('not_interested');
      // Reachable AND badged: the employer has an unanswered message from
      // somebody they dismissed, which is exactly what they need to see.
      expect(inbox.items[0].tab).toBe('active');
      expect(inbox.items[0].unread).toBe(true);
    });
  });
});
