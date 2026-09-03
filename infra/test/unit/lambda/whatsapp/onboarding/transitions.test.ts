/**
 * L7 — the cohort ToS skip (`maybeSkipLegalReview`, onboarding/transitions.ts).
 *
 * The rule itself, in isolation: which evidence counts, which does not, and
 * what must NEVER happen (a second consent write). Both doors' call sites are
 * covered where they live — `onboarding-v2.test.ts` for WhatsApp, and
 * `test/unit/db/web-onboarding-door.integration.test.ts` for the web door
 * against the real `legal_consent_log` policies and grants.
 */

import { maybeSkipLegalReview } from '../../../../../lambda/whatsapp/onboarding/transitions';
import type { WorkerGate } from '../../../../../lambda/whatsapp/lib/onboarding-repository';
import type {
  OnboardingV2Deps,
  OnboardingV2InboundMessage,
  OnboardingV2Session,
} from '../../../../../lambda/whatsapp/onboarding/types';

const WORKER = 'worker-1';
const NOW = new Date('2026-09-02T10:00:00.000Z');
const REQUIRED = '1.0';

interface Recorded {
  advances: any[];
  prompts: string[];
  consentWrites: number;
}

/**
 * A client that answers the consent-evidence query with whatever the test
 * says, and the profile read (`loadProfileFromDb`) with an empty profile so
 * the skip's onward hop lands on the first missing field.
 */
function makeClient(evidenceRows: unknown[]): any {
  const queries: string[] = [];
  return {
    _queries: queries,
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (/legal_consent_log/.test(sql)) {
        return { rows: evidenceRows, rowCount: evidenceRows.length };
      }
      // loadProfileFromDb
      return {
        rows: [{
          full_name: null, city: null, main_trade: null, main_trade_other: null,
          years_experience: null, has_transportation: null, availability: null,
        }],
        rowCount: 1,
      };
    }),
  };
}

function makeDeps(rec: Recorded): OnboardingV2Deps {
  return {
    requiredLegalVersion: REQUIRED,
    workflowVersion: 2,
    voiceIntake: { enabled: false, startTrustTranscription: jest.fn(), ingestProfileVoiceNote: jest.fn() },
    recordLegalAcceptance: jest.fn(async () => {
      rec.consentWrites += 1;
      return { verified: true };
    }),
    repo: {
      advanceWorkflow: jest.fn(async (_c: any, input: any) => {
        rec.advances.push(input);
        return {
          userId: WORKER,
          lifecycle: 'onboarding',
          runId: input.runId,
          workflowVersion: 2,
          currentStepKey: input.toStepKey,
          status: input.status ?? 'active',
          preferredLanguage: 'en',
          lockVersion: 4,
        } as WorkerGate;
      }),
    },
    enqueueWorkerMessage: jest.fn(async () => undefined),
    adapters: { profile: { syncProfileForTrustHandoff: jest.fn(async () => ({ ready: true, missing: [] })) } },
  } as unknown as OnboardingV2Deps;
}

function makeSession(): OnboardingV2Session {
  return {
    id: 'web-request:1',
    user_id: WORKER,
    whatsapp_number: '+15125550000',
    language: 'en',
    conversation_state: 'onboarding',
    state_context: {},
  } as OnboardingV2Session;
}

function makeMsg(): OnboardingV2InboundMessage {
  return { from: '+15125550000', body: '', messageSid: 'web:abc' };
}

function makeGate(patch: Partial<WorkerGate> = {}): WorkerGate {
  return {
    userId: WORKER,
    lifecycle: 'onboarding',
    runId: 'run-1',
    workflowVersion: 2,
    currentStepKey: 'legal.review',
    status: 'active',
    preferredLanguage: 'en',
    lockVersion: 3,
    ...patch,
  } as WorkerGate;
}

