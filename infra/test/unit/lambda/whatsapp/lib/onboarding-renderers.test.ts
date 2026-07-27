const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  ALL_MESSAGE_CATEGORIES,
  registerOnboardingRenderers,
  createReleaseRenderer,
  categoryRenderers,
} from '../../../../../lambda/whatsapp/lib/onboarding-renderers';
import {
  _clearCategoryRenderersForTests,
  enqueueWorkerMessage,
} from '../../../../../lambda/whatsapp/lib/worker-delivery-gateway';
import type {
  MessageCategory,
  PreferredLanguage,
  ReleaseRenderRequest,
  WorkerMessageIntentInput,
} from '../../../../../lambda/whatsapp/lib/onboarding-types';

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RAW_PHONE = '+15551234567';
const OTP = '482913';
const RAW_INBOUND = 'this is the raw inbound body the worker sent';

function baseInput(overrides: Partial<WorkerMessageIntentInput> = {}): WorkerMessageIntentInput {
  return {
    workerId: WORKER_ID,
    category: 'job_alert',
    ownerService: 'job-alert',
    sourceType: 'job',
    sourceId: 'job-1',
    dedupeKey: 'job_alert:job-1:worker-1',
    priority: 5,
    expiresAt: null,
    payload: {},
    ...overrides,
  };
}

/**
 * Mock PoolClient: answers any query with a row containing the phone/lang.
 * `calls` records the exact SQL text issued, so tests can assert renderers
 * query the real schema rather than trusting an unconditional stub.
 */
function mockClient(opts: {
  whatsappNumber?: string | null;
  preferredLanguage?: PreferredLanguage;
} = {}) {
  const whatsappNumber = opts.whatsappNumber === undefined ? RAW_PHONE : opts.whatsappNumber;
  const preferredLanguage = opts.preferredLanguage ?? 'en';
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return {
      rows: [
        {
          whatsapp_number: whatsappNumber,
          preferred_language: preferredLanguage,
        },
      ],
    };
  });
  return { query, calls } as any;
}

/**
 * Real scripted PoolClient for driving `enqueueWorkerMessage` end to end
 * (worker-delivery-gateway.ts:69), matched by SQL substring rather than
 * call order. Mirrors worker-delivery-gateway.test.ts's `scriptedClient`
 * so F3's registration tests exercise the real consumer, not a role-play
 * of "did some registration function run".
 */
function scriptedEnqueueClient(opts: {
  gateRow?: Record<string, unknown> | null;
  deferredDeliveryEnabled?: boolean;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let intentInsertCallCount = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO worker_message_intents/.test(sql)) {
      intentInsertCallCount += 1;
      return {
        rows: [{
          id: `intent-${intentInsertCallCount}`,
          outbox_id: null,
          status: 'deferred',
        }],
      };
    }
    if (/FROM worker_onboarding_state/.test(sql)) {
      return { rows: opts.gateRow === undefined || opts.gateRow === null ? [] : [opts.gateRow] };
    }
    if (/FROM whatsapp_runtime_controls/.test(sql)) {
      return {
        rows: [{
          control_key: 'deferred_delivery_enabled',
          enabled: opts.deferredDeliveryEnabled ?? false,
          phone_hashes: [],
          global_enabled: false,
        }],
      };
    }
    if (/UPDATE worker_message_intents/.test(sql) && /SET status/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT status FROM worker_message_intents/.test(sql)) {
      return { rows: [{ status: 'eligible' }] };
    }
    if (/INSERT INTO whatsapp_outbox/.test(sql)) {
      return { rows: [{ id: 'outbox-1' }] };
    }
    if (/UPDATE worker_message_intents SET outbox_id/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    // loadVerifiedRecipient's SELECT ... FROM users / worker_workflow_runs.
    if (/FROM users/.test(sql)) {
      return { rows: [{ whatsapp_number: RAW_PHONE, preferred_language: 'en' }] };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, client: { query } as any, calls };
}

const readyGateRow = {
  user_id: WORKER_ID,
  lifecycle: 'ready',
  run_id: null,
  workflow_version: null,
  current_step_key: null,
  status: null,
  preferred_language: 'es',
  lock_version: null,
};

function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (v && typeof v === 'object') {
      for (const child of Object.values(v)) visit(child);
    }
  };
  visit(value);
  return out;
}

