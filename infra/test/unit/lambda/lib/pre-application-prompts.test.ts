import {
  MAX_PRE_APPLICATION_PROMPTS,
  MAX_PROMPT_TEXT_LENGTH,
  MAX_PROMPT_ANSWER_LENGTH,
  MAX_PROMPT_ANSWERS_BYTES,
  PROMPT_ANSWERS_CONSTRAINT,
  parsePreApplicationPrompts,
  promptsNormalized,
  validatePromptAnswers,
  normalizePromptAnswers,
  type PreApplicationPrompt,
} from '../../../../lambda/lib/pre-application-prompts';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;

describe('pre-application-prompts bounds', () => {
  it('pins the single bound set shared by web and WhatsApp (B4.0 §6)', () => {
    expect(MAX_PRE_APPLICATION_PROMPTS).toBe(10);
    // CHARACTERS -- what the worker and the UI counter experience, so
    // "1000 characters" means the same in English and in Spanish.
    expect(MAX_PROMPT_TEXT_LENGTH).toBe(500);
    expect(MAX_PROMPT_ANSWER_LENGTH).toBe(1000);
    // BYTES -- mirrors job_applications_prompt_answers_valid (091):
    // octet_length(prompt_answers::text) <= 16384.
    expect(MAX_PROMPT_ANSWERS_BYTES).toBe(16384);
    expect(PROMPT_ANSWERS_CONSTRAINT).toBe('job_applications_prompt_answers_valid');
  });
});

describe('parsePreApplicationPrompts', () => {
  it('treats an absent value as an empty list (the column default)', () => {
    expect(parsePreApplicationPrompts(undefined)).toEqual({ ok: true, value: [] });
    expect(parsePreApplicationPrompts(null)).toEqual({ ok: true, value: [] });
  });

  it('accepts an explicit empty array', () => {
    expect(parsePreApplicationPrompts([])).toEqual({ ok: true, value: [] });
  });

  it('mints a randomUUID id for a prompt that has none, and keeps a supplied valid id', () => {
    const res = parsePreApplicationPrompts([
      { text: 'How many years of framing?' },
      { id: 'keep_me-1', text: 'Do you own tools?' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0].id).toMatch(UUID_SHAPE);
    expect(res.value[0].id).toMatch(ID_SHAPE);
    expect(res.value[0].text).toBe('How many years of framing?');
    expect(res.value[1]).toEqual({ id: 'keep_me-1', text: 'Do you own tools?' });
  });

  it('trims prompt text and measures the trimmed length', () => {
    expect(parsePreApplicationPrompts([{ id: 'a', text: '   spaced   ' }])).toEqual({
      ok: true,
      value: [{ id: 'a', text: 'spaced' }],
    });
  });

  it('rejects a non-array value', () => {
    expect(parsePreApplicationPrompts({ id: 'a', text: 'x' })).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
    expect(parsePreApplicationPrompts('nope')).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
  });

  it('accepts exactly MAX_PRE_APPLICATION_PROMPTS and rejects one more', () => {
    const ten = Array.from({ length: 10 }, (_v, i) => ({ id: `p${i}`, text: `q${i}` }));
    expect(parsePreApplicationPrompts(ten).ok).toBe(true);
    expect(parsePreApplicationPrompts([...ten, { id: 'p10', text: 'q10' }])).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
  });

  it('accepts text at exactly 500 chars and rejects 501', () => {
    expect(parsePreApplicationPrompts([{ id: 'a', text: 'x'.repeat(500) }]).ok).toBe(true);
    expect(parsePreApplicationPrompts([{ id: 'a', text: 'x'.repeat(501) }])).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
  });

  it('rejects blank / whitespace-only / non-string text', () => {
    for (const text of ['', '   ', 42, null, undefined, {}]) {
      expect(parsePreApplicationPrompts([{ id: 'a', text }])).toEqual({
        ok: false,
        error: 'invalid_pre_application_prompts',
      });
    }
  });

  it('rejects a NUL byte in prompt text (jsonb cannot store it)', () => {
    expect(parsePreApplicationPrompts([{ id: 'a', text: 'How many years\u0000?' }])).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
  });

  it('rejects duplicate ids rather than silently de-duping (answers are keyed by id)', () => {
    expect(parsePreApplicationPrompts([
      { id: 'same', text: 'one' },
      { id: 'same', text: 'two' },
    ])).toEqual({ ok: false, error: 'invalid_pre_application_prompts' });
  });

  it('rejects an id that does not match the DB CHECK pattern, never re-mints it', () => {
    for (const id of ['has space', 'bad!', 'x'.repeat(41), '', 7]) {
      expect(parsePreApplicationPrompts([{ id, text: 'q' }])).toEqual({
        ok: false,
        error: 'invalid_pre_application_prompts',
      });
    }
  });

  it('accepts an id at exactly 40 chars', () => {
    const id = 'a'.repeat(40);
    expect(parsePreApplicationPrompts([{ id, text: 'q' }])).toEqual({
      ok: true,
      value: [{ id, text: 'q' }],
    });
  });

  it('rejects an entry that is not a plain object, and rejects extra keys (the CHECK wants exactly {id,text})', () => {
    expect(parsePreApplicationPrompts(['q']).ok).toBe(false);
    expect(parsePreApplicationPrompts([['id', 'text']]).ok).toBe(false);
    expect(parsePreApplicationPrompts([{ id: 'a', text: 'q', extra: 1 }])).toEqual({
      ok: false,
      error: 'invalid_pre_application_prompts',
    });
  });
});

describe('promptsNormalized', () => {
  it('normalizes to [id, text] pairs so an unchanged jsonb round-trip is not read as an edit', () => {
    const list: PreApplicationPrompt[] = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
    expect(promptsNormalized(list)).toBe(JSON.stringify([['a', 'one'], ['b', 'two']]));
  });

  it('treats entry ORDER as significant (a reorder is a real edit)', () => {
    expect(promptsNormalized([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }])).not.toBe(
      promptsNormalized([{ id: 'b', text: 'two' }, { id: 'a', text: 'one' }]),
    );
  });

  it('tolerates a raw jsonb column value (non-array becomes [])', () => {
    expect(promptsNormalized(null)).toBe('[]');
    expect(promptsNormalized('nope')).toBe('[]');
    expect(promptsNormalized([{ id: 'a', text: 'one' }])).toBe(JSON.stringify([['a', 'one']]));
  });
});

