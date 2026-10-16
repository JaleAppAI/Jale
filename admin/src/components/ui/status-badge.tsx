import { Badge, type BadgeTone } from './badge';

/** K3.4 health states. Mirrors `HealthState` in lib/server/admin-analytics.ts. */
export type HealthStateName = 'healthy' | 'watch' | 'problem' | 'unknown';

const TONES: Record<HealthStateName, BadgeTone> = {
    healthy: 'success',
    watch: 'warning',
    problem: 'danger',
    unknown: 'neutral',
};

const LABELS: Record<HealthStateName, string> = {
    healthy: 'Healthy',
    watch: 'Watch',
    problem: 'Problem',
    unknown: 'Unknown',
};

// The -text tokens hold AA at 11px on the card in both themes.
const LABEL_CLASSES: Record<HealthStateName, string> = {
    healthy: 'font-bold text-[var(--jale-success-text)]',
    watch: 'font-bold text-[var(--jale-warning-text)]',
    problem: 'font-bold text-[var(--jale-danger-text)]',
    unknown: 'font-bold text-[var(--jale-ink-2)]',
};

export function statusTone(state: HealthStateName): BadgeTone {
    return TONES[state];
}

/** A health state in words plus colour; the words are always there. */
export function StatusBadge({ state }: { state: HealthStateName }) {
    return (
        <Badge tone={statusTone(state)} labelClassName={LABEL_CLASSES[state]}>
            {LABELS[state]}
        </Badge>
    );
}