function assertNoLeaks(value: unknown) {
  const strings = collectStrings(value).join('\n');
  expect(strings).not.toContain(OTP);
  expect(strings).not.toContain(RAW_PHONE);
  expect(strings).not.toContain(RAW_INBOUND);
}

describe('onboarding-renderers', () => {
  beforeEach(() => {
    _clearCategoryRenderersForTests();
  });

  describe('category coverage', () => {
    it('has a renderer for every member of the canonical MessageCategory union', () => {
      for (const category of ALL_MESSAGE_CATEGORIES) {
        expect(categoryRenderers[category]).toBeDefined();
        expect(typeof categoryRenderers[category]).toBe('function');
      }
      // Also make sure the map has no extra/missing keys vs the union array.
      expect(Object.keys(categoryRenderers).sort()).toEqual(
        [...ALL_MESSAGE_CATEGORIES].sort(),
      );
    });
  });

  describe('registerOnboardingRenderers', () => {
    // These assert the OBSERVABLE outcome through the real consumer
    // (enqueueWorkerMessage), not just that some call didn't throw: if
    // registerOnboardingRenderers() is gutted to a no-op, both privileged
    // intents resolve `renderer_unavailable` with no outbox row, and these
    // tests fail.

    it('registers the onboarding category renderer so an onboarding-v2 intent renders instead of resolving renderer_unavailable', async () => {
      registerOnboardingRenderers();
      const { client, calls } = scriptedEnqueueClient({ gateRow: null });

      const { decision } = await enqueueWorkerMessage(
        client,
        baseInput({
          category: 'onboarding',
          ownerService: 'onboarding-v2',
          dedupeKey: 'onboarding:reg-test:1',
        }),
      );

      expect(decision.action).toBe('allow');
      expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(true);
      expect(calls.some((c) => Array.isArray(c.params) && c.params.includes('renderer_unavailable'))).toBe(false);
    });

    it('registers the security category renderer so an identity intent renders instead of resolving renderer_unavailable', async () => {
      registerOnboardingRenderers();
      const { client, calls } = scriptedEnqueueClient({ gateRow: null });

      const { decision } = await enqueueWorkerMessage(
        client,
        baseInput({
          category: 'security',
          ownerService: 'identity',
          dedupeKey: 'security:reg-test:1',
        }),
      );

      expect(decision.action).toBe('allow');
      expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(true);
      expect(calls.some((c) => Array.isArray(c.params) && c.params.includes('renderer_unavailable'))).toBe(false);
    });

    it('is idempotent: calling it twice, including after a registry clear, still renders both privileged categories', async () => {
      registerOnboardingRenderers();
      registerOnboardingRenderers();
      // Simulate a mid-suite registry clear (as another suite's beforeEach
      // would do) followed by a warm-start re-registration.
      _clearCategoryRenderersForTests();
      registerOnboardingRenderers();

      const onboardingClient = scriptedEnqueueClient({ gateRow: null });
      const onboardingResult = await enqueueWorkerMessage(
        onboardingClient.client,
        baseInput({
          category: 'onboarding',
          ownerService: 'onboarding-v2',
          dedupeKey: 'onboarding:reg-test:2',
        }),
      );
      expect(onboardingResult.decision.action).toBe('allow');
      expect(
        onboardingClient.calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql)),
      ).toBe(true);

      const securityClient = scriptedEnqueueClient({ gateRow: null });
      const securityResult = await enqueueWorkerMessage(
        securityClient.client,
        baseInput({
          category: 'security',
          ownerService: 'identity',
          dedupeKey: 'security:reg-test:2',
        }),
      );
      expect(securityResult.decision.action).toBe('allow');
      expect(
        securityClient.calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql)),
      ).toBe(true);
    });
  });

  describe('category renderers structural safety', () => {
    it('renderer functions never touch network/clock globals directly (source scan)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../../../../../lambda/whatsapp/lib/onboarding-renderers.ts'),
        'utf8',
      );
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/Date\.now\s*\(/);
      expect(src).not.toMatch(/new Date\s*\(/);
      expect(src).not.toMatch(/setTimeout|setInterval/);
    });

    it('uses parameterized queries only (no string-concatenated SQL)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../../../../../lambda/whatsapp/lib/onboarding-renderers.ts'),
        'utf8',
      );
      // No template-literal SQL interpolation of variables into query strings.
      expect(src).not.toMatch(/query\(`[^`]*\$\{/);
    });

    it('resolves preferred_language from worker_workflow_runs, never from worker_onboarding_state (which has no such column)', async () => {
      // worker_onboarding_state's real columns (migration-verified) are
      // exactly: id, user_id, lifecycle, lifecycle_changed_at, ready_at,
      // created_at, updated_at. preferred_language lives on
      // worker_workflow_runs / worker_identity_challenges. A query that
      // selects preferred_language off worker_onboarding_state throws
      // 42703 against the real schema; this asserts the SQL shape itself,
      // not just that a jest.fn() mock answered without validating it.
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      await categoryRenderers.onboarding(client, baseInput({ category: 'onboarding' }));

      expect(client.calls.length).toBeGreaterThan(0);
      for (const call of client.calls) {
        if (/preferred_language/.test(call.sql)) {
          expect(call.sql).toMatch(/worker_workflow_runs/);
          // Must not select preferred_language off worker_onboarding_state.
          expect(call.sql).not.toMatch(/worker_onboarding_state[\s\S]*preferred_language/);
          const fromOnboardingState = /FROM\s+worker_onboarding_state\s+(\w+)/i.exec(call.sql);
          if (fromOnboardingState) {
            const alias = fromOnboardingState[1];
            expect(call.sql).not.toMatch(new RegExp(`${alias}\\.preferred_language`));
          }
        }
      }
    });

    it('each category renderer resolves recipient/lang via the client and returns null-safe output when unresolved', async () => {
      for (const category of ALL_MESSAGE_CATEGORIES) {
        const client = mockClient({ whatsappNumber: null });
        const input = baseInput({ category });
        const result = await categoryRenderers[category](client, input);
        // When there's no verified recipient, renderer must not throw and
        // must not fabricate a phone number.
        if (result) {
          assertNoLeaks(result);
        }
      }
    });

    it('renders a message with the resolved recipient when found, with no leaks', async () => {
      for (const category of ALL_MESSAGE_CATEGORIES) {
        const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
        const input = baseInput({
          category,
          payload: { otp: OTP, inboundBody: RAW_INBOUND },
        });
        const result = await categoryRenderers[category](client, input);
        if (result) {
          expect(result.whatsappNumber).toBe(RAW_PHONE);
          assertNoLeaks({ body: result.body, contentTemplate: result.contentTemplate });
        }
      }
    });
  });

  describe('payload-carried prompt copy (post-OTP dead-end regression)', () => {
    // Regression: the onboarding/security category renderers used to ignore
    // the intent payload and always send their default copy. Every
    // post-bind step prompt (legal.review, profile.*, trust.*) therefore
    // went out as the terminal "Your profile is ready." message, dead-ending
    // onboarding immediately after OTP verification.

    it('renders the step prompt carried in an onboarding intent payload, not the completion copy', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      const input = baseInput({
        category: 'onboarding',
        ownerService: 'onboarding-v2',
        sourceType: 'onboarding_v2:legal.review',
        payload: {
          templateName: 'v2_legal_review',
          variables: { '1': 'https://tos.example', '2': 'https://privacy.example' },
          fallbackBody: 'Please review our terms of service before continuing.',
          lang: 'en',
        },
      });
      const result = await categoryRenderers.onboarding(client, input);
      expect(result).not.toBeNull();
      expect(result!.contentTemplate).toBe('v2_legal_review');
      // __fallback_body must ride along in contentVariables: outbox.ts's
      // sendTwilioWhatsAppMessage reads it to degrade to plain text when the
      // named ContentSid isn't registered with Twilio (the case for every
      // v2_-prefixed template today — none exist in the Twilio secret yet),
      // stripping it before any real templated send. Without it here, an
      // unregistered template hard-throws ('Twilio template missing')
      // instead of degrading, exactly what broke prod after the first fix.
      expect(result!.contentVariables).toEqual({
        '1': 'https://tos.example',
        '2': 'https://privacy.example',
        __fallback_body: 'Please review our terms of service before continuing.',
      });
      // whatsapp_outbox_body_or_template requires body IS NULL when a
      // content_template is set — a real interactive prompt (e.g. the OTP
      // send) always carries templateName + fallbackBody together, so
      // sending both here previously violated the DB check constraint
      // (23514) and silently dropped every templated step prompt, including
      // the OTP prompt itself.
      expect(result!.body).toBeNull();
    });

    it('never emits both body and contentTemplate (whatsapp_outbox_body_or_template invariant)', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      // Shape of buildV2OtpPrompt's output as enqueued by sendPreAuthPrompt:
      // templateName and fallbackBody are always both present.
      const input = baseInput({
        category: 'security',
        ownerService: 'identity',
        sourceType: 'onboarding_v2:identity.verify_otp',
        payload: {
          templateName: 'v2_onboarding_otp_en',
          variables: { '1': '5', '2': 'otp:resend', '3': 'Resend' },
          fallbackBody: 'We sent you a 6-digit code. It expires in 5 minutes.',
          lang: 'en',
        },
      });
      const result = await categoryRenderers.security(client, input);
      expect(result).not.toBeNull();
      const hasBody = result!.body !== null;
      const hasTemplate = result!.contentTemplate !== null && result!.contentVariables !== null;
      expect(hasBody).toBe(false);
      expect(hasTemplate).toBe(true);
      expect(hasBody && hasTemplate).toBe(false);
    });

    it('carries fallbackBody through as content_variables.__fallback_body so an unregistered Twilio template degrades to plain text instead of hard-failing', async () => {
      // outbox.ts's sendTwilioWhatsAppMessage: if secret.templates has no
      // ContentSid for content_template, it sends content_variables
      // .__fallback_body as plain Body instead, and only throws
      // 'Twilio template missing' when that key is absent too. Every
      // v2_-prefixed template name is unregistered in Twilio today, so this
      // key is what keeps every step prompt actually deliverable in prod.
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      const input = baseInput({
        category: 'onboarding',
        ownerService: 'onboarding-v2',
        payload: {
          templateName: 'v2_onboarding_legal_en',
          variables: { '1': 'https://jale.app/legal/tos' },
          fallbackBody: 'Please review our terms of service before continuing.',
        },
      });
      const result = await categoryRenderers.onboarding(client, input);
      expect(result!.contentVariables?.__fallback_body).toBe(
        'Please review our terms of service before continuing.',
      );
    });

    it('renders plain text carried as payload.body (sendTemplateMessage shape)', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'es' });
      const input = baseInput({
        category: 'onboarding',
        ownerService: 'onboarding-v2',
        sourceType: 'onboarding_v2:v2_ready',
        payload: { body: 'Tu perfil esta listo. Te avisaremos cuando haya trabajo para ti.', lang: 'es' },
      });
      const result = await categoryRenderers.onboarding(client, input);
      expect(result!.body).toBe('Tu perfil esta listo. Te avisaremos cuando haya trabajo para ti.');
      expect(result!.contentTemplate).toBeNull();
    });

    it('keeps the completion copy as the fallback for an onboarding intent with no payload copy', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      const input = baseInput({ category: 'onboarding', ownerService: 'onboarding-v2', payload: {} });
      const result = await categoryRenderers.onboarding(client, input);
      expect(result!.body).toContain('Your profile is ready');
    });

    it('security intents honor payload copy and keep the security notice as fallback', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      const withPayload = await categoryRenderers.security(
        client,
        baseInput({
          category: 'security',
          ownerService: 'identity',
          payload: { fallbackBody: 'Enter the 6-digit code we sent you.' },
        }),
      );
      expect(withPayload!.body).toBe('Enter the 6-digit code we sent you.');

      const withoutPayload = await categoryRenderers.security(
        client,
        baseInput({ category: 'security', ownerService: 'identity', payload: {} }),
      );
      expect(withoutPayload!.body).toContain('Security notice');
    });

    it('non-string payload fields are ignored rather than rendered', async () => {
      const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
      const input = baseInput({
        category: 'onboarding',
        ownerService: 'onboarding-v2',
        payload: { fallbackBody: 42, body: { nested: true }, templateName: '', variables: 'not-an-object' },
      });
      const result = await categoryRenderers.onboarding(client, input);
      expect(result!.body).toContain('Your profile is ready');
    });
  });

  describe('createReleaseRenderer', () => {
    const languages: PreferredLanguage[] = ['en', 'es'];

    function jobs(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        jobId: `job-${i}`,
        title: `Title ${i}`,
        companyName: `Company ${i}`,
        score: 1,
      }));
    }

    const kinds: ReadonlyArray<(lang: PreferredLanguage) => ReleaseRenderRequest> = [
      (language) => ({ kind: 'onboarding_complete', workerId: WORKER_ID, language }),
      (language) => ({
        kind: 'account_notice',
        workerId: WORKER_ID,
        language,
        sourceType: 'profile',
        sourceId: 'notice-1',
      }),
      (language) => ({
        kind: 'job_alert_digest',
        workerId: WORKER_ID,
        language,
        jobs: jobs(3),
      }),
      (language) => ({
        kind: 'employer_chat_single',
        workerId: WORKER_ID,
        language,
        conversationId: 'conv-1',
        companyName: 'Acme Co',
        jobTitle: 'Electrician',
      }),
      (language) => ({
        kind: 'employer_chat_summary',
        workerId: WORKER_ID,
        language,
        conversationCount: 4,
      }),
    ];

    it('handles all five kinds in both languages (10 combinations)', async () => {
      const renderer = createReleaseRenderer();
      let count = 0;
      for (const buildRequest of kinds) {
        for (const language of languages) {
          const request = buildRequest(language);
          const result = await renderer.render(request);
          expect(result).toBeDefined();
          expect(result.body !== null || result.contentTemplate !== null).toBe(true);
          count += 1;
        }
      }
      expect(count).toBe(10);
    });

    it('produces different EN and ES output for each release kind', async () => {
      const renderer = createReleaseRenderer();
      for (const buildRequest of kinds) {
        const enResult = await renderer.render(buildRequest('en'));
        const esResult = await renderer.render(buildRequest('es'));
        const enText = JSON.stringify(enResult);
        const esText = JSON.stringify(esResult);
        expect(enText).not.toEqual(esText);
      }
    });

    it('caps the job-alert digest at 10 entries and references JOBS for the full list', async () => {
      const renderer = createReleaseRenderer();
      const request: ReleaseRenderRequest = {
        kind: 'job_alert_digest',
        workerId: WORKER_ID,
        language: 'en',
        jobs: jobs(14),
      };
      const result = await renderer.render(request);
      const text = `${result.body ?? ''} ${JSON.stringify(result.contentVariables ?? {})}`;

      // Count how many of the 14 job titles appear verbatim in the output.
      const renderedCount = jobs(14).filter((j) => text.includes(j.title)).length;
      expect(renderedCount).toBeLessThanOrEqual(10);
      expect(text).toContain('JOBS');
    });

    it('does not exceed the 10-entry cap even for exactly 10 or fewer jobs', async () => {
      const renderer = createReleaseRenderer();
      const result = await renderer.render({
        kind: 'job_alert_digest',
        workerId: WORKER_ID,
        language: 'en',
        jobs: jobs(10),
      });
      const text = `${result.body ?? ''} ${JSON.stringify(result.contentVariables ?? {})}`;
      const renderedCount = jobs(10).filter((j) => text.includes(j.title)).length;
      expect(renderedCount).toBeLessThanOrEqual(10);
    });

    it('renders the existing single-conversation invitation copy', async () => {
      const renderer = createReleaseRenderer();
      const result = await renderer.render({
        kind: 'employer_chat_single',
        workerId: WORKER_ID,
        language: 'en',
        conversationId: 'conv-1',
        companyName: 'Acme Co',
        jobTitle: 'Electrician',
      });
      const text = `${result.body ?? ''} ${JSON.stringify(result.contentVariables ?? {})}`;
      expect(text).toContain('Acme Co');
      expect(text).toContain('Electrician');
    });

    it('renders exactly one multi-employer summary message mentioning multiple employers, a View Chats action, and the CHATS/MENSAJES fallback', async () => {
      const renderer = createReleaseRenderer();

      const enResult = await renderer.render({
        kind: 'employer_chat_summary',
        workerId: WORKER_ID,
        language: 'en',
        conversationCount: 5,
      });
      const enText = `${enResult.body ?? ''} ${JSON.stringify(enResult.contentVariables ?? {})}`;
      expect(enText.toUpperCase()).toContain('CHATS');
      expect(enText).toMatch(/employer/i);

      const esResult = await renderer.render({
        kind: 'employer_chat_summary',
        workerId: WORKER_ID,
        language: 'es',
        conversationCount: 5,
      });
      const esText = `${esResult.body ?? ''} ${JSON.stringify(esResult.contentVariables ?? {})}`;
      expect(esText.toUpperCase()).toContain('MENSAJES');
    });

    it('release outputs never contain an OTP, raw phone number, or raw inbound message body', async () => {
      const renderer = createReleaseRenderer();
      for (const buildRequest of kinds) {
        for (const language of languages) {
          const result = await renderer.render(buildRequest(language));
          assertNoLeaks(result);
        }
      }
    });

    it('release rendering performs no network/clock call (source scan covers this module too)', () => {
      // Covered by the earlier source-scan test since both live in the same file.
      expect(true).toBe(true);
    });
  });
});

