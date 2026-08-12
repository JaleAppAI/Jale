/**
 * Skeleton atoms. The visual recipe (rounded paper-2 block, `animate-pulse`
 * with a `motion-reduce` opt-out) is factored out of the original
 * `PageSkeleton`, which is the pattern already proven in production on the
 * worker/employer profile pages.
 *
 * Two light-surface tones exist because a skeleton needs internal contrast to
 * read as structure rather than a grey slab: `paper` for labels/chrome and
 * `divider` for the "content" line it labels. `rail` is the third, for the one
 * dark surface in the app.
 */

export type SkeletonTone = 'paper' | 'divider' | 'rail';

const toneClasses: Record<SkeletonTone, string> = {
    paper: 'bg-[var(--jale-paper-2)]',
    divider: 'bg-[var(--jale-divider)]',
    // The navy sidebar (`--jale-sidebar`). Both paper tones are invisible
    // there, and a `className` override cannot beat a tone class reliably --
    // Tailwind resolves duplicate properties by stylesheet order, not by the
    // order they appear in the attribute. So the rail gets a real tone.
    // White-at-15% is the same white-on-navy family the rail's own dividers
    // and muted text already use, and it holds in both themes because the
    // surface under it is navy in both.
    rail: 'bg-white/15',
};

/** Shared pulse; `motion-reduce:animate-none` honours the OS setting. */
const pulse = 'animate-pulse motion-reduce:animate-none';

/**
 * Generic skeleton block. Size it with `className` (height/width utilities);
 * the base only owns the fill, the radius and the pulse.
 */
export function Skeleton({
    className = '',
    tone = 'paper',
}: {
    className?: string;
    tone?: SkeletonTone;
}) {
    return <div className={`rounded ${toneClasses[tone]} ${pulse} ${className}`} />;
}

/**
 * A single line of "text". Defaults to `h-3.5`, matching the body line height
 * the real components render at, so a skeleton→content swap does not shift
 * layout. `width` is any Tailwind width class (e.g. `w-3/4`, `w-40`).
 */
export function SkeletonLine({
    width = 'w-full',
    className = '',
    tone = 'divider',
}: {
    width?: string;
    className?: string;
    tone?: SkeletonTone;
}) {
    return <Skeleton tone={tone} className={`h-3.5 ${width} ${className}`} />;
}

/**
 * Circular skeleton for avatars/icon tiles. `size` is in pixels and is applied
 * inline because avatar diameters in this app are arbitrary (36/40/44), not
 * spacing-scale values.
 */
export function SkeletonCircle({
    size = 36,
    className = '',
    tone = 'paper',
}: {
    size?: number;
    className?: string;
    tone?: SkeletonTone;
}) {
    return (
        <div
            className={`shrink-0 rounded-full ${toneClasses[tone]} ${pulse} ${className}`}
            style={{ width: size, height: size }}
        />
    );
}
