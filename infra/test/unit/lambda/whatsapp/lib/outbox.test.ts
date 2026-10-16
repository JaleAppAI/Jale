const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('../../../../../lambda/lib/audit/context');
import {
  AmbiguousTwilioSendError,
  drainJobAlertOutbox,
  drainWorkerIntentOutbox,
  sendTwilioWhatsAppMessage,
  sendPendingAdminOutbox,
  sendPendingOutbox,
  insertAuthorizedIntentOutbox,
  _clearOutboxTwilioSecretCacheForTests,
} from '../../../../../lambda/whatsapp/lib/outbox';
import { auditCallerFor } from '../../../../../lambda/lib/audit/caller';
import { setAuditContext } from '../../../../../lambda/lib/audit/context';

const PLATFORM = auditCallerFor('fixture-invocation-0001', { kind: 'platform' }, 'whatsapp');

describe('worker-intent outbox drain', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_REQUEST_TIMEOUT_MS: '4000',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    };
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test', authToken: 'tok_test',
        messagingServiceSid: 'MG_test', templates: {},
      }),
    });
  });

  afterAll(() => { process.env = originalEnv; });

  it('leases through the definer RPC, sends once, and completes with the fencing token', async () => {
    const sid = `SM${'1'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-1',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ completed: true }] });
    const release = jest.fn();
    const pool = { connect: jest.fn(async () => ({ query, release })) };

    await expect(drainWorkerIntentOutbox(pool as any, 25)).resolves.toEqual({
      sent: 1, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The expiry pass runs first, on the lease's own connection.
    expect(query.mock.calls[0]).toEqual(['SELECT id FROM expire_worker_intent_outbox()']);
    expect(query.mock.calls[1]).toEqual([
      'SELECT * FROM lease_worker_intent_outbox($1)', [25],
    ]);
    expect(query.mock.calls[2]).toEqual([
      'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
      ['outbox-1', 'lease-1', sid],
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  // Migration 126. A row whose intent passed its expires_at before it was
  // sent is ended by the expiry pass and never leased. It is counted the way
  // 093's 48-hour ceiling is counted, in `expired` (which the drain handler
  // adds to WorkerIntentOutboxFailure), but without 093's template line: it
  // has nothing to do with a template awaiting approval.
  it('counts the rows the expiry pass ended as expired and never sends them', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-old-1' }, { id: 'outbox-old-2' }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = jest.fn();
    const pool = { connect: jest.fn(async () => ({ query, release })) };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(drainWorkerIntentOutbox(pool as any, 25)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 0, expired: 2,
    });
    expect(query.mock.calls).toEqual([
      ['SELECT id FROM expire_worker_intent_outbox()'],
      ['SELECT * FROM lease_worker_intent_outbox($1)', [25]],
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplateExpired'),
    )).toBe(false);
    log.mockRestore();
  });

  it('records an ambiguous transport failure and never completes the row', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-2', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-2',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(query.mock.calls[2][0]).toBe(
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
    );
    expect(query.mock.calls[2][1][3]).toBe(true);
  });

  it('never requeues after Twilio accepts when completion persistence fails', async () => {
    const sid = `SM${'3'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-3', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-3',
        }],
      })
      .mockRejectedValueOnce(new Error('completion database unavailable'))
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[3]).toEqual([
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
      ['outbox-3', 'lease-3', 'completion database unavailable', true],
    ]);
  });

  // ── Twilio 63016 on an application_* intent (2026-09-04) ──
  //
  // The faithful reproduction of the incident: the four application_* Content
  // templates are PENDING Meta approval, so the secret holds no ContentSid,
  // so the sender falls back to __fallback_body as a freeform Body -- and
  // Meta refuses freeform outside the 24-hour session window with 63016,
  // which is exactly the window an employer-triggered notification lands in.
  //
  // Nothing about the row is wrong and no number of retries fixes it, so it
  // must NOT spend the five-attempt budget. It reschedules an hour out
  // through migration 093's defer RPC instead, and the drain reports it as
  // `deferred` rather than `failed` -- a distinct count, because a template
  // waiting on Meta is an operator action and a genuine send failure is not.
  function applicationIntentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'outbox-63016', whatsapp_number: '+15125551234', body: null,
      content_template: 'application_update_en',
      content_variables: {
        '1': 'Concrete Finisher', '2': 'Northwind & Birch',
        '3': 'app-11111111-2222-4333-8444-555555555555',
        '4': 'https://jaleapp.ai/en/worker/applications/11111111-2222-4333-8444-555555555555',
        __fallback_body: 'Application update for Concrete Finisher: ...',
      },
      attempt_count: 1, lease_token: 'lease-63016',
      ...overrides,
    };
  }

  it('defers an application_* intent rejected with 63016 instead of spending an attempt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({ code: 63016, message: 'outside allowed window' }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ deferred: true }] })
      // 093 decides the outcome INSIDE the RPC and returns only a boolean, so
      // the drain reads the row's status back to learn which branch ran. This
      // row is younger than 48h, so it went back to 'pending'.
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 1, expired: 0,
    });
    // The row goes to the defer RPC, NOT to fail_worker_intent_outbox.
    expect(query.mock.calls[2]).toEqual([
      'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
      ['outbox-63016', 'lease-63016', 'twilio_63016_template_pending', 3600],
    ]);
    expect(query.mock.calls.some(
      (call) => String(call[0]).includes('fail_worker_intent_outbox'),
    )).toBe(false);
    // The operator signal: this is the one failure class a code change cannot
    // clear, so it gets its own metric rather than hiding inside Failure.
    // WorkerIntentTemplatePendingMetric (whatsapp-stack.ts) is the filter that
    // counts this line; it is emitted exactly once per deferred row.
    const pendingLines = log.mock.calls.filter(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplatePending'),
    );
    expect(pendingLines).toEqual([[JSON.stringify({
      metric: 'WorkerIntentOutboxTemplatePending',
    })]]);
    // Mutually exclusive with the terminal line: a row that is merely parked
    // must never look like one that died.
    expect(log.mock.calls.some(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplateExpired'),
    )).toBe(false);
    log.mockRestore();
  });

  // Sprint 28 (F28): outside the 24h window the web completion line goes out
  // as `application_web_completed_<lang>`. Until that ContentSid is mapped it
  // must degrade exactly like the stage templates above: the fallback body is
  // what Twilio receives, and its 63016 parks the row instead of failing it.
  it('defers the web completion template the same way while its ContentSid is unmapped', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ code: 63016 }),
    });
    const fallback = 'Completaste tu solicitud para el trabajo de Concreto en la web. Revisa su estado en '
      + 'https://jaleapp.ai/es/worker/applications/11111111-2222-4333-8444-555555555555 '
      + 'y te avisamos por aqu\u00ed cuando el empleador responda.';
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow({
        content_template: 'application_web_completed_es',
        content_variables: {
          '1': 'Concreto',
          '2': 'https://jaleapp.ai/es/worker/applications/11111111-2222-4333-8444-555555555555',
          __fallback_body: fallback,
        },
      })] })
      .mockResolvedValueOnce({ rows: [{ deferred: true }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 1, expired: 0,
    });
    const form = new URLSearchParams(String(mockFetch.mock.calls[0][1].body));
    expect(form.get('Body')).toBe(fallback);
    expect(form.get('ContentSid')).toBeNull();
    expect(query.mock.calls[2]).toEqual([
      'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
      ['outbox-63016', 'lease-63016', 'twilio_63016_template_pending', 3600],
    ]);
    log.mockRestore();
  });

  // F4. The 48-hour ceiling lives inside 093's UPDATE (`created_at <
  // now() - interval '48 hours'` -> status = 'failed'), and the RPC returns a
  // bare BOOLEAN either way. So a terminal death and an ordinary parking are
  // the SAME `true` to the caller: before this, an application notification
  // that aged out was counted `deferred`, `result.failed` stayed 0, the
  // drain's WorkerIntentOutboxFailure line never fired, and the row died with
  // nothing at all in CloudWatch. Reading `status` back is what tells them
  // apart without editing the frozen migration.
  it('reports the 48h terminal branch as expired, not as another deferral', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ code: 63016 }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ deferred: true }] })
      .mockResolvedValueOnce({ rows: [{ status: 'failed' }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 0, expired: 1,
    });
    // Read back on the SAME client as the defer call, and projected: `status`
    // only, never `SELECT *` on a row carrying a phone number and a body.
    expect(query.mock.calls[3]).toEqual([
      "SELECT status FROM whatsapp_outbox WHERE id = $1 AND source_type = 'worker_intent'",
      ['outbox-63016'],
    ]);
    const expiredLines = log.mock.calls.filter(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplateExpired'),
    );
    expect(expiredLines).toEqual([[JSON.stringify({
      metric: 'WorkerIntentOutboxTemplateExpired',
    })]]);
    expect(log.mock.calls.some(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplatePending'),
    )).toBe(false);
    log.mockRestore();
  });

  it('counts a status read that returns no row as a deferral, not a death', async () => {
    // A missing row is not evidence of the terminal branch. 043's own sweep or
    // an operator could have moved it between the defer and this read, and
    // calling that `expired` would page someone about a template approval that
    // has nothing to do with it. `deferred` is the conservative reading.
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ code: 63016 }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ deferred: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 0,
      leaseLost: 0, deferred: 1, expired: 0,
    });
    expect(log.mock.calls.some(
      ([line]) => String(line).includes('WorkerIntentOutboxTemplateExpired'),
    )).toBe(false);
    log.mockRestore();
  });

  it('keeps the fail path for 63016 on a template that is not application_*', async () => {
    // 63016 outside the application lane means something else -- a session
    // window that really did lapse for a lane that has an approved template.
    // Deferring those would park real failures for 48 hours.
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test', authToken: 'tok_test', messagingServiceSid: 'MG_test',
        templates: { employer_message_invite_en: 'HX_employer_en' },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ code: 63016 }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({
        rows: [applicationIntentRow({
          content_template: 'employer_message_invite_en',
          content_variables: { '1': 'Northwind & Birch', '2': 'Concrete Finisher' },
        })],
      })
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(query.mock.calls[2][0]).toBe(
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
    );
    expect(query.mock.calls[2][1][3]).toBe(false);
  });

  it('keeps the fail path for a non-63016 rejection of an application_* intent', async () => {
    // The lane is not a blanket exemption: a rate limit or a bad ContentSid on
    // an application_* row is a real failure and must still burn attempts.
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 429, json: async () => ({ code: 20429 }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(query.mock.calls[2][0]).toBe(
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
    );
  });

  it('keeps an ambiguous transport failure ambiguous on an application_* intent', async () => {
    // Ordering inside the catch: a timeout has no Twilio code at all and the
    // row's delivery state is unknown, so it must never be rescheduled by the
    // defer branch just because the template name matches.
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    );
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
      leaseLost: 0, deferred: 0, expired: 0,
    });
    expect(query.mock.calls[2][1][3]).toBe(true);
  });

  it('treats a lost lease on the defer call the same way it treats one on fail', async () => {
    // A false from the RPC means another drain owns the row (or the lease
    // expired). Swallowing it would hide a fencing bug behind a green metric,
    // so it throws the prefixed error the Lambda already counts.
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ code: 63016 }),
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // migration 126's expiry pass: nothing expired
      .mockResolvedValueOnce({ rows: [applicationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ deferred: false }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).rejects.toThrow(
      'worker_intent_lease_lost:outbox-63016',
    );
    // The throw must come from the DEFER call, not from a fallback into the
    // fail path -- otherwise this passes on the pre-093 behaviour.
    expect(query.mock.calls[2][0]).toBe(
      'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
    );
  });
});

