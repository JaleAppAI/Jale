import type { PoolClient } from 'pg';

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

// Full handler implementation added in Task 11.
export async function handleBuildingCustomTrust(
  _client: PoolClient,
): Promise<void> {
  throw new Error('handleBuildingCustomTrust is not implemented yet');
}
