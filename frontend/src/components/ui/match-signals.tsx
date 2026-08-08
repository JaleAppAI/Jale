import type { ScoreBand } from '@/lib/match';

// The -text tokens hold exactly the hexes these used to hardcode, so light
// rendering is unchanged; going through the tokens is what re-tints them dark.
const BAND_STYLES: Record<ScoreBand, { background: string; color: string }> = {
  strong: { background: 'var(--jale-success-bg)', color: 'var(--jale-success-text)' },
  good: { background: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)' },
  fair: { background: 'var(--jale-warning-bg)', color: 'var(--jale-warning-text)' },
};

export function MatchScoreBadge({
  score,
  band,
  label,
}: {
  score: number;
  band: ScoreBand;
  label: string;
}) {
  const style = BAND_STYLES[band];

  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: style.background, color: style.color }}
    >
      {label} {score}%
    </span>
  );
}

export function MatchReasonChips({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {reasons.map((reason) => (
        <span
          key={reason}
          className="pill pill-info max-w-full"
          title={reason}
          style={{
            fontSize: 10,
            letterSpacing: '.04em',
            textTransform: 'none',
            overflowWrap: 'anywhere',
          }}
        >
          {reason}
        </span>
      ))}
    </div>
  );
}