describe('validatePromptAnswers', () => {
  const prompts: PreApplicationPrompt[] = [
    { id: 'p1', text: 'Years of framing?' },
    { id: 'p2', text: 'Own tools?' },
  ];

  it('accepts a complete set and returns trimmed values', () => {
    expect(validatePromptAnswers(prompts, { p1: '  five  ', p2: 'yes' })).toEqual({
      ok: true,
      value: { p1: 'five', p2: 'yes' },
    });
  });

  it('returns missing_prompt_answers with the unanswered ids', () => {
    expect(validatePromptAnswers(prompts, { p1: 'five' })).toEqual({
      ok: false,
      error: 'missing_prompt_answers',
      missing: ['p2'],
    });
  });

  it('treats an absent body value as "all missing", never as invalid', () => {
    expect(validatePromptAnswers(prompts, undefined)).toEqual({
      ok: false,
      error: 'missing_prompt_answers',
      missing: ['p1', 'p2'],
    });
  });

  it('a job with no prompts accepts an absent or empty answers object', () => {
    expect(validatePromptAnswers([], undefined)).toEqual({ ok: true, value: {} });
    expect(validatePromptAnswers([], {})).toEqual({ ok: true, value: {} });
  });

  it('rejects an unknown prompt id', () => {
    expect(validatePromptAnswers(prompts, { p1: 'a', p2: 'b', p9: 'c' })).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
    expect(validatePromptAnswers([], { p1: 'a' })).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
  });

  it('rejects a blank / whitespace-only / non-string answer', () => {
    for (const value of ['', '   ', 42, null, [], {}]) {
      expect(validatePromptAnswers(prompts, { p1: value, p2: 'ok' })).toEqual({
        ok: false,
        error: 'invalid_prompt_answers',
      });
    }
  });

  it('rejects a non-object answers value', () => {
    expect(validatePromptAnswers(prompts, ['a'])).toEqual({ ok: false, error: 'invalid_prompt_answers' });
    expect(validatePromptAnswers(prompts, 'a')).toEqual({ ok: false, error: 'invalid_prompt_answers' });
  });

  it('accepts an answer at exactly 1000 chars (trimmed) and rejects 1001', () => {
    expect(validatePromptAnswers(prompts, { p1: 'x'.repeat(1000), p2: 'y' }).ok).toBe(true);
    expect(validatePromptAnswers(prompts, { p1: 'x'.repeat(1001), p2: 'y' })).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
  });

  it('measures the per-answer bound in CHARACTERS, not bytes: 1000 accented chars (2000 bytes) is a legal answer', () => {
    // The byte budget only binds the whole object; a single Spanish answer
    // must never be cut short at ~500 characters just because it has
    // accents. 2000 bytes is well under MAX_PROMPT_ANSWERS_BYTES.
    const accented = 'á'.repeat(1000);
    expect(Buffer.byteLength(accented, 'utf8')).toBe(2000);
    expect(validatePromptAnswers(prompts, { p1: accented, p2: 'y' })).toEqual({
      ok: true,
      value: { p1: accented, p2: 'y' },
    });
  });

  it('rejects a payload whose UTF-8 byte size would breach the 16384-byte column CHECK, even though every answer is under 1000 chars', () => {
    // 10 prompts x 500 four-byte emoji (= 1000 JS chars, 2000 bytes) each:
    // every per-answer rule passes; octet_length would be ~20 KB.
    const many = Array.from({ length: 10 }, (_v, i) => ({ id: `q${i}`, text: `t${i}` }));
    const answers: Record<string, string> = {};
    for (const p of many) answers[p.id] = '\u{1F600}'.repeat(500);
    expect(validatePromptAnswers(many, answers)).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
  });

  it('rejects prototype-pollution style keys (they are never a known prompt id)', () => {
    const raw = JSON.parse('{"__proto__":"x","p1":"a","p2":"b"}');
    expect(validatePromptAnswers(prompts, raw)).toEqual({ ok: false, error: 'invalid_prompt_answers' });
  });

  it('rejects a NUL byte in an answer (jsonb cannot store it)', () => {
    expect(validatePromptAnswers(prompts, { p1: 'five\u0000', p2: 'yes' })).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
  });

  it('tolerates a raw jsonb prompts column value in place of a parsed list', () => {
    expect(validatePromptAnswers(null, undefined)).toEqual({ ok: true, value: {} });
    expect(validatePromptAnswers([{ id: 'p1', text: 'q' }], { p1: 'a' })).toEqual({
      ok: true,
      value: { p1: 'a' },
    });
  });
});

