/**
 * Initials avatar — the tinted stand-in used wherever a person or company has
 * no photo (shell header, profile rows, applicant lists).
 *
 * The look is `globals.css`'s `.avatar-initials`: a `--jale-blue-50` tile with
 * `--jale-blue-700` text. Both tokens flip in `.dark` (a light tint on blue ink
 * becomes a deep tint on pale ink), so the tile stays legible in either theme
 * without this component knowing which one is active.
 */

/**
 * Canonical initials derivation — first letter of the first two words,
 * uppercased. This is the single implementation in the app; `nav-config`
 * re-exports it so existing shell callers keep their import path.
 *
 * Empty or whitespace-only input yields `fallback`, never an empty tile.
 */
export function getInitials(value: string, fallback = '?'): string {
    const words = value.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return fallback;

    const letters = words
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('');

    return letters || fallback;
}

export function InitialsAvatar({
    name,
    size = 36,
    square = false,
    fallback = '?',
    className = '',
}: {
    name: string;
    /** Edge length in px. Type scales with the tile so small avatars stay inside it. */
    size?: number;
    /** Rounded-square tile (nav/header) instead of the default circle. */
    square?: boolean;
    /**
     * Shown when `name` has no usable letters. The shell passes a role letter
     * ("W"/"E") so the pre-fetch placeholder is not a locale-dependent guess at
     * the initials of a fallback string like "Your profile".
     */
    fallback?: string;
    className?: string;
}) {
    return (
        <span
            className={['avatar-initials', square ? 'square' : '', className].filter(Boolean).join(' ')}
            style={{
                width: size,
                height: size,
                // 0.38 keeps a 36px tile on the 14px `.avatar-initials` default
                // while letting 24px and 64px tiles stay proportionate.
                fontSize: Math.max(10, Math.round(size * 0.38)),
            }}
        >
            {getInitials(name, fallback)}
        </span>
    );
}
