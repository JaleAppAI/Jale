import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { handleRerankMessage, parseRerankResponse } from '../../../../lambda/matching/employer-candidate-rerank';
import { getMatchingDbPool } from '../../../../lambda/lib/matching-db';
import { listEmployerCandidates, sanitizeCandidateForLlm } from '../../../../lambda/lib/employer-candidate-ranking';

jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('../../../../lambda/lib/matching-db');
jest.mock('../../../../lambda/lib/employer-candidate-ranking');

const mockGetMatchingDbPool = getMatchingDbPool as jest.Mock;
const mockListEmployerCandidates = listEmployerCandidates as jest.Mock;
const mockSanitizeCandidateForLlm = sanitizeCandidateForLlm as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockBedrockSend = jest.fn();

describe('employer candidate rerank worker', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';
    (BedrockRuntimeClient as jest.Mock).mockImplementation(() => ({ send: mockBedrockSend }));
    mockGetMatchingDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSanitizeCandidateForLlm.mockImplementation((candidate) => ({
      application_id: candidate.application_id,
      skills: candidate.skills,
      trust_score: candidate.trust_score,
      match_score: candidate.match_score,
    }));
  });

  it('rejects duplicate candidate refs in LLM output', () => {
    expect(() => parseRerankResponse(
      '{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong","reasons":["x"]},{"candidate_ref":"c1","score":75,"score_band":"good","reasons":["y"]}]}',
      new Set(['c1']),
    )).toThrow('Duplicate candidate_ref');
  });

  it('rejects unknown candidate refs in LLM output', () => {
    expect(() => parseRerankResponse(
      '{"ranked_candidates":[{"candidate_ref":"c9","score":80,"score_band":"strong","reasons":["x"]}]}',
      new Set(['c1']),
    )).toThrow('Unknown candidate_ref');
  });

  it('rejects scores outside the 0-100 range', () => {
    expect(() => parseRerankResponse(
      '{"ranked_candidates":[{"candidate_ref":"c1","score":101,"score_band":"strong","reasons":["x"]}]}',
      new Set(['c1']),
    )).toThrow('Invalid score');
  });

  it('exits idempotently when the cache already matches the source hash', async () => {
    mockListEmployerCandidates.mockResolvedValue({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: false,
      response: {
        ranking_status: 'llm_cached',
        ranking_version: 'llm-v1',
        candidates: [{ application_id: 'app-1', worker_id: 'worker-1' }],
        total: 1,
        computed_at: '2026-05-15T00:00:00.000Z',
      },
    });

    await handleRerankMessage({ jobId: 'job-1', requestedLimit: 100, sourceHash: 'hash-1', requestedAt: 'now' });

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
  });

  it('sends sanitized top candidates to Bedrock and upserts cache rows', async () => {
    mockListEmployerCandidates.mockResolvedValue({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: true,
      response: {
        ranking_status: 'deterministic',
        ranking_version: 'sql-v1',
        total: 2,
        computed_at: '2026-05-15T00:00:00.000Z',
        candidates: [
          {
            application_id: 'app-1',
            worker_id: 'worker-1',
            skills: ['wiring'],
            trust_score: 90,
            match_score: 88,
            phone: '+15550000001',
          },
          {
            application_id: 'app-2',
            worker_id: 'worker-2',
            skills: ['paint'],
            trust_score: 20,
            match_score: 30,
            phone: '+15550000002',
          },
        ],
      },
    });
    mockBedrockSend.mockResolvedValue({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              ranked_candidates: [
                { candidate_ref: 'c1', score: 95, score_band: 'strong', reasons: ['best fit'] },
                { candidate_ref: 'c2', score: 40, score_band: 'fair', reasons: ['less relevant'] },
              ],
            }),
          }],
        },
      },
    });
    mockQuery.mockResolvedValue({});

    await handleRerankMessage({ jobId: 'job-1', requestedLimit: 100, sourceHash: 'hash-1', requestedAt: 'now' });

    expect(mockBedrockSend).toHaveBeenCalled();
    const inputText = JSON.stringify((ConverseCommand as unknown as jest.Mock).mock.calls[0][0]);
    expect(inputText).toContain('c1');
    expect(inputText).toContain('wiring');
    expect(inputText).not.toContain('+15550000001');
    expect(inputText).not.toContain('worker-1');
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('BEGIN');
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO employer_candidate_rankings'))).toBe(true);
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM employer_candidate_rankings'))).toBe(true);
  });
});
