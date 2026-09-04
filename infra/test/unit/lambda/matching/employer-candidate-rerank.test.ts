import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { handleRerankMessage, parseRerankResponse } from '../../../../lambda/matching/employer-candidate-rerank';
import { BedrockJsonParseError } from '../../../../lambda/lib/bedrock-json';
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

const MESSAGE = { jobId: 'job-1', requestedLimit: 100, sourceHash: 'hash-1', requestedAt: 'now' };

/** Three deterministic candidates, already in deterministic rank order. */
const CANDIDATES = [
  {
    application_id: 'app-1',
    worker_id: 'worker-1',
    skills: ['wiring'],
    trust_score: 90,
    match_score: 88,
    score_band: 'strong',
    match_reasons: ['High trust score', 'Trade match'],
    phone: '+15550000001',
  },
  {
    application_id: 'app-2',
    worker_id: 'worker-2',
    skills: ['paint'],
    trust_score: 20,
    match_score: 30,
    score_band: 'fair',
    match_reasons: ['Applied to this job'],
    phone: '+15550000002',
  },
  {
    application_id: 'app-3',
    worker_id: 'worker-3',
    skills: ['drywall'],
    trust_score: 50,
    match_score: 55,
    score_band: 'good',
    match_reasons: ['Related trade'],
    phone: '+15550000003',
  },
];

function deterministicResult(candidates = CANDIDATES) {
  return {
    sourceHash: 'hash-1',
    shouldEnqueueRerank: true,
    response: {
      ranking_status: 'deterministic',
      ranking_version: 'sql-v1',
      total: candidates.length,
      computed_at: '2026-05-15T00:00:00.000Z',
      candidates,
    },
  };
}

function bedrockReturns(text: string): void {
  mockBedrockSend.mockResolvedValue({ output: { message: { content: [{ text }] } } });
}

/** The INSERT parameter arrays, in the order the handler wrote them. */
function insertedRows(): unknown[][] {
  return mockQuery.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO employer_candidate_rankings'))
    .map(([, params]) => params as unknown[]);
}

