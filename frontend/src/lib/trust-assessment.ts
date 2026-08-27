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

const MENU_MARKER = 'Reply with the number';
const NUMBERED_OPTION_RE = /^\s*\d+\.\s/;

// Mirrors TRUST_OPTION_LABELS_ES (infra/lambda/whatsapp/lib/flows.ts:234-273).
// Menu answers are stored as English labels even for Spanish workers.
// Identity mappings (Framing, Industrial, Interior, Exterior, Spray) are kept
// so the map stays a verbatim mirror of the infra source.
const MENU_LABEL_ES: Record<string, string> = {
  Residential: 'Residencial',
  Commercial: 'Comercial',
  Industrial: 'Industrial',
  Repairs: 'Reparaciones',
  'New installs': 'Instalaciones nuevas',
  'Drain/sewer': 'Drenaje',
  Framing: 'Framing',
  'Finish work': 'Acabados',
  'Cabinets/trim': 'Gabinetes y molduras',
  Forms: 'Formas',
  Rebar: 'Varilla',
  'Pour/finish': 'Colado y acabado',
  Interior: 'Interior',
  Exterior: 'Exterior',
  'Prep/texture': 'Preparacion y textura',
  'General labor': 'Trabajo general',
  'Skilled trade': 'Oficio especializado',
  'Equipment/tools': 'Equipo y herramientas',
  Helper: 'Ayudante',
  'Can work alone': 'Puedo trabajar solo',
  'Lead crew': 'Lider de cuadrilla',
  'Pull wire': 'Jalar cable',
  'Bend conduit': 'Doblar conduit',
  'Work panels': 'Trabajar paneles',
  'Install pipe': 'Instalar tuberia',
  'Set fixtures': 'Instalar accesorios',
  'Water heaters': 'Calentadores de agua',
  'Read plans': 'Leer planos',
  'Frame walls': 'Levantar muros',
  'Install doors/trim': 'Instalar puertas y molduras',
  'Set forms': 'Poner formas',
  'Tie rebar': 'Amarrar varilla',
  'Finish concrete': 'Acabar concreto',
  'Prep/sanding': 'Preparar y lijar',
  Spray: 'Spray',
  'Roll/brush': 'Rodillo y brocha',
  'Use power tools': 'Usar herramientas electricas',
  'Site cleanup/safety': 'Limpieza y seguridad',
};

export function isMenuAnswer(a: TrustAnswer): boolean {
  return a.answer_source === 'text' && a.q_en.includes(MENU_MARKER);
}

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

export function displayAnswer(a: TrustAnswer, locale: string): { kind: 'text' | 'voice' | 'menu'; text: string } {
  if (a.answer_source === 'voice') return { kind: 'voice', text: a.answer_text };
  if (isMenuAnswer(a)) {
    const text = locale === 'es' ? (MENU_LABEL_ES[a.answer_text] ?? a.answer_text) : a.answer_text;
    return { kind: 'menu', text };
  }
  return { kind: 'text', text: a.answer_text };
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
