/**
 * The web onboarding door names its actor for the change records: the
 * signed-in worker, on the web, once per request, inside the
 * request's transaction and before its first write.
 */
const mockQuery = jest.fn();
const mockRelease = jest.fn();
jest.mock('../../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(async () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }) })),
  setInternalUserRlsContext: jest.fn(),
}));
const mockLoadWorkerGate = jest.fn();
jest.mock('../../../../../lambda/whatsapp/lib/onboarding-repository', () => ({
  loadWorkerGate: (...args: unknown[]) => mockLoadWorkerGate(...args),
}));
jest.mock('../../../../../lambda/whatsapp/lib/outbox-wake', () => ({ publishOutboxWakes: jest.fn() }));
jest.mock('../../../../../lambda/whatsapp/web/onboarding-driver', () => ({
  MAX_ANSWERS_PER_BATCH: 20,
  applyAnswerBatch: jest.fn(),
  applyBack: jest.fn(),
  createWebOnboardingDeps: jest.fn(),
  createWebSession: jest.fn(),
  healPreAuthStep: jest.fn(),
  isLockConflict: jest.fn(() => false),
  setPreferredLanguage: jest.fn(),
  skipLegalIfAlreadyAccepted: jest.fn(),
}));
jest.mock('../../../../../lambda/whatsapp/web/onboarding-state', () => ({ buildOnboardingState: jest.fn() }));
jest.mock('../../../../../lambda/whatsapp/web/onboarding-voice', () => ({
  createVoiceUploadUrl: jest.fn(),
  readVoiceResult: jest.fn(),
  startVoiceTranscription: jest.fn(),
}));
jest.mock('../../../../../lambda/lib/audit/context');

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../../lambda/whatsapp/web/worker-onboarding';
import { setInternalUserRlsContext } from '../../../../../lambda/lib/db';
import { setAuditContext } from '../../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from '../../api/audit-expectations';

const WORKER = '00000000-0000-4000-8000-0000000000b1';

function getEvent(): APIGatewayProxyEvent {
  return withRequestId({
    httpMethod: 'GET',
    path: '/worker/onboarding',
    body: null,
    requestContext: { authorizer: { claims: { sub: 'fixture-sub' } } },
  }) as unknown as APIGatewayProxyEvent;
}

describe('web onboarding change context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockImplementation((sql: string) => {
      if (/resolve_worker_internal_id/.test(sql)) return Promise.resolve({ rows: [{ id: WORKER }] });
      if (/start_web_onboarding_workflow/.test(sql)) return Promise.resolve({ rows: [{ run_id: 'run-1', created: false }] });
      return Promise.resolve({ rows: [] });
    });
    mockLoadWorkerGate.mockReset();
    mockLoadWorkerGate
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ runId: 'run-1', currentStepKey: 'profile.name', lifecycle: 'suspended' });
  });

  it('names the worker on the web before the first write of the request', async () => {
    const res = await handler(getEvent());
    expect(res.statusCode).toBe(409);
    expect(setAuditContext).toHaveBeenCalledTimes(1);
    expect(setAuditContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: mockQuery }), callerFor('worker', WORKER), 'worker.onboarding');
    expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /start_web_onboarding_workflow/);
    expect((setAuditContext as jest.Mock).mock.invocationCallOrder[0])
      .toBeGreaterThan((setInternalUserRlsContext as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('names nobody when the caller resolves to no worker', async () => {
    mockQuery.mockImplementation(() => Promise.resolve({ rows: [{ id: null }] }));
    const res = await handler(getEvent());
    expect(res.statusCode).toBe(404);
    expect(setAuditContext).not.toHaveBeenCalled();
  });
});
