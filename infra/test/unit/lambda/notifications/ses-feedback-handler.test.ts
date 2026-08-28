import type { SNSEvent } from 'aws-lambda';

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({
    connect: jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease })),
  })),
}));

import { handler } from '../../../../lambda/notifications/ses-feedback-handler';

const EMPLOYER_ID = '11111111-2222-4333-8444-555555555555';
const MESSAGE_ID = '0100018f-1234-abcd-0000-000000000000';
const RECIPIENT = 'employer@example.test';

function snsEvent(message: unknown, raw?: string): SNSEvent {
  return {
    Records: [{
      EventSource: 'aws:sns',
      Sns: { Message: raw !== undefined ? raw : JSON.stringify(message) },
    }],
  } as unknown as SNSEvent;
}

function bounce(bounceType: string, options: { messageId?: string; useLegacyField?: boolean } = {}) {
  const key = options.useLegacyField ? 'notificationType' : 'eventType';
  return {
    [key]: 'Bounce',
    bounce: { bounceType, bouncedRecipients: [{ emailAddress: RECIPIENT }] },
    mail: { messageId: options.messageId ?? MESSAGE_ID, destination: [RECIPIENT] },
  };
}

function complaint() {
  return {
    eventType: 'Complaint',
    complaint: { complainedRecipients: [{ emailAddress: RECIPIENT }] },
    mail: { messageId: MESSAGE_ID, destination: [RECIPIENT] },
  };
}

/** email_outbox lookup answers with `row`; the definer answers with `disabled`. */
function configureDb(options: { row?: { source_type: string; source_id: string } | null; disabled?: number } = {}) {
  const row = options.row === undefined
    ? { source_type: 'employer_digest', source_id: EMPLOYER_ID }
    : options.row;
  mockQuery.mockImplementation((sql: string) => {
    if (String(sql).includes('FROM email_outbox')) {
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    if (String(sql).includes('disable_digest_for_employer')) {
      return Promise.resolve({ rows: [{ disabled: options.disabled ?? 1 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
}

function definerCall() {
  return mockQuery.mock.calls.find((call) => String(call[0]).includes('disable_digest_for_employer'));
}

function loggedText(...spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => (call as unknown[]).map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

describe('SES feedback handler', () => {
  let errorLog: jest.SpyInstance;
  let infoLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    configureDb();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
    infoLog.mockRestore();
  });

  // ── Acts ──────────────────────────────────────────────────────────────────

  it('switches the digest off for a PERMANENT bounce on a digest message', async () => {
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ processed: 1, disabled: 1, transient: 0, unknownMessage: 0 });

    const lookup = mockQuery.mock.calls.find((call) => String(call[0]).includes('FROM email_outbox'));
    expect(lookup![0]).toContain('WHERE ses_message_id = $1');
    expect(lookup![1]).toEqual([MESSAGE_ID]);

    expect(definerCall()).toBeDefined();
    expect(String(definerCall()![0])).toContain('public.disable_digest_for_employer');
    expect(definerCall()![1]).toEqual([EMPLOYER_ID]);
  });

  it('switches the digest off for a COMPLAINT, regardless of any bounce field', async () => {
    const summary = await handler(snsEvent(complaint()));
    expect(summary.disabled).toBe(1);
    expect(definerCall()).toBeDefined();
  });

  it('reads the identity-notification field name too, not only the configuration-set one', async () => {
    await handler(snsEvent(bounce('Permanent', { useLegacyField: true })));
    expect(definerCall()).toBeDefined();
  });

  it('reports disabled 0 when the employer had already opted out, without treating it as an error', async () => {
    configureDb({ disabled: 0 });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ processed: 1, disabled: 0 });
    expect(definerCall()).toBeDefined();
  });

  // ── Declines to act ───────────────────────────────────────────────────────

  it('counts a TRANSIENT bounce and never reaches the database', async () => {
    const summary = await handler(snsEvent(bounce('Transient')));
    expect(summary).toMatchObject({ processed: 1, disabled: 0, transient: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('counts a delivery event and never reaches the database', async () => {
    const summary = await handler(snsEvent({
      eventType: 'Delivery', mail: { messageId: MESSAGE_ID },
    }));
    expect(summary).toMatchObject({ transient: 1, disabled: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('writes nothing for a message id no outbox row claims', async () => {
    configureDb({ row: null });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ unknownMessage: 1, disabled: 0 });
    expect(definerCall()).toBeUndefined();
    expect(loggedText(errorLog)).toContain('ses_feedback_unknown_message');
  });

  it('writes nothing when the bounced message was not a digest', async () => {
    configureDb({ row: { source_type: 'billing_pause', source_id: EMPLOYER_ID } });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ notDigest: 1, disabled: 0 });
    expect(definerCall()).toBeUndefined();
  });

  it('counts a malformed notification and returns normally instead of retrying it forever', async () => {
    const summary = await handler(snsEvent(undefined, 'not json at all'));
    expect(summary).toMatchObject({ malformed: 1, disabled: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(loggedText(errorLog)).toContain('ses_feedback_malformed');
  });

  it('treats a notification with no message id as malformed', async () => {
    const summary = await handler(snsEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' } }));
    expect(summary).toMatchObject({ malformed: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats a notification with no event type as malformed', async () => {
    const summary = await handler(snsEvent({ mail: { messageId: MESSAGE_ID } }));
    expect(summary).toMatchObject({ malformed: 1 });
  });

  it('returns an empty summary and opens no connection for an event with no records', async () => {
    const summary = await handler({ Records: [] } as unknown as SNSEvent);
    expect(summary).toMatchObject({ processed: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── Privacy ───────────────────────────────────────────────────────────────

  /**
   * A bounce log is the one place a complete list of dead employer addresses
   * would otherwise accumulate in CloudWatch. Message id and event type are
   * enough to trace any incident back to a row.
   */
  it('never logs the recipient address, on any path', async () => {
    await handler(snsEvent(bounce('Permanent')));
    configureDb({ row: null });
    await handler(snsEvent(bounce('Permanent')));
    await handler(snsEvent(bounce('Transient')));
    await handler(snsEvent(complaint()));

    const logged = loggedText(errorLog, infoLog);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).toContain(MESSAGE_ID);
  });

  // ── Failure posture ───────────────────────────────────────────────────────

  it('throws on a database failure so the Lambda service retries and the alarm fires', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    await expect(handler(snsEvent(bounce('Permanent')))).rejects.toThrow('connection terminated');
    expect(loggedText(errorLog)).toContain('ses_feedback_failed');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('releases the connection on the happy path too', async () => {
    await handler(snsEvent(bounce('Permanent')));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
