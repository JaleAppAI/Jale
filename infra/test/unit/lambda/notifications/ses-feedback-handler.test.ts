import type { SNSEvent } from 'aws-lambda';

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({
    connect: jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease })),
  })),
}));

import { handler } from '../../../../lambda/notifications/ses-feedback-handler';

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

function complaint(feedbackType?: string) {
  return {
    eventType: 'Complaint',
    complaint: {
      complainedRecipients: [{ emailAddress: RECIPIENT }],
      ...(feedbackType ? { complaintFeedbackType: feedbackType } : {}),
    },
    mail: { messageId: MESSAGE_ID, destination: [RECIPIENT] },
  };
}

/**
 * jale_cap.apply_ses_feedback answers with `outcome`: `digest` (the employer's
 * digest was switched off; `changed` rows changed), `not_digest` (with the
 * row's source_type) or `unknown_message`.
 */
function configureDb(options: { outcome?: string; sourceType?: string | null; changed?: number } = {}) {
  const outcome = options.outcome ?? 'digest';
  mockQuery.mockImplementation((sql: string) => {
    if (String(sql).includes('jale_cap.apply_ses_feedback')) {
      return Promise.resolve({
        rows: [{
          outcome,
          source_type: options.sourceType === undefined
            ? (outcome === 'unknown_message' ? null : 'employer_digest')
            : options.sourceType,
          changed: options.changed ?? (outcome === 'digest' ? 1 : 0),
        }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

function capabilityCall() {
  return mockQuery.mock.calls.find((call) => String(call[0]).includes('jale_cap.apply_ses_feedback'));
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

  it('switches the digest off for a PERMANENT bounce on a digest message, in one capability call', async () => {
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ processed: 1, disabled: 1, transient: 0, unknownMessage: 0 });

    // The job login holds no table rights: the message id goes to
    // jale_cap.apply_ses_feedback, which finds the outbox row and switches
    // that employer's digest off, and nothing else is issued.
    expect(mockQuery.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim())).toEqual([
      'SELECT outcome, source_type, changed FROM jale_cap.apply_ses_feedback($1)',
    ]);
    expect(capabilityCall()![1]).toEqual([MESSAGE_ID]);
    expect(loggedText(infoLog)).toContain('ses_feedback_digest_disabled');
  });

  it('switches the digest off for a COMPLAINT, regardless of any bounce field', async () => {
    const summary = await handler(snsEvent(complaint()));
    expect(summary.disabled).toBe(1);
    expect(capabilityCall()).toBeDefined();
  });

  it.each(['abuse', 'fraud', 'virus', 'other'])(
    'switches the digest off for a %s complaint',
    async (feedbackType) => {
      const summary = await handler(snsEvent(complaint(feedbackType)));
      expect(summary.disabled).toBe(1);
      expect(capabilityCall()).toBeDefined();
    },
  );

  it('reads the identity-notification field name too, not only the configuration-set one', async () => {
    await handler(snsEvent(bounce('Permanent', { useLegacyField: true })));
    expect(capabilityCall()).toBeDefined();
  });

  it('reports disabled 0 when the employer had already opted out, without treating it as an error', async () => {
    configureDb({ outcome: 'digest', changed: 0 });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ processed: 1, disabled: 0 });
    expect(capabilityCall()).toBeDefined();
    expect(loggedText(infoLog)).toContain('"changed":0');
  });

  // ── Declines to act ───────────────────────────────────────────────────────

  /**
   * `not-spam` arrives on the complaint channel but MEANS the opposite: the
   * recipient pulled the message back out of their spam folder. ARF carries
   * both down one feedback type. Acting on it would switch the digest off for
   * the one person who just told their provider they wanted it.
   */
  it('leaves the digest ON for a not-spam complaint and never reaches the database', async () => {
    const summary = await handler(snsEvent(complaint('not-spam')));
    expect(summary).toMatchObject({ processed: 1, disabled: 0, transient: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

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

  it('counts a message id no outbox row claims', async () => {
    configureDb({ outcome: 'unknown_message' });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ unknownMessage: 1, disabled: 0 });
    expect(loggedText(errorLog)).toContain('ses_feedback_unknown_message');
    expect(loggedText(infoLog)).not.toContain('ses_feedback_digest_disabled');
  });

  it('counts a bounced message that was not a digest, naming its source type', async () => {
    configureDb({ outcome: 'not_digest', sourceType: 'billing_pause' });
    const summary = await handler(snsEvent(bounce('Permanent')));
    expect(summary).toMatchObject({ notDigest: 1, disabled: 0 });
    expect(loggedText(errorLog)).toContain('"metric":"ses_feedback_not_digest"');
    expect(loggedText(errorLog)).toContain('"sourceType":"billing_pause"');
    expect(loggedText(infoLog)).not.toContain('ses_feedback_digest_disabled');
  });

  it('throws on an outcome it does not know, so the event is retried and then dead-lettered', async () => {
    configureDb({ outcome: 'something_new' });
    await expect(handler(snsEvent(bounce('Permanent')))).rejects.toThrow(/ses_feedback_unexpected_outcome/);
    expect(loggedText(errorLog)).toContain('ses_feedback_failed');
    expect(mockRelease).toHaveBeenCalled();
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
    configureDb({ outcome: 'unknown_message' });
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
