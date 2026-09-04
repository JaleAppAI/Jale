const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();
const mockDbRelease = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({
  query: mockDbQuery,
  release: mockDbRelease,
});

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn().mockResolvedValue({ connect: mockDbConnect }),
}));

describe('generateAndCacheQuestions', () => {
  const { generateAndCacheQuestions } = require('../../../../lambda/ai/question-generator');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  });

  it('returns cached questions on cache hit', async () => {
    const cached = [
      { q_en: 'Q1 en', q_es: 'Q1 es' },
      { q_en: 'Q2 en', q_es: 'Q2 es' },
      { q_en: 'Q3 en', q_es: 'Q3 es' },
    ];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ questions: cached }] });

    const result = await generateAndCacheQuestions('soldador', 'soldador');

    expect(result).toEqual(cached);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDbRelease).toHaveBeenCalledTimes(1);
  });

  it('calls Bedrock and writes to DB on cache miss', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify([
              { q_en: 'What do you weld?', q_es: 'Que soldas?' },
              { q_en: 'What metals?', q_es: 'Que metales?' },
              { q_en: 'Safety?', q_es: 'Seguridad?' },
            ]),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheQuestions('soldador', 'soldador de arco');

    expect(result).toHaveLength(3);
    expect(result[0]).toHaveProperty('q_en');
    expect(result[0]).toHaveProperty('q_es');
    const commandInput = mockBedrockSend.mock.calls[0][0];
    const userText = commandInput.messages[0].content[0].text;
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it('prompts for exactly three OPEN questions and forbids years/seniority/multiple-choice', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify([
              { q_en: 'What do you weld?', q_es: 'Que soldas?' },
              { q_en: 'What metals?', q_es: 'Que metales?' },
              { q_en: 'Safety?', q_es: 'Seguridad?' },
            ]),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await generateAndCacheQuestions('soldador', 'soldador de arco');

    const commandInput = mockBedrockSend.mock.calls[0][0];
    const systemText = commandInput.system[0].text;
    const userText = commandInput.messages[0].content[0].text;

    // The three required question shapes (R1-A).
    expect(userText).toContain('specialize in');
    expect(userText).toContain('last job');
    expect(userText).toContain('never seen before');
    expect(userText).toContain('went wrong');

    // The prohibitions. The retired prompt actively ASKED for a seniority
    // question ("helper, independently, or lead") — that must be gone, not
    // merely supplemented.
    expect(userText).toContain('Do not ask how many years');
    expect(userText).toMatch(/seniority/i);
    expect(userText).toMatch(/how long/i);
    expect(userText).not.toMatch(/ask what level they can work at/i);

    // No numbered menus: the whole point of R1-A is that a menu label gives
    // the scorer nothing to grade.
    expect(`${systemText} ${userText}`).toMatch(/multiple[- ]choice/i);
    expect(`${systemText} ${userText}`).toMatch(/numbered/i);
    expect(systemText).toMatch(/open/i);
  });

  it('accepts a structurally valid response even when a question asks about years — content is NOT filtered at runtime', async () => {
    // Deliberate: the prohibition lives in the PROMPT only. A model that
    // ignores it still yields a usable, well-formed question set rather than a
    // hard failure that would strand a worker mid-onboarding, so nothing here
    // rejects on content.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify([
              { q_en: 'How many years have you welded?', q_es: 'Cuantos anos has soldado?' },
              { q_en: 'What metals?', q_es: 'Que metales?' },
              { q_en: 'Safety?', q_es: 'Seguridad?' },
            ]),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheQuestions('soldador', 'soldador de arco');

    expect(result).toHaveLength(3);
    expect(result[0].q_en).toBe('How many years have you welded?');
  });

  it('validates output and rejects if fewer than 3 questions', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: JSON.stringify([{ q_en: 'Only one', q_es: 'Solo uno' }]) }],
        },
      },
    });

    await expect(generateAndCacheQuestions('x', 'x')).rejects.toThrow(
      /expected 3 questions/i,
    );
  });

  it('parses a question array that arrives behind explanatory prose', async () => {
    // Haiku 4.5 sometimes prefixes the JSON with a sentence. Stripping fences
    // alone left that as a hard parse failure; the shared lenient parser must
    // find the array inside the prose.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: 'Here are three open questions for a welder:\n\n' + JSON.stringify([
              { q_en: 'What do you weld?', q_es: 'Que soldas?' },
              { q_en: 'What metals?', q_es: 'Que metales?' },
              { q_en: 'Safety?', q_es: 'Seguridad?' },
            ]) + '\n\nLet me know if you want different ones.',
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheQuestions('soldador', 'soldador de arco');

    expect(result).toHaveLength(3);
    expect(result[0].q_en).toBe('What do you weld?');
  });

  it('parses a fenced question array wrapped in prose', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: 'Sure.\n```json\n' + JSON.stringify([
              { q_en: 'A?', q_es: 'A?' },
              { q_en: 'B?', q_es: 'B?' },
              { q_en: 'C?', q_es: 'C?' },
            ]) + '\n```\nAnything else?',
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheQuestions('soldador', 'soldador');

    expect(result).toHaveLength(3);
    expect(result[2].q_es).toBe('C?');
  });

  it('still rejects output with no JSON in it at all', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'I cannot generate questions for that trade.' }] } },
    });

    await expect(generateAndCacheQuestions('x', 'x')).rejects.toThrow();
  });
});

export {};
