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
    admin_support_reply_v2_es: 'HXfff',
    admin_support_reply_v2_en: 'HXggg',
    application_web_completed_es: 'HXiii',
    application_web_completed_en: 'HXjjj',
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
    const approval = { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } };
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': approval, 'HXbbb/ApprovalRequests': approval,
        'HXccc/ApprovalRequests': approval, 'HXddd/ApprovalRequests': approval,
        'HXeee/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'unsubmitted' } } },
        'HXfff/ApprovalRequests': approval, 'HXggg/ApprovalRequests': approval,
        'HXiii/ApprovalRequests': approval, 'HXjjj/ApprovalRequests': approval,
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.rows).toHaveLength(9);
  });

  // Sprint 28 (F28): outside the 24h window the web completion line is sent
  // only as this template, so it is required like the employer templates:
  // seeded, mapped, and approved.
  it.each(['application_web_completed_es', 'application_web_completed_en'] as const)(
    'fails when %s is missing from the secret',
    async (key) => {
      const { [key]: _dropped, ...templates } = SECRET.templates;
      const approval = { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } };
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning({ ...SECRET, templates }),
        fetchImpl: fetchImplFor({ ApprovalRequests: approval }),
      });
      expect(result.failures).toEqual([`${key}: missing from the secret templates map`]);
    },
  );

  it('fails when a web completion template is mapped but not approved', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXiii/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'pending', category: 'UTILITY' } } },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } },
      }),
    });
    expect(result.failures).toEqual([
      "application_web_completed_es: WhatsApp approval status is 'pending' (must be 'approved')",
    ]);
  });

  it('fails when a web completion SID no longer exists', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'Content/HXjjj': { ok: false, status: 404 },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } },
      }),
    });
    expect(result.failures).toEqual(['application_web_completed_en: Content SID not found (HTTP 404)']);
  });

  // 2026-09-04: Meta recategorised three pending application_* templates to
  // MARKETING, which cannot carry a transactional notification outside the
  // 24h window. Status alone said "pending" on all of them, so the defect was
  // invisible to this command. The category now travels with the row.
  it('reports the WhatsApp category alongside the status', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': {
          ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } },
        },
        'ApprovalRequests': {
          ok: true, body: { whatsapp: { status: 'approved', category: 'MARKETING' } },
        },
      }),
    });
    const invite = result.rows.find((row) => row.key === 'employer_message_invite_es');
    expect(invite?.whatsappCategory).toBe('UTILITY');
    expect(result.rows.find((row) => row.key === 'job_alert_es')?.whatsappCategory)
      .toBe('MARKETING');
  });

  it('leaves the category null when the approval read fails or omits it', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': { ok: false, status: 500 },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved' } } },
      }),
    });
    expect(result.rows.find((row) => row.key === 'employer_message_invite_es')?.whatsappCategory)
      .toBeNull();
    expect(result.rows.find((row) => row.key === 'job_alert_es')?.whatsappCategory).toBeNull();
  });

  it('fails on an unapproved employer template but tolerates non-employer ones', async () => {
    const result = await verifyTwilioTemplates({
      client: secretsClientReturning(SECRET),
      fetchImpl: fetchImplFor({
        'HXaaa/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'unsubmitted' } } },
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } },
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
        'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } },
      }),
    });
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('employer_message_invite_es'),
      expect.stringContaining('employer_message_resume_en: missing'),
    ]));
  });

  // Sprint 28: an admin reply outside the worker's 24-hour window can only go
  // as the v2 support-reply template, so the pair is required like the
  // employer ones. The unversioned keys must never be mapped.
  describe('support reply templates', () => {
    const allApproved = { 'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } } };

    it.each(['admin_support_reply_v2_es', 'admin_support_reply_v2_en'] as const)(
      'fails when %s is missing from the secret templates map',
      async (key) => {
        const { [key]: _dropped, ...partial } = SECRET.templates;
        const result = await verifyTwilioTemplates({
          client: secretsClientReturning({ ...SECRET, templates: partial }),
          fetchImpl: fetchImplFor(allApproved),
        });
        expect(result.failures).toEqual([`${key}: missing from the secret templates map`]);
      },
    );

    it('fails when a support reply template is not WhatsApp-approved yet', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({
          'HXggg/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'pending', category: 'UTILITY' } } },
          ...allApproved,
        }),
      });
      expect(result.failures).toEqual([
        "admin_support_reply_v2_en: WhatsApp approval status is 'pending' (must be 'approved')",
      ]);
    });

    it('fails when a support reply Content SID does not exist', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({ 'Content/HXfff': { ok: false, status: 404 }, ...allApproved }),
      });
      expect(result.failures).toEqual(['admin_support_reply_v2_es: Content SID not found (HTTP 404)']);
    });

    it.each(['admin_support_reply_es', 'admin_support_reply_en'])(
      'fails when the unversioned %s is mapped',
      async (key) => {
        const result = await verifyTwilioTemplates({
          client: secretsClientReturning({ ...SECRET, templates: { ...SECRET.templates, [key]: 'HXhhh' } }),
          fetchImpl: fetchImplFor(allApproved),
        });
        expect(result.failures).toEqual([expect.stringContaining(`${key}: must not be mapped`)]);
      },
    );
  });

  // The unversioned pair stays mapped until the deploy that stops reading it,
  // so before that deploy the check runs with `beforeDeploy` and reports the
  // pair as a notice. Every other rule still fails the run.
  describe('beforeDeploy', () => {
    const allApproved = { 'ApprovalRequests': { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } } };
    const RETIRED = ['admin_support_reply_es', 'admin_support_reply_en'] as const;
    const WITH_RETIRED = {
      ...SECRET,
      templates: { ...SECRET.templates, admin_support_reply_es: 'HXkkk', admin_support_reply_en: 'HXlll' },
    };

    it('passes with the retired pair mapped, and names each key in a notice', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(WITH_RETIRED),
        fetchImpl: fetchImplFor(allApproved),
        beforeDeploy: true,
      });
      expect(result.failures).toEqual([]);
      expect(result.notices).toEqual(RETIRED.map((key) => expect.stringContaining(key)));
      for (const notice of result.notices) {
        expect(notice).toContain('remove after the deploy');
        expect(notice).toContain('--unset-template');
      }
      // The pair is still listed, informationally, like any other mapped key.
      expect(result.rows.map((row) => row.key)).toEqual(expect.arrayContaining([...RETIRED]));
    });

    it('fails on the retired pair without the option, as before', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(WITH_RETIRED),
        fetchImpl: fetchImplFor(allApproved),
      });
      expect(result.failures).toEqual(RETIRED.map((key) => expect.stringContaining(`${key}: must not be mapped`)));
      expect(result.notices).toEqual([]);
    });

    it('still fails when a required key is missing', async () => {
      const { admin_support_reply_v2_es: _dropped, ...partial } = WITH_RETIRED.templates;
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning({ ...WITH_RETIRED, templates: partial }),
        fetchImpl: fetchImplFor(allApproved),
        beforeDeploy: true,
      });
      expect(result.failures).toEqual(['admin_support_reply_v2_es: missing from the secret templates map']);
      expect(result.notices).toHaveLength(2);
    });

    it('still fails on an unapproved required template', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(WITH_RETIRED),
        fetchImpl: fetchImplFor({
          'HXaaa/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'pending' } } },
          ...allApproved,
        }),
        beforeDeploy: true,
      });
      expect(result.failures).toEqual([
        "employer_message_invite_es: WhatsApp approval status is 'pending' (must be 'approved')",
      ]);
    });

    it('reports no notice once the retired pair is gone', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor(allApproved),
        beforeDeploy: true,
      });
      expect(result.failures).toEqual([]);
      expect(result.notices).toEqual([]);
    });
  });

  // A template Meta files as MARKETING is not a transactional message, and
  // the sprint 28 pairs exist to carry transactional replies outside the
  // 24-hour window. Their category is checked like their approval status.
  // The employer templates predate this rule, so for them a non-UTILITY
  // category is reported without failing the run.
  describe('WhatsApp category', () => {
    const utility = { ok: true, body: { whatsapp: { status: 'approved', category: 'UTILITY' } } };
    const marketing = { ok: true, body: { whatsapp: { status: 'approved', category: 'MARKETING' } } };
    const SPRINT28_SIDS = {
      admin_support_reply_v2_es: 'HXfff',
      admin_support_reply_v2_en: 'HXggg',
      application_web_completed_es: 'HXiii',
      application_web_completed_en: 'HXjjj',
    } as const;
    const SPRINT28_KEYS = Object.keys(SPRINT28_SIDS) as Array<keyof typeof SPRINT28_SIDS>;

    it('passes when every required template is approved as UTILITY', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({ ApprovalRequests: utility }),
      });
      expect(result.failures).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    describe.each([false, true])('beforeDeploy %s', (beforeDeploy) => {
      it.each(SPRINT28_KEYS)('fails when %s is approved as MARKETING', async (key) => {
        const result = await verifyTwilioTemplates({
          client: secretsClientReturning(SECRET),
          fetchImpl: fetchImplFor({ [`${SPRINT28_SIDS[key]}/ApprovalRequests`]: marketing, ApprovalRequests: utility }),
          beforeDeploy,
        });
        expect(result.failures).toEqual([`${key}: WhatsApp category is 'MARKETING' (must be 'UTILITY')`]);
        expect(result.notices).toEqual([]);
      });
    });

    it.each(SPRINT28_KEYS)('fails when %s reports no category', async (key) => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({
          [`${SPRINT28_SIDS[key]}/ApprovalRequests`]: { ok: true, body: { whatsapp: { status: 'approved' } } },
          ApprovalRequests: utility,
        }),
      });
      expect(result.failures).toEqual([`${key}: WhatsApp category is 'unknown' (must be 'UTILITY')`]);
    });

    it('reports a pending MARKETING template on both counts', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({
          'HXggg/ApprovalRequests': { ok: true, body: { whatsapp: { status: 'pending', category: 'MARKETING' } } },
          ApprovalRequests: utility,
        }),
      });
      expect(result.failures).toEqual([
        "admin_support_reply_v2_en: WhatsApp approval status is 'pending' (must be 'approved')",
        "admin_support_reply_v2_en: WhatsApp category is 'MARKETING' (must be 'UTILITY')",
      ]);
    });

    it('reports a MARKETING employer template as a notice, not a failure', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({ 'HXaaa/ApprovalRequests': marketing, ApprovalRequests: utility }),
      });
      expect(result.failures).toEqual([]);
      expect(result.notices).toEqual([
        "employer_message_invite_es: WhatsApp category is 'MARKETING', not 'UTILITY'",
      ]);
    });

    it('checks no category on a template outside the required groups', async () => {
      // job_alert_es is informational: neither its status nor its category fails or notifies.
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({ 'HXeee/ApprovalRequests': marketing, ApprovalRequests: utility }),
      });
      expect(result.failures).toEqual([]);
      expect(result.notices).toEqual([]);
    });

    it('adds no category line for a required SID that does not exist', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning(SECRET),
        fetchImpl: fetchImplFor({ 'Content/HXfff': { ok: false, status: 404 }, ApprovalRequests: utility }),
      });
      expect(result.failures).toEqual(['admin_support_reply_v2_es: Content SID not found (HTTP 404)']);
    });

    it('keeps the retired-key notice and the category failure apart before the deploy', async () => {
      const result = await verifyTwilioTemplates({
        client: secretsClientReturning({
          ...SECRET,
          templates: { ...SECRET.templates, admin_support_reply_es: 'HXkkk' },
        }),
        fetchImpl: fetchImplFor({ 'HXggg/ApprovalRequests': marketing, ApprovalRequests: utility }),
        beforeDeploy: true,
      });
      expect(result.failures).toEqual(["admin_support_reply_v2_en: WhatsApp category is 'MARKETING' (must be 'UTILITY')"]);
      expect(result.notices).toEqual([expect.stringContaining('admin_support_reply_es: still mapped')]);
    });
  });
});