describe('normalizePromptAnswers (partial top-up path)', () => {
  const prompts: PreApplicationPrompt[] = [
    { id: 'p1', text: 'Years of framing?' },
    { id: 'p2', text: 'Own tools?' },
  ];

  it('accepts a PARTIAL set (write-once merges top up one id at a time)', () => {
    expect(normalizePromptAnswers(prompts, { p2: ' yes ' })).toEqual({ ok: true, value: { p2: 'yes' } });
  });

  it('accepts an empty/absent set as a no-op', () => {
    expect(normalizePromptAnswers(prompts, undefined)).toEqual({ ok: true, value: {} });
    expect(normalizePromptAnswers(prompts, {})).toEqual({ ok: true, value: {} });
  });

  it('still enforces known ids, per-answer bounds and the byte cap', () => {
    expect(normalizePromptAnswers(prompts, { nope: 'x' })).toEqual({ ok: false, error: 'invalid_prompt_answers' });
    expect(normalizePromptAnswers(prompts, { p1: 'x'.repeat(1001) })).toEqual({ ok: false, error: 'invalid_prompt_answers' });
    expect(normalizePromptAnswers(prompts, { p1: '  ' })).toEqual({ ok: false, error: 'invalid_prompt_answers' });
  });

  it('rejects a NUL byte in a top-up answer too', () => {
    expect(normalizePromptAnswers(prompts, { p2: 'yes\u0000' })).toEqual({
      ok: false,
      error: 'invalid_prompt_answers',
    });
  });
});
