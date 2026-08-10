import type { ScoreBand } from '@/lib/match';
import { Badge, scoreBandBadgeTone } from './badge';

/**
 * Match signals rendered in the one badge language the app has: a coloured dot
 * plus muted text. Both components keep their previous props exactly, so every
 * call site (WorkerJobCard, employer job detail) is untouched — only the paint
 * changed, from filled pills to dot + text.
 */

export function MatchScoreBadge({
    score,
    band,
    label,
}: {
    score: number;
    band: ScoreBand;
    label: string;
}) {
    return (
        <Badge tone={scoreBandBadgeTone(band)} className="whitespace-nowrap">
            {label} {score}%
        </Badge>
    );
}

export function MatchReasonChips({ reasons }: { reasons: string[] }) {
    if (reasons.length === 0) return null;

    return (
        // Wider horizontal gap than the old pills needed: without backgrounds,
        // whitespace is the only thing separating one reason from the next.
        <div className="flex flex-wrap gap-x-4 gap-y-1">
            {reasons.map((reason) => (
                <Badge key={reason} tone="info" className="max-w-full">
                    {/* Callers pass pre-truncated text; `title` keeps the full
                        reason reachable on hover. */}
                    <span title={reason} className="[overflow-wrap:anywhere]">
                        {reason}
                    </span>
                </Badge>
            ))}
        </div>
    );
}