describe('whatsapp outbox templates', () => {
  const originalEnv = process.env;
  const query = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = { ...originalEnv, TWILIO_SECRET_ARN: 'arn:twilio' };
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '4000';
    process.env.TWILIO_STATUS_CALLBACK_URL =
      'https://callbacks.example.test/prod/whatsapp/status-callback';
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MG_test',
        templates: {
          job_alert_en: 'HX_job_en',
          admin_support_reply_v2_en: 'HX_admin_v2_en',
          employer_message_invite_es: 'HX_employer_invite_es',
        },
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK', json: async () => ({ sid: 'SM11111111111111111111111111111111' }) });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('accepts an MM-prefixed Twilio message SID', async () => {
    const sid = `MM${'a'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });

    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125551234', {
      body: 'Hello',
      content_template: null,
      content_variables: null,
    })).resolves.toBe(sid);
  });

  it('keeps malformed Twilio message SIDs ambiguous', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: `MM${'g'.repeat(32)}` }),
    });

    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125551234', {
      body: 'Hello',
      content_template: null,
      content_variables: null,
    })).rejects.toBeInstanceOf(AmbiguousTwilioSendError);
  });

  it('throws TwilioTemplateInvalidError with the template name on Twilio code 21655', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ code: 21655, message: 'ContentSid is Invalid' }),
    });
    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125550100', {
      body: null,
      content_template: 'employer_message_invite_es',
      content_variables: { '1': 'ACME', '2': 'Plomero' },
    })).rejects.toMatchObject({
      name: 'TwilioTemplateInvalidError',
      templateName: 'employer_message_invite_es',
      twilioCode: 21655,
    });
  });

  it('keeps the generic error (with code appended) for other non-ok responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ code: 20429 }),
    });
    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125550100', {
      body: 'hola', content_template: null, content_variables: null,
    })).rejects.toThrow('Twilio send failed with HTTP 429 (code 20429)');
  });

  it('sends Twilio Content API templates from outbox rows', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          sequence: 1,
          whatsapp_number: '+15125551234',
          body: null,
          content_template: 'job_alert_en',
          content_variables: { '1': 'Drywall finisher', '5': 'job-job-1' },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await sendPendingOutbox({ query } as any, 'SM-template');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('ContentSid=HX_job_en'),
      }),
    );
    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('ContentVariables=');
    expect(sentBody).toContain(
      'StatusCallback=https%3A%2F%2Fcallbacks.example.test%2Fprod%2Fwhatsapp%2Fstatus-callback',
    );
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-1', 'SM11111111111111111111111111111111']);
  });

  it('falls back to text when an in-session template SID is not configured', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-2',
          sequence: 1,
          whatsapp_number: '+15125551234',
          body: null,
          content_template: 'onboarding_trade_en',
          content_variables: {
            __fallback_body: 'What is your main trade?\n\n1. Electrician',
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await sendPendingOutbox({ query } as any, 'SM-template-fallback');

    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('Body=What+is+your+main+trade');
    expect(sentBody).not.toContain('ContentSid=');
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-2', 'SM11111111111111111111111111111111']);
  });

  function jobAlertPool(attemptCount = 0) {
    const events: string[] = [];
    const claimQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      events.push(sql);
      if (sql.includes('SELECT id, whatsapp_number')) {
        return {
          rows: [{
            id: 'job-alert-row',
            whatsapp_number: '+15125551234',
            body: 'A new job is available',
            content_template: null,
            content_variables: null,
            attempt_count: attemptCount,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const resultQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      events.push(sql);
      return { rowCount: 1, rows: [] };
    });
    const clients = [
      { query: claimQuery, release: jest.fn() },
      { query: resultQuery, release: jest.fn() },
    ];
    const pool = { connect: jest.fn(async () => clients.shift()!) };
    return { pool, claimQuery, resultQuery, events };
  }

  it('claims only pending job alerts with SKIP LOCKED and commits before sending', async () => {
    const { pool, claimQuery, resultQuery, events } = jobAlertPool();
    mockFetch.mockImplementationOnce(async () => {
      events.push('TWILIO_SEND');
      return {
        ok: true,
        json: async () => ({ sid: 'SM33333333333333333333333333333333' }),
      };
    });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 1, ambiguous: 0, failed: 0,
    });

    const selectSql = String(claimQuery.mock.calls.find(([sql]) => sql.includes('SELECT id'))![0]);
    expect(selectSql).toContain("status = 'pending'");
    expect(selectSql).not.toContain("'send_unknown'");
    expect(selectSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(events.indexOf('COMMIT')).toBeLessThan(events.indexOf('TWILIO_SEND'));
    expect(claimQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'send_unknown'"),
      ['job-alert-row'],
    );
    expect(resultQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['job-alert-row', 'SM33333333333333333333333333333333'],
    );
  });

  it('leaves an ambiguous job-alert send terminally send_unknown without backoff', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'send_unknown'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('next_attempt_at = NULL');
    expect(String(update![0])).not.toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('valid message SID')]);
  });

  it('treats a rejected Twilio fetch as ambiguous and never schedules a resend', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed: socket terminated'));

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'send_unknown'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('next_attempt_at = NULL');
    expect(String(update![0])).not.toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('delivery state unknown')]);
  });

  it('retries definite non-acceptance with backoff while below the attempt cap', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'pending'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('HTTP 503'), '30000']);
  });

  it('marks definite non-acceptance failed at the attempt cap', async () => {
    const { pool, resultQuery } = jobAlertPool(4);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid' });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
    });

    expect(resultQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      ['job-alert-row', expect.stringContaining('HTTP 400')],
    );
  });

  describe('insertAuthorizedIntentOutbox', () => {
    it('inserts a worker_intent outbox row for an eligible intent', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'eligible' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-worker-intent-1' }] });

      const result = await insertAuthorizedIntentOutbox({ query } as any, { workerId: 'worker-1', intentId: 'intent-1' }, {
        whatsappNumber: '+15125551234',
        body: 'A new job is available',
        contentTemplate: null,
        contentVariables: null,
      });

      expect(result).toEqual({ outboxId: 'outbox-worker-intent-1' });
      expect(query.mock.calls[0][0]).toMatch(/SELECT status FROM worker_message_intents WHERE id = \$1\s+AND user_id = \$2/);
      // The intent's worker is named in the read itself, not only its id.
      expect(query.mock.calls[0][1]).toEqual(['intent-1', 'worker-1']);
      const insertCall = query.mock.calls[1];
      expect(insertCall[0]).toMatch(/INSERT INTO whatsapp_outbox/);
      expect(insertCall[0]).toMatch(/'worker_intent'/);
      expect(insertCall[1]).toEqual([
        '+15125551234',
        'A new job is available',
        null,
        null,
        'intent-1',
      ]);
    });

    it('throws unauthorized_worker_outbox_row when the intent is still deferred', async () => {
      query.mockResolvedValueOnce({ rows: [{ status: 'deferred' }] });

      await expect(insertAuthorizedIntentOutbox({ query } as any, { workerId: 'worker-1', intentId: 'intent-2' }, {
        whatsappNumber: '+15125551234',
        body: 'hi',
        contentTemplate: null,
        contentVariables: null,
      })).rejects.toThrow('unauthorized_worker_outbox_row');

      expect(query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO whatsapp_outbox'))).toHaveLength(0);
    });

    it('throws unauthorized_worker_outbox_row when no intent row exists', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(insertAuthorizedIntentOutbox({ query } as any, { workerId: 'worker-1', intentId: 'intent-missing' }, {
        whatsappNumber: '+15125551234',
        body: 'hi',
        contentTemplate: null,
        contentVariables: null,
      })).rejects.toThrow('unauthorized_worker_outbox_row');
    });
  });
});

// ── Admin replies (sprint 28): window-aware, claim-then-send ─────────────
//
// Admin rows are template rows (`body NULL`) keyed `admin_support_reply_v2_<lang>`
// with variable "1" (one line) and `__fallback_body` (the full text). Inside
// the worker's 24-hour window the full text goes freeform; outside it only an
// approved v2 template may go, and with no template the row waits. The
// unversioned keys are never treated as a template, whatever the secret maps.
describe('sendPendingAdminOutbox', () => {
  const originalEnv = process.env;
  const SID_A = `SM${'a'.repeat(32)}`;
  const NUMBER = '+15550100001';
  const CASE_ID = '00000000-0000-4000-8000-0000000000c1';

  interface AdminRow {
    id: string;
    source_id: string;
    whatsapp_number: string;
    body: string | null;
    content_template: string | null;
    content_variables: Record<string, string> | null;
    attempt_count: number;
    window_wait_expired: boolean;
  }

  function adminRow(overrides: Partial<AdminRow> = {}): AdminRow {
    return {
      id: 'outbox-admin-1',
      source_id: CASE_ID,
      whatsapp_number: NUMBER,
      body: null,
      content_template: 'admin_support_reply_v2_en',
      content_variables: {
        '1': 'Please send the missing document.',
        __fallback_body: 'Please send\nthe missing document.',
      },
      attempt_count: 0,
      window_wait_expired: false,
      ...overrides,
    };
  }

  function secretWith(templates: Record<string, string>) {
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test', authToken: 'tok_test', messagingServiceSid: 'MG_test', templates,
      }),
    });
  }

  /** A client whose claim query hands out `rows` one at a time. */
  function adminClient(rows: AdminRow[], windowOpen: boolean) {
    const queue = [...rows];
    const query: jest.Mock = jest.fn(async (sql: string) => {
      if (/FROM whatsapp_outbox/.test(sql) && /FOR UPDATE SKIP LOCKED/.test(sql)) {
        const row = queue.shift();
        return { rows: row ? [row] : [] };
      }
      if (/FROM whatsapp_processed_messages/.test(sql)) return { rows: [{ within_window: windowOpen }] };
      return { rowCount: 1, rows: [] };
    });
    return { query, client: { query } as any };
  }

  const statements = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql));
  const callsTo = (query: jest.Mock, pattern: RegExp) =>
    query.mock.calls.filter(([sql]) => pattern.test(String(sql)));
  const deliveries = (query: jest.Mock) => callsTo(query, /support_record_admin_delivery/).map(([, params]) => params);
  const sentForm = (call = 0) => new URLSearchParams(mockFetch.mock.calls[call][1].body as string);

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const loggedLines = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map(([line]) => String(line));
  /** Terminal outcomes only: these feed the alarm. */
  const failureLines = () => loggedLines().filter((line) => line.includes('AdminOutboxDispatchFailure'));
  /** A failed attempt that will be retried: logged, never alarmed. */
  const retryLines = () => loggedLines().filter((line) => line.includes('AdminOutboxDispatchRetry'));

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_REQUEST_TIMEOUT_MS: '4000',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    };
    secretWith({ admin_support_reply_v2_en: 'HX_admin_v2_en', admin_support_reply_v2_es: 'HX_admin_v2_es' });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sid: SID_A }) });
    logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  afterAll(() => { process.env = originalEnv; });

  describe('window choice', () => {
    it('window open: sends the full text freeform even though the v2 template is mapped', async () => {
      const { query, client } = adminClient([adminRow()], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentForm().get('Body')).toBe('Please send\nthe missing document.');
      expect(sentForm().get('ContentSid')).toBeNull();
      expect(sentForm().get('To')).toBe(`whatsapp:${NUMBER}`);
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'sent', 'freeform', SID_A, null]]);
    });

    it('window open, template not mapped: still the full text freeform', async () => {
      secretWith({});
      const { query, client } = adminClient([adminRow()], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(sentForm().get('Body')).toBe('Please send\nthe missing document.');
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'sent', 'freeform', SID_A, null]]);
    });

    it('window closed, v2 template mapped: sends the template with variable "1" only', async () => {
      const { query, client } = adminClient([adminRow({
        content_variables: {
          '1': 'Please send the missing document.',
          '2': 'never sent',
          __fallback_body: 'Please send\nthe missing document.',
        },
      })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(sentForm().get('ContentSid')).toBe('HX_admin_v2_en');
      expect(JSON.parse(sentForm().get('ContentVariables') as string)).toEqual({ '1': 'Please send the missing document.' });
      expect(sentForm().get('Body')).toBeNull();
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'sent', 'template', SID_A, null]]);
    });

    it('window closed, template not mapped: parks the row for an hour, burns no attempt, sends nothing', async () => {
      secretWith({});
      const { query, client } = adminClient([adminRow({ attempt_count: 2 })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).not.toHaveBeenCalled();
      const parks = callsTo(query, /UPDATE whatsapp_outbox/);
      expect(parks).toHaveLength(1);
      const [parkSql, parkParams] = parks[0];
      expect(parkSql).toMatch(/status = 'pending'/);
      expect(parkSql).toMatch(/next_attempt_at = now\(\) \+ interval '1 hour'/);
      expect(parkSql).not.toMatch(/attempt_count/);
      expect(parkSql).not.toMatch(/send_unknown/);
      expect(parkParams).toEqual(expect.arrayContaining(['outbox-admin-1']));
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);
      expect(failureLines()).toEqual([]);
    });

    it('window closed for 7 days with no template: fails the row and records the failure', async () => {
      secretWith({});
      const { query, client } = adminClient([adminRow({ attempt_count: 0, window_wait_expired: true })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).not.toHaveBeenCalled();
      const updates = callsTo(query, /UPDATE whatsapp_outbox/);
      expect(updates).toHaveLength(1);
      expect(updates[0][0]).toMatch(/status = 'failed'/);
      // Spent to the cap: ops health counts a failed row under the cap as
      // still being retried, and this one never will be.
      expect(updates[0][0]).toMatch(/attempt_count = \$3/);
      expect(updates[0][1]).toEqual(['outbox-admin-1', expect.any(String), 5]);
      const recorded = deliveries(query);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].slice(0, 4)).toEqual(['outbox-admin-1', 'failed', null, null]);
      expect(failureLines()).toHaveLength(1);
    });

    // The template carries one line of at most 250 characters. When that line
    // is a shortened copy of a longer reply, sending it would deliver a
    // cut-off message: the reply waits for the worker's window instead, and
    // then goes out whole, freeform.
    it('a 600-character reply whose window closed parks and is never sent as a template', async () => {
      const full = `${'Revisamos tu cuenta y encontramos el problema. '.repeat(13)}Gracias.`.slice(0, 600);
      expect(full).toHaveLength(600);
      const { query, client } = adminClient([adminRow({
        content_variables: { '1': `${full.slice(0, 249)}…`, __fallback_body: full },
      })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).not.toHaveBeenCalled();
      const parks = callsTo(query, /UPDATE whatsapp_outbox/);
      expect(parks).toHaveLength(1);
      expect(parks[0][0]).toMatch(/status = 'pending'/);
      expect(parks[0][0]).toMatch(/next_attempt_at = now\(\) \+ interval '1 hour'/);
      expect(parks[0][0]).not.toMatch(/attempt_count/);
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);

      // Once the worker writes, the whole reply goes freeform.
      const open = adminClient([adminRow({
        content_variables: { '1': `${full.slice(0, 249)}…`, __fallback_body: full },
      })], true);
      await sendPendingAdminOutbox(open.client, PLATFORM);
      expect(sentForm().get('Body')).toBe(full);
      expect(sentForm().get('ContentSid')).toBeNull();
    });

    it.each([
      ['ends with the shortening mark', { '1': 'Please send the missing…', __fallback_body: 'Please send the missing…' }],
      ['is shorter than the one-line reply', { '1': 'Please send the', __fallback_body: 'Please send\nthe missing document.' }],
    ])('a variable that %s waits too, and is never sent as a template', async (_label, variables) => {
      const { query, client } = adminClient([adminRow({ content_variables: variables })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);
    });

    it('a shortened reply still waiting after 7 days fails, spent to the cap', async () => {
      const { query, client } = adminClient([adminRow({
        content_variables: { '1': 'Please send the…', __fallback_body: 'Please send the missing document today.' },
        window_wait_expired: true,
      })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).not.toHaveBeenCalled();
      const updates = callsTo(query, /UPDATE whatsapp_outbox/);
      expect(updates).toHaveLength(1);
      expect(updates[0][0]).toMatch(/status = 'failed'/);
      expect(updates[0][1]).toEqual(['outbox-admin-1', expect.any(String), 5]);
    });

    it('the claim reads the 7-day limit on the database clock', async () => {
      const { query, client } = adminClient([], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const [claimSql, claimParams] = callsTo(query, /FOR UPDATE SKIP LOCKED/)[0];
      expect(claimSql).toMatch(/created_at <= now\(\) - interval '7 days'/);
      expect(claimSql).toMatch(/source_type = 'admin_case'/);
      expect(claimSql).toMatch(/status = 'pending'/);
      expect(claimSql).not.toMatch(/'failed'/);
      expect(claimSql).toMatch(/next_attempt_at IS NULL OR next_attempt_at <= now\(\)/);
      expect(claimParams).toEqual([5]);
    });

    it.each(['admin_support_reply_en', 'admin_support_reply_es'])(
      'an unversioned %s row is never sent as a template, even when the secret maps it',
      async (key) => {
        secretWith({ [key]: 'HX_unversioned', admin_support_reply_v2_en: 'HX_admin_v2_en', admin_support_reply_v2_es: 'HX_admin_v2_es' });
        const closed = adminClient([adminRow({ content_template: key })], false);

        await sendPendingAdminOutbox(closed.client, PLATFORM);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(deliveries(closed.query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);

        const open = adminClient([adminRow({ content_template: key })], true);
        await sendPendingAdminOutbox(open.client, PLATFORM);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(sentForm().get('ContentSid')).toBeNull();
        expect(sentForm().get('Body')).toBe('Please send\nthe missing document.');
      },
    );

    it('a plain-body admin row goes freeform in the window and waits outside it', async () => {
      const plain = adminRow({ body: 'Admin follow-up', content_template: null, content_variables: null });
      const open = adminClient([plain], true);
      await sendPendingAdminOutbox(open.client, PLATFORM);
      expect(sentForm().get('Body')).toBe('Admin follow-up');

      mockFetch.mockClear();
      const closed = adminClient([plain], false);
      await sendPendingAdminOutbox(closed.client, PLATFORM);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(deliveries(closed.query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);
    });

    it('asks the window of the row\'s own number', async () => {
      const { query, client } = adminClient([adminRow()], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const [, windowParams] = callsTo(query, /FROM whatsapp_processed_messages/)[0];
      expect(windowParams).toEqual([NUMBER]);
    });
  });

  describe('claim, send, finalize', () => {
    it('commits the claim as send_unknown with the attempt counted before Twilio is called', async () => {
      const { query, client } = adminClient([adminRow()], true);
      const order: string[] = [];
      query.mockImplementation(async (sql: string) => {
        order.push(String(sql));
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
          return { rows: order.filter((s) => /FOR UPDATE SKIP LOCKED/.test(s)).length === 1 ? [adminRow()] : [] };
        }
        if (/FROM whatsapp_processed_messages/.test(sql)) return { rows: [{ within_window: true }] };
        return { rowCount: 1, rows: [] };
      });
      mockFetch.mockImplementation(async () => {
        order.push('FETCH');
        return { ok: true, json: async () => ({ sid: SID_A }) };
      });

      await sendPendingAdminOutbox(client, PLATFORM);

      const claimIndex = order.findIndex((sql) => /SET status = 'send_unknown'/.test(sql));
      expect(order[claimIndex]).toMatch(/attempt_count = attempt_count \+ 1/);
      const commitAfterClaim = order.indexOf('COMMIT', claimIndex);
      const fetchIndex = order.indexOf('FETCH');
      expect(claimIndex).toBeGreaterThan(-1);
      expect(commitAfterClaim).toBeGreaterThan(claimIndex);
      expect(fetchIndex).toBeGreaterThan(commitAfterClaim);
      expect(order.indexOf('BEGIN', fetchIndex)).toBeGreaterThan(fetchIndex);
      const sentIndex = order.findIndex((sql) => /SET status = 'sent'/.test(sql));
      expect(sentIndex).toBeGreaterThan(fetchIndex);
    });

    it('on send: marks the row sent, records via, and stamps activity on the conversation in this case\'s mode', async () => {
      const { query, client } = adminClient([adminRow()], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-admin-1', SID_A]);
      const stamps = callsTo(query, /UPDATE whatsapp_conversations/);
      expect(stamps).toHaveLength(1);
      expect(stamps[0][0]).toMatch(/SET support_last_activity_at = now\(\)/);
      expect(stamps[0][0]).toMatch(/WHERE whatsapp_number = \$1\s+AND support_case_id = \$2/);
      expect(stamps[0][1]).toEqual([NUMBER, CASE_ID]);
    });

    it.each([
      [0, 30_000],
      [1, 60_000],
      [3, 240_000],
    ])('a definite failure at attempt_count %i goes back to pending after %i ms, with no case event', async (attemptCount, backoffMs) => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ code: 20500 }) });
      const { query, client } = adminClient([adminRow({ attempt_count: attemptCount })], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const retry = callsTo(query, /UPDATE whatsapp_outbox/).find(([sql]) => /SET status = 'pending'/.test(String(sql)));
      expect(retry).toBeDefined();
      expect(retry![0]).toMatch(/next_attempt_at = now\(\) \+/);
      expect(retry![1]).toEqual(['outbox-admin-1', 'Twilio send failed with HTTP 500 (code 20500)', String(backoffMs)]);
      expect(deliveries(query)).toEqual([]);
      // A retry is logged but never feeds the alarm: only the outcome does.
      expect(retryLines()).toHaveLength(1);
      expect(failureLines()).toEqual([]);
    });

    it('the fifth definite failure fails the row and records it on the case', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ code: 21211 }) });
      const { query, client } = adminClient([adminRow({ attempt_count: 4 })], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const failed = callsTo(query, /UPDATE whatsapp_outbox/).find(([sql]) => /SET status = 'failed'/.test(String(sql)));
      expect(failed).toBeDefined();
      expect(callsTo(query, /SET status = 'pending'/)).toEqual([]);
      expect(deliveries(query)).toEqual([
        ['outbox-admin-1', 'failed', 'freeform', null, 'Twilio send failed with HTTP 400 (code 21211)'],
      ]);
      expect(failureLines()).toHaveLength(1);
    });

    it('an ambiguous send stays send_unknown: no retry, one case event', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      const { query, client } = adminClient([adminRow()], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(callsTo(query, /SET status = 'pending'/)).toEqual([]);
      const unknown = callsTo(query, /UPDATE whatsapp_outbox/).filter(([sql]) => /last_error/.test(String(sql)) && /send_unknown/.test(String(sql)));
      expect(unknown.length).toBeGreaterThan(0);
      const recorded = deliveries(query);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].slice(0, 4)).toEqual(['outbox-admin-1', 'send_unknown', 'template', null]);
      expect(failureLines()).toHaveLength(1);
    });

    it.each([
      ['a retry', 0, () => retryLines(), 'AdminOutboxDispatchRetry'],
      ['the final failure', 4, () => failureLines(), 'AdminOutboxDispatchFailure'],
    ])('the log line for %s carries codes only: no text, no number', async (_label, attemptCount, lines, metric) => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ code: 63016 }) });
      const { client } = adminClient([adminRow({ attempt_count: attemptCount as number })], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const found = (lines as () => string[])();
      expect(found).toHaveLength(1);
      const [line] = found;
      expect(JSON.parse(line)).toMatchObject({ metric, httpStatus: 400, twilioCode: 63016 });
      expect(line).not.toContain(NUMBER);
      expect(line).not.toContain('missing document');
      expect(line).not.toContain('Twilio send failed');
    });

    // A template Twilio refuses as unusable (21655: not usable; 63016 at send
    // time: not approved for this window) will not fix itself in minutes.
    // The reply waits exactly as if no template were mapped.
    it.each([
      ['21655', { code: 21655, message: 'ContentSid is invalid' }],
      ['63016', { code: 63016 }],
    ])('a template refused with %s waits an hour with no attempt spent, and records the wait once', async (_code, body) => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => body });
      const { query, client } = adminClient([adminRow({ attempt_count: 4 })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentForm().get('ContentSid')).toBe('HX_admin_v2_en');
      const parks = callsTo(query, /UPDATE whatsapp_outbox/).filter(([sql]) => /SET status = 'pending'/.test(String(sql)));
      expect(parks).toHaveLength(1);
      expect(parks[0][0]).toMatch(/next_attempt_at = now\(\) \+ interval '1 hour'/);
      // The claim counted an attempt; the wait gives it back.
      expect(parks[0][0]).toMatch(/attempt_count = \$3/);
      expect(parks[0][1]).toEqual(['outbox-admin-1', 'waiting_for_session_window', 4]);
      expect(callsTo(query, /SET status = 'failed'/)).toEqual([]);
      expect(deliveries(query)).toEqual([['outbox-admin-1', 'waiting_for_window', null, null, null]]);
      expect(failureLines()).toEqual([]);
      expect(retryLines()).toEqual([]);
    });

    it('a template still refused after 7 days fails the row, spent to the cap', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ code: 21655 }) });
      const { query, client } = adminClient([adminRow({ attempt_count: 1, window_wait_expired: true })], false);

      await sendPendingAdminOutbox(client, PLATFORM);

      const failed = callsTo(query, /UPDATE whatsapp_outbox/).filter(([sql]) => /SET status = 'failed'/.test(String(sql)));
      expect(failed).toHaveLength(1);
      expect(failed[0][0]).toMatch(/attempt_count = \$3/);
      expect(failed[0][1]).toEqual(['outbox-admin-1', expect.any(String), 5]);
      expect(callsTo(query, /SET status = 'pending'/)).toEqual([]);
      const recorded = deliveries(query);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].slice(0, 2)).toEqual(['outbox-admin-1', 'failed']);
      expect(failureLines()).toHaveLength(1);
    });

    it('a 63016 on a freeform send (the window closed meanwhile) is an ordinary retry, not a wait', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ code: 63016 }) });
      const { query, client } = adminClient([adminRow({ attempt_count: 0 })], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      const retry = callsTo(query, /SET status = 'pending'/);
      expect(retry).toHaveLength(1);
      expect(retry[0][1]).toEqual(['outbox-admin-1', 'Twilio send failed with HTTP 400 (code 63016)', '30000']);
      expect(deliveries(query)).toEqual([]);
    });

    it('commits each row on its own and moves on after a failure', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sid: SID_A }) })
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
      const { query, client } = adminClient([
        adminRow({ id: 'outbox-admin-first' }),
        adminRow({ id: 'outbox-admin-second' }),
      ], true);

      await sendPendingAdminOutbox(client, PLATFORM);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-admin-first', SID_A]);
      expect(callsTo(query, /SET status = 'pending'/)[0][1][0]).toBe('outbox-admin-second');
      const all = statements(query);
      expect(all.filter((sql) => sql === 'BEGIN').length).toBe(all.filter((sql) => sql === 'COMMIT').length);
    });

    it('states the platform after each BEGIN, before any case delivery is recorded', async () => {
      const { query, client } = adminClient([adminRow()], true);
      (setAuditContext as jest.Mock).mockClear();

      await sendPendingAdminOutbox(client, PLATFORM);

      const begins = statements(query).filter((sql) => sql === 'BEGIN').length;
      expect(begins).toBeGreaterThanOrEqual(2);
      expect(setAuditContext).toHaveBeenCalledTimes(begins);
      expect(setAuditContext).toHaveBeenCalledWith(client, PLATFORM, 'whatsapp.admin_outbox');
      const beginOrders = query.mock.calls
        .map(([sql], i) => (sql === 'BEGIN' ? query.mock.invocationCallOrder[i] : null))
        .filter((n): n is number => n !== null);
      const auditOrders = (setAuditContext as jest.Mock).mock.invocationCallOrder;
      beginOrders.forEach((beginOrder, i) => expect(auditOrders[i]).toBeGreaterThan(beginOrder));
      // Within the transaction that records the delivery, the platform is
      // stated after its BEGIN and before the record.
      const recordIndex = query.mock.calls.findIndex(([sql]) => /support_record_admin_delivery/.test(String(sql)));
      const recordOrder = query.mock.invocationCallOrder[recordIndex];
      const lastBeginBefore = Math.max(...beginOrders.filter((n) => n < recordOrder));
      expect(auditOrders.some((n) => n > lastBeginBefore && n < recordOrder)).toBe(true);
    });

    it('never calls the legacy delivery recorder', async () => {
      const { query, client } = adminClient([adminRow()], true);
      await sendPendingAdminOutbox(client, PLATFORM);
      expect(callsTo(query, /record_admin_whatsapp_delivery/)).toEqual([]);
    });
  });

  describe('sendTwilioWhatsAppMessage window argument', () => {
    const templateRow = {
      body: null,
      content_template: 'admin_support_reply_v2_es',
      content_variables: { '1': 'Una linea', '2': 'extra', __fallback_body: 'Texto\ncompleto' },
    };

    it('sessionWindowOpen: true sends the fallback body freeform even when the template is mapped', async () => {
      await sendTwilioWhatsAppMessage(`whatsapp:${NUMBER}`, templateRow, { sessionWindowOpen: true });
      expect(sentForm().get('Body')).toBe('Texto\ncompleto');
      expect(sentForm().get('ContentSid')).toBeNull();
    });

    it('sessionWindowOpen: false sends the template with variable "1" only', async () => {
      await sendTwilioWhatsAppMessage(`whatsapp:${NUMBER}`, templateRow, { sessionWindowOpen: false });
      expect(sentForm().get('ContentSid')).toBe('HX_admin_v2_es');
      expect(JSON.parse(sentForm().get('ContentVariables') as string)).toEqual({ '1': 'Una linea' });
    });

    it('sessionWindowOpen: false never falls back to freeform when the template is not mapped', async () => {
      secretWith({});
      await expect(sendTwilioWhatsAppMessage(`whatsapp:${NUMBER}`, templateRow, { sessionWindowOpen: false }))
        .rejects.toThrow('Twilio template missing: admin_support_reply_v2_es');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('without the argument, behaviour is unchanged (mapped template, every variable)', async () => {
      await sendTwilioWhatsAppMessage(`whatsapp:${NUMBER}`, templateRow);
      expect(sentForm().get('ContentSid')).toBe('HX_admin_v2_es');
      expect(JSON.parse(sentForm().get('ContentVariables') as string)).toEqual({ '1': 'Una linea', '2': 'extra' });
    });
  });
});
