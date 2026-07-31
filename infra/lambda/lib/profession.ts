// Contract: lowercase, trim, collapse whitespace, hyphens/punctuation to spaces,
// strip accents. Must match normalizeProfession() in lambda/ai/question-generator.ts.
export function normalizeProfession(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[-./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
