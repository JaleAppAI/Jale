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
    process.env.BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';
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
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
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
});
