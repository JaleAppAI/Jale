const mockSesSend = jest.fn();
const mockSesConstructor = jest.fn((_config: unknown) => ({ send: mockSesSend }));
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: mockSesConstructor,
  SendEmailCommand: jest.fn((input) => ({ input })),
}));

import { queueEmail, sendPendingEmails, MAX_EMAIL_SEND_ATTEMPTS } from '../../../lambda/lib/email-outbox';
const constructedSesConfig = mockSesConstructor.mock.calls[0]?.[0];

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const email = {
  recipientEmail: 'employer@example.com', subject: 'Subject', bodyText: 'Text body', bodyHtml: null,
  sourceType: 'billing_pause', sourceId: SOURCE_ID,
  idempotencyKey: `billing-pause:${SOURCE_ID}:event-1`,
};

function sendingClient(attemptCount = 1, finalizeFailure = false) {
  let claims = 0;
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('WITH candidate AS')) {
      claims += 1;
      return Promise.resolve({ rows: claims === 1 ? [{
        id: 'outbox-1', recipient_email: email.recipientEmail, subject: email.subject,
        body_text: email.bodyText, body_html: null, attempt_count: attemptCount,
      }] : [] });
    }
    if (finalizeFailure && sql.includes("SET status = 'sent'")) return Promise.reject(new Error('db_finalize_failed'));
    return Promise.resolve({ rows: [] });
  });
  return { query };
}

describe('email outbox', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, EMAIL_FROM_ADDRESS: 'billing@jaleapp.ai', EMAIL_SEND_TIMEOUT_MS: '5000' };
    mockSesSend.mockResolvedValue({ MessageId: 'ses-message-1' });
  });
  afterAll(() => { process.env = originalEnv; });

  it('constructs SES with retries disabled', () => {
    expect(constructedSesConfig).toEqual({ maxAttempts: 1 });
  });

  it('queues UUID-sourced email inside the caller transaction and rejects invalid source UUIDs', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'outbox-1' }] });
    await expect(queueEmail({ query } as any, email)).resolves.toBe('outbox-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('recipient_email'), [
      email.recipientEmail, email.subject, email.bodyText, null, email.sourceType, email.sourceId, email.idempotencyKey,
    ]);
    expect(query).not.toHaveBeenCalledWith('BEGIN');
    await expect(queueEmail({ query } as any, { ...email, sourceId: 'not-a-uuid' }))
      .rejects.toThrow('email_outbox_source_id_invalid');
  });

  it('reuses an identical idempotent row and rejects divergent payloads', async () => {
    const existing = { id: 'outbox-1', recipient_email: email.recipientEmail, subject: email.subject,
      body_text: email.bodyText, body_html: null, source_type: email.sourceType, source_id: email.sourceId };
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [existing] });
    await expect(queueEmail({ query } as any, email)).resolves.toBe('outbox-1');
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...existing, subject: 'Different' }] });
    await expect(queueEmail({ query } as any, email)).rejects.toThrow('email_outbox_idempotency_conflict');
  });

  it('commits terminal-safe claim before SES and finalizes success afterward', async () => {
    const client = sendingClient();
    await expect(sendPendingEmails(client as any)).resolves.toBe(1);
    const claimCall = client.query.mock.calls.findIndex(([sql]) => String(sql).includes('WITH candidate AS'));
    const claimCommit = client.query.mock.calls.findIndex(([sql], index) => index > claimCall && sql === 'COMMIT');
    const sentUpdate = client.query.mock.calls.findIndex(([sql]) => String(sql).includes("SET status = 'sent'"));
    expect(claimCommit).toBeGreaterThan(claimCall);
    expect(client.query.mock.invocationCallOrder[claimCommit]).toBeLessThan(mockSesSend.mock.invocationCallOrder[0]);
    expect(mockSesSend.mock.invocationCallOrder[0]).toBeLessThan(client.query.mock.invocationCallOrder[sentUpdate]);
    expect(client.query.mock.calls[claimCall][0]).toContain("SET status = 'send_unknown'");
    expect(client.query.mock.calls[claimCall][0]).toContain('next_attempt_at <= now()');
  });

  it('leaves the committed send_unknown claim when success finalization crashes', async () => {
    const client = sendingClient(1, true);
    await expect(sendPendingEmails(client as any)).rejects.toThrow('db_finalize_failed');
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'send_unknown'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(false);
  });

  it('retries a definite SES 4xx later with exponential backoff, not in the same invocation', async () => {
    const client = sendingClient(2);
    const error = Object.assign(new Error('rejected'), {
      name: 'MessageRejected', $metadata: { httpStatusCode: 400 },
    });
    mockSesSend.mockRejectedValue(error);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sendPendingEmails(client as any)).resolves.toBe(1);
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'failed'"), [
      'outbox-1', 'MessageRejected', 120,
    ]);
    expect(warning).toHaveBeenCalledWith('email_outbox_retryable_failure', expect.objectContaining({
      attemptCount: 2, retryDelaySeconds: 120,
    }));
    warning.mockRestore();
  });

  it('keeps timeout, network, and SES 5xx ambiguity send_unknown and non-automatic', async () => {
    for (const error of [
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      Object.assign(new Error('network'), { name: 'NetworkingError' }),
      Object.assign(new Error('server'), { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } }),
    ]) {
      const client = sendingClient();
      mockSesSend.mockRejectedValueOnce(error);
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await sendPendingEmails(client as any);
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(false);
      expect(log).toHaveBeenCalledWith('email_outbox_send_unknown', expect.objectContaining({ code: error.name }));
      log.mockRestore();
    }
  });

  it('marks a definite rejection at the attempt cap terminal with no next attempt', async () => {
    const client = sendingClient(MAX_EMAIL_SEND_ATTEMPTS);
    mockSesSend.mockRejectedValue(Object.assign(new Error('rejected'), {
      name: 'MessageRejected', $metadata: { httpStatusCode: 400 },
    }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await sendPendingEmails(client as any);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('next_attempt_at = NULL'), [
      'outbox-1', 'MessageRejected',
    ]);
    expect(log).toHaveBeenCalledWith('email_outbox_attempt_cap', expect.objectContaining({ attemptCount: 5 }));
    log.mockRestore();
  });

  it('fails before DB claims or SES calls when sender configuration is missing', async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    const query = jest.fn();
    await expect(sendPendingEmails({ query } as any)).rejects.toThrow('email_from_address_missing_or_invalid');
    expect(query).not.toHaveBeenCalled();
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});
