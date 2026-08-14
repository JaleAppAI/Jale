import { verifyTwilioTemplates } from '../../../scripts/lib/verify-twilio-templates';

function secretsClientReturning(secret: object) {
  return { send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify(secret) }) } as any;
}

const SECRET = {
  accountSid: 'AC123',
  authToken: 'tok',
  templates: {
    employer_message_invite_es: 'HXaaa',
    employer_message_invite_en: 'HXbbb',
    employer_message_resume_es: 'HXccc',
    employer_message_resume_en: 'HXddd',
    job_alert_es: 'HXeee',
  },
};

function fetchImplFor(handlers: Record<string, { ok: boolean; status?: number; body?: object }>) {
  return jest.fn(async (url: string) => {
    const match = Object.entries(handlers).find(([fragment]) => url.includes(fragment));
    const spec = match?.[1] ?? { ok: true, body: {} };
    return {
      ok: spec.ok,
      status: spec.status ?? (spec.ok ? 200 : 404),
      json: async () => spec.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('verifyTwilioTemplates', () => {
  it('passes when every employer_message_* SID exists and is approved', async () => {
    const approval = { ok: true, body: { whatsapp: { status: 'approved' } } };
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': approval, 'HXbbb/ApprovalRequests': approval,
        'HXccc/ApprovalRequests': approval, 'HXddd/ApprovalRequests': approval,
        'HXeee/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'unsubmitted' } } },
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.rows).toHaveLength(5);
  });

  it('fails on an unapproved employer template but tolerates non-employer ones', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'unsubmitted' } } },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved' } } },
      }),
    });
    expect(result.failures).toEqual([
      expect.stringContaining('employer_message_invite_es'),
    ]);
  });

  it('fails on a missing SID (404) and a missing required key', async () => {
    const { templates, ...rest } = SECRET;
    const { employer_message_resume_en, ...partial } = templates;
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning({ ...rest, templates: partial }),
      fetchImpl: fetchImplFor({
        'Content/HXaaa': { ok: false, status: 404 },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved' } } },
      }),
    });
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('employer_message_invite_es'),
      expect.stringContaining('employer_message_resume_en: missing'),
    ]));
  });
});
