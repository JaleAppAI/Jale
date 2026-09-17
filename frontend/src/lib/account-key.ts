/**
 * Which ACCOUNT a piece of remembered UI state belongs to.
 *
 * Browser storage is per browser, not per account, and this product is
 * routinely used with more than one account on one machine -- a contractor and
 * their office manager sharing a laptop, or an operator holding several
 * employer logins. Anything we remember about "this employer" therefore has to
 * carry the employer in its key, or the first account's choices silently
 * become the second account's.
 *
 * The id is Cognito's `sub`, read out of the id token WITHOUT verifying it.
 * That is safe for exactly this use and no other: the value never authorizes
 * anything, it only namespaces a storage key. A forged token would namespace
 * one browser's own preferences under a different string, which is not a
 * capability. Anything that grants access still verifies the token server-side.
 *
 * Every failure -- no token, a malformed one, a payload without a `sub` --
 * returns null, and every caller reads that as "we do not know which account
 * this is", which must mean "do not read and do not write" rather than "use an
 * unscoped key". An unscoped fallback is the bug this module exists to remove.
 */

/** Characters allowed in a key segment. Cognito subs are UUIDs; be strict. */
const UNSAFE = /[^A-Za-z0-9_-]/g;

function decodeSegment(segment: string): string {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    // `atob` yields bytes, and a JWT payload is UTF-8, so the bytes are decoded
    // rather than read as latin-1 -- otherwise a non-ASCII claim would corrupt
    // the JSON before it is parsed.
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * The signed-in account's stable id, or null when it cannot be determined.
 * Never throws: a caller is always in a position to carry on without one.
 */
export function accountKeyFromIdToken(idToken: string | null | undefined): string | null {
    if (!idToken || typeof atob !== 'function') return null;
    const segments = idToken.split('.');
    if (segments.length < 2) return null;
    try {
        const payload: unknown = JSON.parse(decodeSegment(segments[1]));
        if (typeof payload !== 'object' || payload === null) return null;
        const sub = (payload as { sub?: unknown }).sub;
        if (typeof sub !== 'string' || sub.length === 0) return null;
        const safe = sub.replace(UNSAFE, '');
        return safe.length > 0 ? safe : null;
    } catch {
        return null;
    }
}

/**
 * `base` namespaced to one account. Callers hold the base key so it stays
 * greppable; this only ever appends, so a key's meaning is still readable from
 * the string in storage.
 */
export function accountScopedKey(base: string, account: string): string {
    return `${base}.${account}`;
}
