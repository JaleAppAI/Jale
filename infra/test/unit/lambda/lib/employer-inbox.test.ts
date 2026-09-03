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
});
