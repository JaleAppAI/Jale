import { describe, expect, it } from 'vitest';
import { normalizeAnswers, displayQuestion, displayAnswer } from '../trust-assessment';

// A legacy WhatsApp numbered-menu question blob. The menu path is gone, but
// rows like this are still in the database, so both display helpers have to
// keep handling them: `displayQuestion` trims the blob to its prompt line, and
// `displayAnswer` renders the stored answer as plain, untranslated text.
const NUMBERED_Q = 'One more question so we can recommend better jobs.\nWhat type of work do you do most?\n1. Framing\n2. Finishing\n3. Roofing\nReply with the number.';

describe('displayQuestion', () => {
  it('trims menu blobs to the last non-empty line before the first numbered option', () => {
    expect(displayQuestion({ q_en: NUMBERED_Q, answer_text: '', answer_source: 'text', answered_at: '' }, 'en'))
      .toBe('What type of work do you do most?');
  });
  it('prefers q_es for es locale and falls back to q_en', () => {
    const a = { q_en: 'Describe a task.', q_es: 'Describe una tarea.', answer_text: '', answer_source: 'text' as const, answered_at: '' };
    expect(displayQuestion(a, 'es')).toBe('Describe una tarea.');
    expect(displayQuestion({ ...a, q_es: null }, 'es')).toBe('Describe a task.');
  });
});

describe('displayAnswer', () => {
  // No locale argument by design: an answer is never translated, so there is
  // no Spanish rendering of it to assert.
  it('renders a text answer verbatim', () => {
    const a = { q_en: 'Describe a common task.', answer_text: 'I hang panels', answer_source: 'text' as const, answered_at: '' };
    expect(displayAnswer(a)).toEqual({ kind: 'text', text: 'I hang panels' });
  });
  it('renders a legacy numbered-menu answer as plain, untranslated text', () => {
    const a = { q_en: NUMBERED_Q, answer_text: 'Finish work', answer_source: 'text' as const, answered_at: '' };
    // 'Finish work' used to be swapped for 'Acabados' on the Spanish locale.
    expect(displayAnswer(a)).toEqual({ kind: 'text', text: 'Finish work' });
  });
  it('voice answers keep the verbatim transcript with kind voice', () => {
    const a = { q_en: NUMBERED_Q, answer_text: 'tengo ocho años colgando paneles', answer_source: 'voice' as const, answered_at: '' };
    expect(displayAnswer(a)).toEqual({ kind: 'voice', text: 'tengo ocho años colgando paneles' });
    expect(displayAnswer({ ...a, q_en: 'Describe a common task.' }))
      .toEqual({ kind: 'voice', text: 'tengo ocho años colgando paneles' });
  });
});

describe('normalizeAnswers', () => {
  it('sorts by question_index ?? index, tolerates legacy rows, dedupes by q_en keeping latest answered_at, skips rows without q_en', () => {
    const raw = [
      { q_en: 'Q2', answer_text: 'old', answer_source: 'text', answered_at: '2026-01-01T00:00:00Z' },
      { q_en: 'Q2', answer_text: 'new', answer_source: 'text', answered_at: '2026-02-01T00:00:00Z' },
      { question_index: 0, q_en: 'Q1', q_es: 'P1', answer_text: 'a', answer_source: 'voice', answered_at: '2026-01-01T00:00:00Z' },
      { answer_text: 'orphan', answer_source: 'text', answered_at: '' },
    ];
    const out = normalizeAnswers(raw);
    expect(out.map((x) => x.q_en)).toEqual(['Q1', 'Q2']);
    expect(out[1].answer_text).toBe('new');
  });
  it('returns [] for non-array input', () => {
    expect(normalizeAnswers(null)).toEqual([]);
    expect(normalizeAnswers('nope')).toEqual([]);
  });

  it('orders a legacy re-answer by first-seen position, not its later array position', () => {
    const raw = [
      { question_index: 0, q_en: 'Q1', answer_text: 'a1', answer_source: 'text', answered_at: '2026-01-01T00:00:00Z' },
      { q_en: 'Q2', answer_text: 'old2', answer_source: 'text', answered_at: '2026-01-01T00:00:00Z' },
      { q_en: 'Q3', answer_text: 'a3', answer_source: 'text', answered_at: '2026-01-01T00:00:00Z' },
      { q_en: 'Q2', answer_text: 'new2', answer_source: 'text', answered_at: '2026-03-01T00:00:00Z' },
    ];
    const out = normalizeAnswers(raw);
    expect(out.map((x) => x.q_en)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(out[1].answer_text).toBe('new2');
  });
});