describe('maybeSkipLegalReview', () => {
  let rec: Recorded;

  beforeEach(() => {
    rec = { advances: [], prompts: [], consentWrites: 0 };
  });

  it('skips a worker whose consent for THIS version is already on file, and takes no new consent', async () => {
    const client = makeClient([{ ok: true }]);
    const deps = makeDeps(rec);

    const result = await maybeSkipLegalReview(client, makeSession(), makeMsg(), deps, makeGate(), NOW);

    expect(result).not.toBeNull();
    // The first field the worker still owes us, not the Terms screen.
    expect(result!.stepKey).toBe('profile.name');

    expect(rec.advances).toHaveLength(1);
    expect(rec.advances[0].fromStepKey).toBe('legal.review');
    expect(rec.advances[0].toStepKey).toBe('profile.name');
    // The transition says plainly that no NEW consent was taken.
    expect(rec.advances[0].reason).toBe('legal_already_accepted');
    expect(rec.advances[0].contextPatch).toEqual({ legalSkipped: true });
    // And it carries no acceptance timestamp — the worker agreed earlier, and
    // pretending they agreed now would falsify the audit trail.
    expect(rec.advances[0].contextPatch).not.toHaveProperty('legalAcceptedAt');

    // THE POINT OF THE WHOLE FUNCTION: recordLegalAcceptance is never called.
    expect(rec.consentWrites).toBe(0);
    expect(deps.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it('respects the optimistic lock it was handed', async () => {
    const client = makeClient([{ ok: true }]);
    await maybeSkipLegalReview(client, makeSession(), makeMsg(), makeDeps(rec), makeGate({ lockVersion: 11 }), NOW);
    expect(rec.advances[0].expectedLockVersion).toBe(11);
  });

  // A FIRST-TIME worker. This is the case that must never regress: the Terms
  // screen is the only place consent is taken, and skipping it for someone who
  // has not agreed would mean onboarding a worker who never accepted anything.
  it('does NOT skip when there is no consent row at all', async () => {
    const client = makeClient([]);
    const deps = makeDeps(rec);

    const result = await maybeSkipLegalReview(client, makeSession(), makeMsg(), deps, makeGate(), NOW);

    expect(result).toBeNull();
    expect(rec.advances).toHaveLength(0);
    expect(deps.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  // The query asks for the REQUIRED version on both halves, so a worker who
  // accepted 0.9 gets the Terms for 1.0 — which is the entire point of
  // versioning them.
  it('does NOT skip when the stored version differs from the required one', async () => {
    const client = makeClient([]);
    const deps = makeDeps(rec);
    (deps as any).requiredLegalVersion = '2.0';

    const result = await maybeSkipLegalReview(client, makeSession(), makeMsg(), deps, makeGate(), NOW);

    expect(result).toBeNull();
    const consentSql = client._queries.find((q: string) => /legal_consent_log/.test(q));
    expect(consentSql).toBeDefined();
    // Both halves are checked against the SAME parameter: a log row whose
    // users.tos_version disagrees is a half-written consent, not a consent.
    expect(consentSql).toMatch(/document_version = \$2/);
    expect(consentSql).toMatch(/u\.tos_version = \$2/);
    expect(client.query.mock.calls[0][1]).toEqual([WORKER, '2.0']);
  });

  it('only ever fires at legal.review', async () => {
    const client = makeClient([{ ok: true }]);
    const result = await maybeSkipLegalReview(
      client, makeSession(), makeMsg(), makeDeps(rec),
      makeGate({ currentStepKey: 'profile.name' }), NOW,
    );
    expect(result).toBeNull();
    // Not even the evidence query runs.
    expect(client.query).not.toHaveBeenCalled();
  });

  // A worker who DECLINED said no. Their run keeps its Terms screen and its
  // REVIEW TERMS path whatever their users row happens to say.
  it.each([
    ['a declined run', { status: 'declined' as const }],
    ['a completed run', { status: 'completed' as const }],
    ['a run with no id', { runId: null }],
    ['a gate with no lock version', { lockVersion: null }],
  ])('does not skip on %s', async (_label, patch) => {
    const client = makeClient([{ ok: true }]);
    const result = await maybeSkipLegalReview(
      client, makeSession(), makeMsg(), makeDeps(rec), makeGate(patch as any), NOW,
    );
    expect(result).toBeNull();
    expect(rec.advances).toHaveLength(0);
  });
});

export {};
