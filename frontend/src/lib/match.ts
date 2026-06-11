export type ScoreBand = 'strong' | 'good' | 'fair';

export function normalizeMatchScore(score: unknown): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    return null;
  }
  return Math.round(score);
}

export function scoreBandForScore(score: number): ScoreBand {
  if (score >= 70) return 'strong';
  if (score >= 45) return 'good';
  return 'fair';
}

export function normalizeScoreBand(value: unknown, score: number): ScoreBand {
  if (value === 'strong' || value === 'good' || value === 'fair') {
    return value;
  }
  return scoreBandForScore(score);
}

export function humanizeReasonCode(reason: string): string {
  return reason
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function truncateMatchReason(reason: string, maxLength = 42): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
