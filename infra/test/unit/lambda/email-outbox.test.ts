const mockSesSend = jest.fn();
const mockSesConstructor = jest.fn((_config: unknown) => ({ send: mockSesSend }));
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: mockSesConstructor,
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

interface SendingClientOptions {
  attemptCount?: number;
  finalizeFailure?: boolean;
  headers?: Record<string, unknown> | null;
  subject?: string;
  recipientEmail?: string;
  bodyHtml?: string | null;
}

function sendingClient(options: SendingClientOptions | number = {}, finalizeFailureArg = false) {
  const opts: SendingClientOptions = typeof options === 'number'
    ? { attemptCount: options, finalizeFailure: finalizeFailureArg }
    : options;
  const attemptCount = opts.attemptCount ?? 1;
  const finalizeFailure = opts.finalizeFailure ?? false;
  let claims = 0;
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('WITH candidate AS')) {
      claims += 1;
      return Promise.resolve({ rows: claims === 1 ? [{
        id: 'outbox-1',
        recipient_email: opts.recipientEmail ?? email.recipientEmail,
        subject: opts.subject ?? email.subject,
        body_text: email.bodyText,
        body_html: opts.bodyHtml ?? null,
        headers: opts.headers ?? null,
        attempt_count: attemptCount,
      }] : [] });
    }
    if (finalizeFailure && sql.includes("SET status = 'sent'")) return Promise.reject(new Error('db_finalize_failed'));
    return Promise.resolve({ rows: [] });
  });
  return { query };
}

/** The raw MIME bytes the sweeper handed SES on its Nth send. */
function rawSent(index = 0): string {
  return Buffer.from(mockSesSend.mock.calls[index][0].input.Content.Raw.Data).toString('utf8');
}