describe('employer candidate rerank worker', () => {
  let logSpy: jest.SpyInstance;

  function loggedMetrics(): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    (BedrockRuntimeClient as jest.Mock).mockImplementation(() => ({ send: mockBedrockSend }));
    mockGetMatchingDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSanitizeCandidateForLlm.mockImplementation((candidate) => ({
      application_id: candidate.application_id,
      skills: candidate.skills,
      trust_score: candidate.trust_score,
      match_score: candidate.match_score,
      match_reasons: candidate.match_reasons,
    }));
    mockQuery.mockResolvedValue({});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('parseRerankResponse', () => {
    it('keeps the first of two duplicate refs and drops the second', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong","reasons":["x"]},{"candidate_ref":"c1","score":75,"score_band":"good","reasons":["y"]}]}',
        new Set(['c1']),
      );

      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0]).toMatchObject({ candidate_ref: 'c1', score: 80 });
      expect(result.dropped).toEqual([{ candidate_ref: 'c1', reason: 'duplicate_ref' }]);
    });

    it('drops an unknown ref instead of throwing for the whole batch', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c9","score":80,"score_band":"strong","reasons":["x"]},{"candidate_ref":"c1","score":70,"score_band":"good","reasons":["y"]}]}',
        new Set(['c1']),
      );

      expect(result.ranked.map((item) => item.candidate_ref)).toEqual(['c1']);
      expect(result.dropped).toEqual([{ candidate_ref: 'c9', reason: 'unknown_ref' }]);
    });

    it('drops a candidate whose score is out of range or not an integer', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c1","score":101,"score_band":"strong","reasons":["x"]},{"candidate_ref":"c2","score":"80","score_band":"good","reasons":["y"]},{"candidate_ref":"c3","score":50,"score_band":"good","reasons":["z"]}]}',
        new Set(['c1', 'c2', 'c3']),
      );

      expect(result.ranked.map((item) => item.candidate_ref)).toEqual(['c3']);
      expect(result.dropped).toEqual([
        { candidate_ref: 'c1', reason: 'invalid_score' },
        { candidate_ref: 'c2', reason: 'invalid_score' },
      ]);
    });

    it('drops a candidate with an unknown score_band', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"excellent","reasons":["x"]}]}',
        new Set(['c1']),
      );

      expect(result.ranked).toHaveLength(0);
      expect(result.dropped).toEqual([{ candidate_ref: 'c1', reason: 'invalid_band' }]);
    });

    it('clamps five reasons down to the first three', () => {
      const result = parseRerankResponse(
        JSON.stringify({
          ranked_candidates: [{
            candidate_ref: 'c1',
            score: 80,
            score_band: 'strong',
            reasons: ['one', 'two', 'three', 'four', 'five'],
          }],
        }),
        new Set(['c1']),
      );

      expect(result.ranked[0].reasons).toEqual(['one', 'two', 'three']);
      expect(result.dropped).toEqual([]);
    });

    it('truncates an over-long reason to 160 characters instead of dropping the candidate', () => {
      const longReason = 'a'.repeat(300);
      const result = parseRerankResponse(
        JSON.stringify({
          ranked_candidates: [{
            candidate_ref: 'c1', score: 80, score_band: 'strong', reasons: [longReason],
          }],
        }),
        new Set(['c1']),
      );

      expect(result.ranked[0].reasons).toHaveLength(1);
      expect(result.ranked[0].reasons[0]).toHaveLength(160);
      expect(result.ranked[0].reasons[0]).toBe('a'.repeat(160));
      expect(result.dropped).toEqual([]);
    });

    it('keeps a candidate whose reasons are all unusable, with an empty reasons array', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong","reasons":[123,"","  "]}]}',
        new Set(['c1']),
      );

      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0].reasons).toEqual([]);
      expect(result.dropped).toEqual([]);
    });

    it('keeps a candidate whose reasons field is missing entirely', () => {
      const result = parseRerankResponse(
        '{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong"}]}',
        new Set(['c1']),
      );

      expect(result.ranked).toHaveLength(1);
      expect(result.ranked[0].reasons).toEqual([]);
      expect(result.dropped).toEqual([]);
    });

    it('parses JSON that arrives behind explanatory prose', () => {
      const result = parseRerankResponse(
        'Here is the reranking you asked for:\n\n{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong","reasons":["x"]}]}\n\nLet me know if you want more detail.',
        new Set(['c1']),
      );

      expect(result.ranked.map((item) => item.candidate_ref)).toEqual(['c1']);
    });

    it('parses fenced JSON', () => {
      const result = parseRerankResponse(
        '```json\n{"ranked_candidates":[{"candidate_ref":"c1","score":80,"score_band":"strong","reasons":["x"]}]}\n```',
        new Set(['c1']),
      );

      expect(result.ranked).toHaveLength(1);
    });

    it('throws BedrockJsonParseError when the payload is not JSON at all', () => {
      expect(() => parseRerankResponse('I cannot rank these candidates.', new Set(['c1'])))
        .toThrow(BedrockJsonParseError);
    });

    it('throws BedrockJsonParseError when ranked_candidates is missing or not an array', () => {
      expect(() => parseRerankResponse('{"candidates":[]}', new Set(['c1'])))
        .toThrow(BedrockJsonParseError);
      expect(() => parseRerankResponse('{"ranked_candidates":"none"}', new Set(['c1'])))
        .toThrow(BedrockJsonParseError);
    });
  });

  describe('handleRerankMessage', () => {
    it('exits idempotently when the cache already matches the source hash', async () => {
      mockListEmployerCandidates.mockResolvedValue({
        sourceHash: 'hash-1',
        shouldEnqueueRerank: false,
        response: {
          ranking_status: 'llm_cached',
          ranking_version: 'llm-v1',
          candidates: [CANDIDATES[0]],
          total: 1,
          computed_at: '2026-05-15T00:00:00.000Z',
        },
      });

      await handleRerankMessage(MESSAGE);

      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
    });

    it('sends sanitized top candidates to Bedrock and upserts cache rows', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 2)));
      bedrockReturns(JSON.stringify({
        ranked_candidates: [
          { candidate_ref: 'c1', score: 95, score_band: 'strong', reasons: ['best fit'] },
          { candidate_ref: 'c2', score: 40, score_band: 'fair', reasons: ['less relevant'] },
        ],
      }));

      await handleRerankMessage(MESSAGE);

      expect(mockBedrockSend).toHaveBeenCalled();
      const inputText = JSON.stringify((ConverseCommand as unknown as jest.Mock).mock.calls[0][0]);
      expect(inputText).toContain('c1');
      expect(inputText).toContain('wiring');
      expect(inputText).not.toContain('+15550000001');
      expect(inputText).not.toContain('worker-1');
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('BEGIN');
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
      expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM employer_candidate_rankings'))).toBe(true);
      expect(insertedRows()).toHaveLength(2);
      expect(loggedMetrics()).toEqual([]);
    });

    it('constrains the prompt: strict JSON, 1 to 3 reasons, 160-character cap', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult());
      bedrockReturns(JSON.stringify({ ranked_candidates: [
        { candidate_ref: 'c1', score: 95, score_band: 'strong', reasons: ['best fit'] },
        { candidate_ref: 'c2', score: 40, score_band: 'fair', reasons: ['ok'] },
        { candidate_ref: 'c3', score: 60, score_band: 'good', reasons: ['ok'] },
      ] }));

      await handleRerankMessage(MESSAGE);

      const input = (ConverseCommand as unknown as jest.Mock).mock.calls[0][0];
      const promptText = `${input.system.map((block: { text: string }) => block.text).join(' ')} ${input.messages[0].content[0].text}`;

      expect(promptText).toContain('1 to 3');
      expect(promptText).toContain('160');
      expect(promptText).toMatch(/strict json/i);
      expect(promptText).toMatch(/no prose/i);
      expect(promptText).toMatch(/candidate_ref/);
      expect(promptText).toMatch(/untrusted/i);
      expect(input.inferenceConfig.temperature).toBe(0);
      expect(input.inferenceConfig.maxTokens).toBeGreaterThanOrEqual(4096);
    });

    it('parses prose-prefixed Bedrock output instead of falling back', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      bedrockReturns(`Sure! Here is the reranking:\n\n${JSON.stringify({
        ranked_candidates: [{ candidate_ref: 'c1', score: 91, score_band: 'strong', reasons: ['best fit'] }],
      })}\n\nHappy to adjust.`);

      await handleRerankMessage(MESSAGE);

      const rows = insertedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0][4]).toBe(91);
      expect(rows[0][6]).toBe(JSON.stringify(['best fit']));
      expect(loggedMetrics()).toEqual([]);
    });

    it('drops one bad-ref candidate, ranks the rest, and logs the dropped count', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult());
      bedrockReturns(JSON.stringify({
        ranked_candidates: [
          { candidate_ref: 'c2', score: 90, score_band: 'strong', reasons: ['strong paint work'] },
          { candidate_ref: 'c99', score: 85, score_band: 'strong', reasons: ['hallucinated'] },
          { candidate_ref: 'c1', score: 70, score_band: 'good', reasons: ['solid'] },
        ],
      }));

      await handleRerankMessage(MESSAGE);

      const rows = insertedRows();
      // c2 and c1 in LLM order, then c3 (never ranked by the LLM) at the tail.
      expect(rows.map((params) => params[1])).toEqual(['worker-2', 'worker-1', 'worker-3']);
      expect(rows.map((params) => params[3])).toEqual([1, 2, 3]);
      expect(rows[2][4]).toBe(55);
      expect(rows[2][5]).toBe('good');
      expect(rows[2][6]).toBe(JSON.stringify(['Related trade']));
      expect(loggedMetrics()).toEqual([
        { metric: 'EmployerCandidateRerankDroppedCandidates', count: 1 },
      ]);
    });

    it('fills a missing LLM reason from the deterministic match_reasons', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      bedrockReturns(JSON.stringify({
        ranked_candidates: [{ candidate_ref: 'c1', score: 91, score_band: 'strong', reasons: [123, ''] }],
      }));

      await handleRerankMessage(MESSAGE);

      const rows = insertedRows();
      expect(rows[0][6]).toBe(JSON.stringify(['High trust score', 'Trade match']));
    });

    it('persists the deterministic ranking and logs a fallback metric when Bedrock throws', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult());
      mockBedrockSend.mockRejectedValue(new Error('ThrottlingException'));

      await expect(handleRerankMessage(MESSAGE)).resolves.toBeUndefined();

      const rows = insertedRows();
      expect(rows.map((params) => params[1])).toEqual(['worker-1', 'worker-2', 'worker-3']);
      expect(rows.map((params) => params[3])).toEqual([1, 2, 3]);
      expect(rows.map((params) => params[4])).toEqual([88, 30, 55]);
      expect(rows.map((params) => params[5])).toEqual(['strong', 'fair', 'good']);
      expect(rows[0][6]).toBe(JSON.stringify(['High trust score', 'Trade match']));
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
      expect(loggedMetrics()).toEqual([
        { metric: 'EmployerCandidateRerankFallback', reason: 'bedrock_error' },
      ]);
    });

    it('persists the deterministic ranking and logs a fallback metric on unparseable output', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult());
      bedrockReturns('I am not able to rank these applicants.');

      await expect(handleRerankMessage(MESSAGE)).resolves.toBeUndefined();

      expect(insertedRows().map((params) => params[1])).toEqual(['worker-1', 'worker-2', 'worker-3']);
      expect(loggedMetrics()).toEqual([
        { metric: 'EmployerCandidateRerankFallback', reason: 'parse_error' },
      ]);
    });

    it('persists the deterministic ranking and logs a fallback metric when every candidate is dropped', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      bedrockReturns('{"ranked_candidates":[{"candidate_ref":"c7","score":80,"score_band":"strong","reasons":["x"]}]}');

      await expect(handleRerankMessage(MESSAGE)).resolves.toBeUndefined();

      expect(insertedRows().map((params) => params[1])).toEqual(['worker-1']);
      expect(loggedMetrics()).toEqual(expect.arrayContaining([
        { metric: 'EmployerCandidateRerankDroppedCandidates', count: 1 },
        { metric: 'EmployerCandidateRerankFallback', reason: 'empty' },
      ]));
    });

    it('logs only metric names, static reasons and counts — never candidate data', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult());
      mockBedrockSend.mockRejectedValue(new Error('ThrottlingException'));

      await handleRerankMessage(MESSAGE);

      for (const entry of loggedMetrics()) {
        expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['metric']));
        for (const key of Object.keys(entry)) {
          expect(['metric', 'reason', 'count']).toContain(key);
        }
      }
      const logged = logSpy.mock.calls.map(([line]) => String(line)).join(' ');
      expect(logged).not.toContain('worker-1');
      expect(logged).not.toContain('+15550000001');
      expect(logged).not.toContain('High trust score');
    });

    it('still throws on a database failure so SQS retries it', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      bedrockReturns(JSON.stringify({
        ranked_candidates: [{ candidate_ref: 'c1', score: 91, score_band: 'strong', reasons: ['best fit'] }],
      }));
      mockQuery.mockImplementation((sql: string) => (
        String(sql).includes('INSERT INTO employer_candidate_rankings')
          ? Promise.reject(new Error('deadlock detected'))
          : Promise.resolve({})
      ));

      await expect(handleRerankMessage(MESSAGE)).rejects.toThrow('deadlock detected');
      expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    });

    it('throws when the fallback write itself fails', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      mockBedrockSend.mockRejectedValue(new Error('ThrottlingException'));
      mockQuery.mockImplementation((sql: string) => (
        String(sql).includes('INSERT INTO employer_candidate_rankings')
          ? Promise.reject(new Error('deadlock detected'))
          : Promise.resolve({})
      ));

      await expect(handleRerankMessage(MESSAGE)).rejects.toThrow('deadlock detected');
    });

    it('releases the pooled client even when the fallback path runs', async () => {
      mockListEmployerCandidates.mockResolvedValue(deterministicResult(CANDIDATES.slice(0, 1)));
      mockBedrockSend.mockRejectedValue(new Error('ThrottlingException'));

      await handleRerankMessage(MESSAGE);

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });
});
