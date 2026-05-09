import type { ConversationState } from '../../../../lambda/whatsapp/lib/flows';

describe('ConversationState type', () => {
  it('includes building_custom_trust', () => {
    const state: ConversationState = 'building_custom_trust';

    expect(state).toBe('building_custom_trust');
  });
});

describe('normalizeProfession', () => {
  it('lowercases and trims', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('  Soldador  ')).toBe('soldador');
  });

  it('collapses internal whitespace', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('soldador  de  arco')).toBe('soldador de arco');
  });

  it('converts punctuation to spaces', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('soldador-de/arco')).toBe('soldador de arco');
  });

  it('strips accents', () => {
    const { normalizeProfession } = require('../../../../lambda/whatsapp/handlers/custom-trust');

    expect(normalizeProfession('Soldad\u00f3r')).toBe('soldador');
  });
});

const mockDbQuery = jest.fn();
const mockLambdaSend = jest.fn();
const mockSqsSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => input),
}));

const THREE_QUESTIONS = [
  { q_en: 'Q1 en', q_es: 'Q1 es' },
  { q_en: 'Q2 en', q_es: 'Q2 es' },
  { q_en: 'Q3 en', q_es: 'Q3 es' },
];

describe('handleBuildingCustomTrust', () => {
  const { handleBuildingCustomTrust } = require('../../../../lambda/whatsapp/handlers/custom-trust');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.QUESTION_GENERATOR_ARN = 'arn:aws:lambda:us-east-1:123:function:gen';
    process.env.TRUST_ASSESSMENT_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';
  });

  it('on entry with cached questions asks Q1', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const client = { query: mockDbQuery };
    const conv = {
      id: 'conv1',
      user_id: 'user1',
      language: 'en',
      state_context: {
        custom_trust_step: 0,
        custom_trust_profession: 'soldador',
        custom_trust_questions: THREE_QUESTIONS,
        custom_trust_answers: [],
        custom_trust_assessment_id: 'assess1',
      },
    };
    const msg = { from: 'whatsapp:+1555', messageSid: 'SM1', body: '' };

    await handleBuildingCustomTrust(client, conv, msg);

    const outboxCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO whatsapp_outbox'));
    expect(outboxCall?.[1]?.[2]).toBe('Q1 en');
  });

  it('blocks re-entry if WTA row exists', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-assessment' }] });
    const client = { query: mockDbQuery };
    const conv = {
      id: 'conv1',
      user_id: 'user1',
      language: 'es',
      state_context: { custom_trust_profession: 'soldador' },
    };
    const msg = { from: 'whatsapp:+1555', messageSid: 'SM1', body: 'soldador' };

    await handleBuildingCustomTrust(client, conv, msg);

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("conversation_state = 'idle'"));
    expect(updateCall).toBeDefined();
  });

  it('after third spanish custom answer inserts assessment and enqueue outbox row', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // existing WTA check
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker_trust_assessments
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT trust_assessment_enqueue_outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation idle
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT confirmation outbox
    mockSqsSend.mockResolvedValue({});
    const client = { query: mockDbQuery };
    const conv = {
      id: 'conv1',
      user_id: 'user1',
      language: 'es',
      state_context: {
        custom_trust_step: 2,
        custom_trust_profession: 'Soldador',
        custom_trust_questions: THREE_QUESTIONS,
        custom_trust_answers: [
          {
            q_en: 'Q1 en',
            answer_text: 'Mig y arco',
            answer_source: 'text',
            answered_at: '2026-05-08T00:00:00.000Z',
          },
          {
            q_en: 'Q2 en',
            answer_text: 'Oficial',
            answer_source: 'text',
            answered_at: '2026-05-08T00:01:00.000Z',
          },
        ],
        custom_trust_assessment_id: 'assess1',
      },
    };
    const msg = { from: 'whatsapp:+1555', messageSid: 'SM3', body: 'Estructuras y reparaciones' };

    await handleBuildingCustomTrust(client, conv, msg);

    const assessmentInsert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO worker_trust_assessments'));
    expect(assessmentInsert).toBeDefined();
    const enqueueInsert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO trust_assessment_enqueue_outbox'));
    expect(enqueueInsert?.[1]).toEqual(['assess1', 'user1', 'soldador']);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});