// ── Single-job alert content template (2026-07-27 parity-audit fix) ──────
//
// A single-job alert reaches DORMANT ready workers; outside WhatsApp's 24h
// customer-service window a freeform (contentTemplate: null) send is
// rejected by Meta, so it must ride v1's approved job_alert_* template —
// which also restores the Accept/Decline/Info buttons (payload contract
// `job-<id>`, parseButtonPayload in flows.ts).
describe('job_alert category renderer: single-job template send', () => {
  const singleJob = {
    jobId: 'job-9',
    title: 'Electricista',
    companyName: 'ACME',
    score: 1,
    location: 'El Paso, TX',
    pay: '$30/hr',
  };

  it('renders the approved v1 template with the exact variable contract and a plain-text fallback', async () => {
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'es' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [singleJob] } }));

    expect(result).not.toBeNull();
    expect(result!.body).toBeNull();
    expect(result!.contentTemplate).toBe('job_alert_es');
    expect(result!.contentVariables).toMatchObject({
      '1': 'Electricista',
      '2': 'ACME',
      '3': 'El Paso, TX',
      '4': '$30/hr',
      '5': 'job-job-9',
    });
    // Unregistered ContentSid must degrade to text, never hard-fail.
    expect(result!.contentVariables!.__fallback_body).toContain('Electricista');
  });

  it('uses the English template for an en recipient', async () => {
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [singleJob] } }));
    expect(result!.contentTemplate).toBe('job_alert_en');
  });

  // Task 2/A2 fix (2026-07-27): a job posted with no pay (jobs.pay is
  // nullable, migration 003) or a pre-existing deferred intent that never
  // carried location/pay must STILL render the content template — degrading
  // to the plain-text digest is exactly the undeliverable-alert bug this
  // renderer exists to fix, because Twilio rejects freeform sends outside
  // the 24h customer-service window.
  it('renders the template with a bilingual placeholder when pay is missing', async () => {
    const { pay, ...jobWithoutPay } = singleJob;
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [jobWithoutPay] } }));

    expect(result!.contentTemplate).toBe('job_alert_en');
    expect(result!.contentVariables!['4']).toBe('Pay not specified');
  });

  it('renders the template with a bilingual placeholder when pay is missing (Spanish)', async () => {
    const { pay, ...jobWithoutPay } = singleJob;
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'es' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [jobWithoutPay] } }));

    expect(result!.contentTemplate).toBe('job_alert_es');
    expect(result!.contentVariables!['4']).toBe('Pago no especificado');
  });

  it('renders the template with a bilingual placeholder when location is missing', async () => {
    const { location, ...jobWithoutLocation } = singleJob;
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [jobWithoutLocation] } }));

    expect(result!.contentTemplate).toBe('job_alert_en');
    expect(result!.contentVariables!['3']).toBe('Location not specified');
  });

  it('still degrades to the plain-text digest when jobId is missing (never a template with a broken button payload)', async () => {
    const { jobId, ...jobWithoutId } = singleJob;
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
    const result = await categoryRenderers.job_alert(client, baseInput({ payload: { jobs: [jobWithoutId] } }));

    expect(result!.contentTemplate).toBeNull();
    expect(result!.body).toContain('Electricista');
  });

  it('keeps the multi-job digest as plain text (release-time send, always inside the reply window)', async () => {
    const client = mockClient({ whatsappNumber: RAW_PHONE, preferredLanguage: 'en' });
    const result = await categoryRenderers.job_alert(client, baseInput({
      payload: { jobs: [singleJob, { ...singleJob, jobId: 'job-10', title: 'Plomero' }] },
    }));

    expect(result!.contentTemplate).toBeNull();
    expect(result!.body).toContain('Electricista');
    expect(result!.body).toContain('Plomero');
  });
});
