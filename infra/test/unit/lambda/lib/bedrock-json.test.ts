import {
  BedrockJsonParseError,
  extractFirstJsonValue,
  parseBedrockJson,
  stripCodeFences,
} from '../../../../lambda/lib/bedrock-json';

describe('stripCodeFences', () => {
  it('leaves bare JSON untouched', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a ```json fence', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a bare ``` fence', () => {
    expect(stripCodeFences('```\n[1,2]\n```')).toBe('[1,2]');
  });

  it('strips a leading fence even without a trailing one', () => {
    expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
  });
});

describe('extractFirstJsonValue', () => {
  it('returns the object when the whole string is one', () => {
    expect(extractFirstJsonValue('{"a":1}')).toBe('{"a":1}');
  });

  it('finds an object after leading prose', () => {
    expect(extractFirstJsonValue('Here is the ranking you asked for:\n{"a":1}'))
      .toBe('{"a":1}');
  });

  it('finds an object before trailing prose', () => {
    expect(extractFirstJsonValue('{"a":1}\n\nLet me know if you need more detail.'))
      .toBe('{"a":1}');
  });

  it('is string-aware: braces and brackets inside strings do not end the value', () => {
    const raw = '{"note":"a } brace and a ] bracket","b":2}';
    expect(extractFirstJsonValue(`chatter ${raw} more chatter`)).toBe(raw);
  });

  it('is escape-aware: an escaped quote does not close the string', () => {
    const raw = '{"note":"he said \\"} \\" once","b":2}';
    expect(extractFirstJsonValue(raw)).toBe(raw);
  });

  it('returns a top-level array', () => {
    expect(extractFirstJsonValue('Sure!\n[{"q_en":"a"},{"q_en":"b"}]\nDone.'))
      .toBe('[{"q_en":"a"},{"q_en":"b"}]');
  });

  it('returns a nested-object array unbroken', () => {
    const raw = '[{"a":{"b":[1,2]}},{"c":"]"}]';
    expect(extractFirstJsonValue(`prose ${raw}`)).toBe(raw);
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractFirstJsonValue('I cannot help with that.')).toBeNull();
  });

  it('returns null when the value never closes', () => {
    expect(extractFirstJsonValue('{"a":1')).toBeNull();
  });
});

describe('parseBedrockJson', () => {
  it('parses plain JSON', () => {
    expect(parseBedrockJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(parseBedrockJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON preceded by prose', () => {
    expect(parseBedrockJson('Here you go:\n\n{"ranked_candidates":[]}'))
      .toEqual({ ranked_candidates: [] });
  });

  it('parses JSON followed by prose', () => {
    expect(parseBedrockJson('{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('parses JSON with braces inside strings', () => {
    expect(parseBedrockJson('{"note":"use {this} and [that]"}'))
      .toEqual({ note: 'use {this} and [that]' });
  });

  it('parses a top-level array', () => {
    expect(parseBedrockJson('[{"q_en":"a"}]')).toEqual([{ q_en: 'a' }]);
  });

  it('parses a fenced array wrapped in prose', () => {
    expect(parseBedrockJson('Sure.\n```json\n[1,2,3]\n```\nAnything else?'))
      .toEqual([1, 2, 3]);
  });

  it('throws BedrockJsonParseError tagged parse on garbage', () => {
    let caught: unknown;
    try {
      parseBedrockJson('I am sorry, I cannot do that.');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BedrockJsonParseError);
    expect((caught as BedrockJsonParseError).kind).toBe('parse');
  });

  it('throws on an empty response', () => {
    expect(() => parseBedrockJson('')).toThrow(BedrockJsonParseError);
  });

  it('throws on a truncated object', () => {
    expect(() => parseBedrockJson('{"ranked_candidates":[{"candidate_ref":"c1"'))
      .toThrow(BedrockJsonParseError);
  });
});
