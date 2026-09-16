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
  // 028 and nothing has ever written it, so EVERY pre-existing row arrives
  // NULL. That is the case the first test pins: a thread the worker has
  // written to and the employer has never marked read is unread.
  //
  // The comparison is deliberately strict (`>`), so a read stamped at the
  // exact instant of the worker's last message counts as read -- the read
  // endpoint writes `now()` after the message landed, and an off-by-one in
  // the other direction would leave a badge nobody can clear.
  describe('unread', () => {
    it('marks a worker-messaged conversation the employer has never read as unread', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_worker_message_at: '2026-09-10T12:00:00Z',
          employer_last_read_at: null,
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(true);
    });

    it('is not unread once the employer read AFTER the last worker message', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_worker_message_at: '2026-09-10T12:00:00Z',
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
          last_worker_message_at: '2026-09-10T12:00:02Z',
          employer_last_read_at: '2026-09-10T12:00:01Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].unread).toBe(true);
    });

    it('is not unread when the worker has never written, however long ago it was read', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({
          conversation_id: 'c-1',
          conversation_status: 'open',
          last_worker_message_at: null,
          employer_last_read_at: null,
        }),
        baseRow({
          application_id: 'app-2',
          conversation_id: 'c-2',
          conversation_status: 'open',
          last_worker_message_at: null,
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
          last_worker_message_at: '2026-09-10T12:00:00Z',
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
          last_worker_message_at: new Date('2026-09-10T12:00:02Z'),
          employer_last_read_at: new Date('2026-09-10T12:00:01Z'),
        }),
        baseRow({
          application_id: 'app-2',
          conversation_id: 'c-2',
          conversation_status: 'open',
          last_worker_message_at: new Date('2026-09-10T12:00:01Z'),
          employer_last_read_at: '2026-09-10T12:00:02Z',
        }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items.map((i) => i.unread)).toEqual([true, false]);
    });

    // A never-messaged applicant has no conversation row at all, so both
    // columns come back NULL from the LEFT JOIN LATERAL.
    it('is not unread for a never-messaged applicant (no conversation row)', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([baseRow()]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(inbox.items[0].conversation_id).toBeNull();
      expect(inbox.items[0].unread).toBe(false);
    });

    it('counts unread items across BOTH tabs into unread_count', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({ application_id: 'a1', conversation_id: 'c-1', conversation_status: 'open', last_worker_message_at: '2026-09-10T12:00:00Z' }),
        baseRow({ application_id: 'a2', conversation_id: 'c-2', conversation_status: 'closed', last_worker_message_at: '2026-09-10T12:00:00Z' }),
        baseRow({ application_id: 'a3', conversation_id: 'c-3', conversation_status: 'open', last_worker_message_at: '2026-09-10T12:00:00Z', employer_last_read_at: '2026-09-11T00:00:00Z' }),
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

    it('selects the employer read stamp from the representative conversation', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      await listEmployerInbox(client, EMPLOYER);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/c\.employer_last_read_at/);
      // ...and the LATERAL must project it, or the outer reference is a 42703.
      expect(sql).toMatch(/jc\.employer_last_read_at/);
    });

    // The read stamp is inbox INPUT, not inbox output: the employer UI has no
    // use for it and every field in this response is a field the frontend type
    // has to mirror.
    it('does not leak employer_last_read_at into the response items', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([
        baseRow({ conversation_id: 'c-1', conversation_status: 'open', employer_last_read_at: '2026-09-11T00:00:00Z' }),
      ]));
      const inbox = await listEmployerInbox(client, EMPLOYER);
      expect(Object.keys(inbox.items[0])).not.toContain('employer_last_read_at');
    });
  });
});