describe('email outbox', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, EMAIL_FROM_ADDRESS: 'billing@jaleapp.ai', EMAIL_SEND_TIMEOUT_MS: '5000' };
    delete process.env.EMAIL_CONFIGURATION_SET;
    mockSesSend.mockResolvedValue({ MessageId: 'ses-message-1' });
  });
  afterAll(() => { process.env = originalEnv; });

  it('constructs the SESv2 client with retries disabled', () => {
    expect(constructedSesConfig).toEqual({ maxAttempts: 1 });
  });

  it('queues UUID-sourced email inside the caller transaction and rejects invalid source UUIDs', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'outbox-1' }] });
    await expect(queueEmail({ query } as any, email)).resolves.toBe('outbox-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('recipient_email'), [
      email.recipientEmail, email.subject, email.bodyText, null, email.sourceType, email.sourceId,
      email.idempotencyKey, null,
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

  it('passes a display-name sender through to SES verbatim, now as the raw From header', async () => {
    process.env.EMAIL_FROM_ADDRESS = 'Jale <no-reply@jaleapp.ai>';
    const client = sendingClient();
    await expect(sendPendingEmails(client as any)).resolves.toBe(1);
    expect(rawSent()).toContain('From: Jale <no-reply@jaleapp.ai>');
  });

  // ── Raw MIME send (sprint 22 R3-E) ────────────────────────────────────────

  it('sends raw MIME content and addresses the envelope explicitly', async () => {
    const client = sendingClient({ bodyHtml: '<p>hi</p>' });
    await expect(sendPendingEmails(client as any)).resolves.toBe(1);
    const input = mockSesSend.mock.calls[0][0].input;
    expect(input.Content.Raw.Data).toBeInstanceOf(Buffer);
    expect(input.Destination).toEqual({ ToAddresses: [email.recipientEmail] });
    expect(input.Message).toBeUndefined();
    const raw = rawSent();
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('multipart/alternative; boundary=');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
  });

  it('adds the RFC 8058 pair only for a row whose headers carry an unsubscribe URL', async () => {
    const bare = sendingClient();
    await sendPendingEmails(bare as any);
    expect(rawSent()).not.toContain('List-Unsubscribe');

    mockSesSend.mockClear();
    const url = 'https://jaleapp.ai/api/public/employer-digest/unsubscribe?token=abc.def';
    const digest = sendingClient({ headers: { unsubscribe_url: url } });
    await sendPendingEmails(digest as any);
    expect(rawSent()).toContain(`List-Unsubscribe: <${url}>`);
    expect(rawSent()).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('ignores a headers bag whose unsubscribe_url is missing or not a string', async () => {
    for (const headers of [{}, { unsubscribe_url: 42 }, { unsubscribe_url: '' }, { other: 'x' }]) {
      mockSesSend.mockClear();
      const client = sendingClient({ headers: headers as Record<string, unknown> });
      await sendPendingEmails(client as any);
      expect(rawSent()).not.toContain('List-Unsubscribe');
    }
  });

  it('tags the message with the configuration set on both the header and the API parameter', async () => {
    process.env.EMAIL_CONFIGURATION_SET = 'jale-employer-email';
    const client = sendingClient();
    await sendPendingEmails(client as any);
    expect(rawSent()).toContain('X-SES-CONFIGURATION-SET: jale-employer-email');
    expect(mockSesSend.mock.calls[0][0].input.ConfigurationSetName).toBe('jale-employer-email');
  });

  it('omits the configuration set entirely when the environment does not name one', async () => {
    delete process.env.EMAIL_CONFIGURATION_SET;
    const client = sendingClient();
    await sendPendingEmails(client as any);
    expect(rawSent()).not.toContain('X-SES-CONFIGURATION-SET');
    expect(mockSesSend.mock.calls[0][0].input.ConfigurationSetName).toBeUndefined();
  });

  it('RFC 2047-encodes a subject that is not pure ASCII', async () => {
    const client = sendingClient({ subject: 'No new applicants — Jale' });
    await sendPendingEmails(client as any);
    const raw = rawSent();
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).not.toContain('Subject: No new applicants');
  });

  it('persists the SES MessageId so a later bounce can be attributed to the row', async () => {
    mockSesSend.mockResolvedValue({ MessageId: 'ses-0100018f-abc' });
    const client = sendingClient();
    await sendPendingEmails(client as any);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('ses_message_id = COALESCE($2, ses_message_id)'),
      ['outbox-1', 'ses-0100018f-abc'],
    );
  });

  it('still finalizes as sent when SES answers without a MessageId', async () => {
    mockSesSend.mockResolvedValue({});
    const client = sendingClient();
    await sendPendingEmails(client as any);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['outbox-1', null],
    );
  });

  it('drives an unbuildable row straight to the attempt cap instead of retrying it forever', async () => {
    const client = sendingClient({ subject: 'Subject\r\nBcc: evil@example.test' });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(sendPendingEmails(client as any)).resolves.toBe(1);
    expect(mockSesSend).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      ['outbox-1', 'email_mime_header_injection', MAX_EMAIL_SEND_ATTEMPTS],
    );
    expect(log).toHaveBeenCalledWith('email_outbox_unsendable', expect.objectContaining({
      code: 'email_mime_header_injection',
    }));
    log.mockRestore();
  });

  it('writes the headers bag as JSONB when a producer supplies one', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'outbox-1' }] });
    await queueEmail({ query } as any, {
      ...email,
      headers: { unsubscribe_url: 'https://jaleapp.ai/api/public/employer-digest/unsubscribe?token=t' },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('$8::jsonb'), [
      email.recipientEmail, email.subject, email.bodyText, null, email.sourceType, email.sourceId,
      email.idempotencyKey,
      '{"unsubscribe_url":"https://jaleapp.ai/api/public/employer-digest/unsubscribe?token=t"}',
    ]);
  });

  it('fails before DB claims or SES calls when sender configuration is missing', async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    const query = jest.fn();
    await expect(sendPendingEmails({ query } as any)).rejects.toThrow('email_from_address_missing_or_invalid');
    expect(query).not.toHaveBeenCalled();
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});
