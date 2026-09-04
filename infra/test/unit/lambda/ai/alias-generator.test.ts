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

describe('generateAndCacheAliases', () => {
  const { generateAndCacheAliases } = require('../../../../lambda/ai/alias-generator');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  });

  it('returns cached record on exact trade_key match and skips Bedrock', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        trade_key: 'welder',
        canonical_en: 'Welder',
        canonical_es: 'Soldador',
        aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
        trade_category: null,
      }],
    });

    const result = await generateAndCacheAliases('welder', 'welder');

    expect(result).toEqual({
      trade_key: 'welder',
      trade_raw: 'welder',
      canonical_en: 'Welder',
      canonical_es: 'Soldador',
      aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
      trade_category: null,
    });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDbRelease).toHaveBeenCalledTimes(1);
  });

  it('returns cached record when the incoming key is only an alias (Spanish) and skips Bedrock', async () => {
    // 'soldador' is not the trade_key itself, but a member of the seeded
    // welder row's aliases array -- the cache check must catch this.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        trade_key: 'welder',
        canonical_en: 'Welder',
        canonical_es: 'Soldador',
        aliases: ['welder', 'welding', 'weld', 'soldador', 'soldadura'],
        trade_category: null,
      }],
    });

    const result = await generateAndCacheAliases('soldador', 'soldador');

    expect(result?.trade_key).toBe('welder');
    expect(mockBedrockSend).not.toHaveBeenCalled();
    const [query, params] = mockDbQuery.mock.calls[0];
    expect(query).toContain('WHERE trade_key = $1 OR $1 = ANY(aliases)');
    expect(params).toEqual(['soldador']);
  });

  it('calls Bedrock, validates, normalizes, and writes to DB on cache miss', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              canonical_en: 'Electrician',
              canonical_es: 'Electricista',
              aliases: ['Electrician', 'Electrical', 'Electricista', 'Wire', 'Wiring'],
              trade_category: 'electrician',
            }),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('electricista', 'Electricista');

    expect(result?.trade_key).toBe('electrician');
    expect(result?.canonical_en).toBe('Electrician');
    expect(result?.canonical_es).toBe('Electricista');
    expect(result?.trade_category).toBe('electrician');
    // Normalized aliases must include the normalized tradeRaw, canonical_en,
    // and canonical_es, and be deduped/pre-normalized.
    expect(result?.aliases).toEqual(expect.arrayContaining(['electricista', 'electrician', 'electrical', 'wire', 'wiring']));
    expect(new Set(result?.aliases).size).toBe(result?.aliases.length);

    const insertCall = mockDbQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO trade_aliases');
    expect(insertCall[0]).toContain('ON CONFLICT (trade_key) DO NOTHING');
    expect(insertCall[1][0]).toBe('electrician');
  });

  it('drops an alias that normalizes to an empty string and still produces a valid record', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              canonical_en: 'Carpenter',
              canonical_es: 'Carpintero',
              // '-' and './' both normalize to '' via normalizeProfession.
              aliases: ['carpenter', 'carpentry', '-', './'],
              trade_category: 'carpenter',
            }),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('carpintero', 'Carpintero');

    expect(result?.aliases).not.toContain('');
    expect(result?.aliases.length).toBeGreaterThan(0);
    expect(result?.aliases).toEqual(expect.arrayContaining(['carpenter', 'carpentry', 'carpintero']));
  });

  it('accepts markdown-fenced JSON from Bedrock', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: '```json\n' + JSON.stringify({
              canonical_en: 'Plumber',
              canonical_es: 'Plomero',
              aliases: ['plumber', 'plumbing', 'plomero'],
              trade_category: 'plumber',
            }) + '\n```',
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('plomero', 'plomero');

    expect(result?.canonical_en).toBe('Plumber');
    expect(result?.trade_category).toBe('plumber');
  });

  it('throws on non-JSON Bedrock output', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'not json at all' }] } },
    });

    await expect(generateAndCacheAliases('x', 'x')).rejects.toThrow();
  });

  it('throws when required fields are missing', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: JSON.stringify({ canonical_en: 'Painter', aliases: ['painter'] }) }],
        },
      },
    });

    await expect(generateAndCacheAliases('x', 'x')).rejects.toThrow(/canonical_es/i);
  });

  it('throws when there are more than 15 aliases', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              canonical_en: 'Painter',
              canonical_es: 'Pintor',
              aliases: Array.from({ length: 16 }, (_, i) => `alias${i}`),
              trade_category: 'painting',
            }),
          }],
        },
      },
    });

    await expect(generateAndCacheAliases('x', 'x')).rejects.toThrow(/1-15/);
  });

  it('throws on an invalid trade_category', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              canonical_en: 'Roofer',
              canonical_es: 'Techador',
              aliases: ['roofer', 'roofing', 'techador'],
              trade_category: 'roofing',
            }),
          }],
        },
      },
    });

    await expect(generateAndCacheAliases('x', 'x')).rejects.toThrow(/trade_category/i);
  });

  it('accepts a null trade_category', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: JSON.stringify({
              canonical_en: 'Welder',
              canonical_es: 'Soldador',
              aliases: ['welder', 'welding', 'soldador'],
              trade_category: null,
            }),
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('soldador', 'soldador');

    expect(result?.trade_category).toBeNull();
  });

  it('parses an alias object that arrives behind explanatory prose', async () => {
    // Haiku 4.5 sometimes prefixes the JSON with a sentence. Stripping fences
    // alone left that as a hard parse failure; the shared lenient parser must
    // find the object inside the prose.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: 'Here is the mapping for that trade:\n\n' + JSON.stringify({
              canonical_en: 'Roofer',
              canonical_es: 'Techador',
              aliases: ['roofer', 'roofing', 'techador'],
              trade_category: 'general_labor',
            }) + '\n\nLet me know if you need another trade.',
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('techador', 'techador');

    expect(result?.canonical_en).toBe('Roofer');
    expect(result?.trade_category).toBe('general_labor');
  });

  it('parses a fenced alias object wrapped in prose', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: 'Sure.\n```json\n' + JSON.stringify({
              canonical_en: 'Painter',
              canonical_es: 'Pintor',
              aliases: ['painter', 'painting', 'pintor'],
              trade_category: null,
            }) + '\n```\nAnything else?',
          }],
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateAndCacheAliases('pintor', 'pintor');

    expect(result?.canonical_en).toBe('Painter');
  });
});

export {};
