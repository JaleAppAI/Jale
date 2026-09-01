// Pure display normalizers for a worker's `worker_trust_assessments.answers[]`
// on the employer trust panel. No validation (the backend owns that); a shape
// this doesn't recognize degrades gracefully rather than throwing.
export interface TrustAnswer {
  question_index?: number | null;
  q_en: string;
  q_es?: string | null;
  answer_text: string;
  answer_source: 'text' | 'voice';
  answered_at: string;
}

const NUMBERED_OPTION_RE = /^\s*\d+\.\s/;

export function displayQuestion(a: TrustAnswer, locale: string): string {
  const q = locale === 'es' && a.q_es ? a.q_es : a.q_en;
  const lines = q.split('\n');
  const firstOption = lines.findIndex((l) => NUMBERED_OPTION_RE.test(l));
  if (firstOption <= 0) return q.trim();
  for (let i = firstOption - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return q.trim();
}

/**
 * Answers are free text or a voice transcript -- never a menu pick, so there
 * is nothing locale-dependent left to do here (contrast `displayQuestion`,
 * which still picks `q_es`). Legacy rows answered through the retired
 * WhatsApp numbered menu hold an English option label (e.g. "Framing"); they
 * display verbatim as text, like any other text answer.
 */
export function displayAnswer(a: TrustAnswer): { kind: 'text' | 'voice'; text: string } {
  return { kind: a.answer_source === 'voice' ? 'voice' : 'text', text: a.answer_text };
}

export function normalizeAnswers(raw: unknown): TrustAnswer[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter(
    (r): r is TrustAnswer => !!r && typeof (r as TrustAnswer).q_en === 'string' && (r as TrustAnswer).q_en.length > 0,
  );

  // Display order must survive legacy duplicates: a re-answered legacy
  // question gets appended to the raw array (its position no longer reflects
  // question order), while its dedupe winner is chosen by answered_at below.
  // So the sort key uses each q_en's FIRST-SEEN array position, not the
  // winning row's own position -- v2 rows carry an explicit question_index
  // and take priority over a same-valued first-seen fallback.
  const firstSeenIndex = new Map<string, number>();
  const byQuestion = new Map<string, TrustAnswer>();
  rows.forEach((r, i) => {
    if (!firstSeenIndex.has(r.q_en)) firstSeenIndex.set(r.q_en, i);
    const prev = byQuestion.get(r.q_en);
    if (!prev || (r.answered_at ?? '') >= (prev.answered_at ?? '')) byQuestion.set(r.q_en, r);
  });

  const sortKey = (a: TrustAnswer): [number, number] =>
    a.question_index != null ? [a.question_index, 0] : [firstSeenIndex.get(a.q_en) ?? 0, 1];

  return Array.from(byQuestion.values()).sort((x, y) => {
    const [xIndex, xTier] = sortKey(x);
    const [yIndex, yTier] = sortKey(y);
    return xIndex - yIndex || xTier - yTier;
  });
}
