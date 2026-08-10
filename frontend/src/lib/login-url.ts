// Login-URL construction and return-path validation.
//
// A `returnUrl` travels from a session-expiry redirect, through the browser's
// address bar, back into a client-side navigation -- i.e. it is attacker
// controllable. Everything here treats it as untrusted input: only a
// same-origin, relative path ever survives `sanitizeReturnPath`.

const MAX_RETURN_PATH_LENGTH = 512;

/**
 * URL parsers STRIP tab/LF/CR (and browsers reject other control characters)
 * before resolving a URL, so `"/<TAB>/evil.com"` would become the
 * protocol-relative `"//evil.com"` AFTER the prefix checks below have passed.
 * Rejecting the whole class closes that bypass.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Returns `raw` when it is a safe same-origin relative path, otherwise null.
 *
 * Rejected: absolute URLs (`http://evil.com`), protocol-relative URLs
 * (`//evil.com`), any scheme (`javascript:alert(1)`, `mailto:`), backslashes
 * (browsers normalise `\` to `/`, so `/\evil.com` resolves off-origin),
 * control characters (see above), bare paths with no leading slash, and
 * anything over 512 characters.
 */
export function sanitizeReturnPath(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  if (hasControlCharacter(raw)) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('\\')) return null;
  // Explicit scheme guard. Redundant while the leading-slash rule above holds
  // (nothing can precede index 0), kept so loosening that rule cannot silently
  // reopen `javascript:`/`http:` payloads.
  const colon = raw.indexOf(':');
  const firstSlash = raw.indexOf('/');
  if (colon !== -1 && (firstSlash === -1 || colon < firstSlash)) return null;
  return raw;
}

/**
 * The login page for `userType`, optionally carrying where to come back to.
 * An unsafe or absent `returnPath` is simply dropped -- never rendered.
 */
export function buildLoginUrl(
  locale: string,
  userType: 'worker' | 'employer' | null,
  returnPath?: string,
): string {
  const base = `/${locale}/auth/${userType ?? 'worker'}`;
  const safeReturnPath = sanitizeReturnPath(returnPath ?? null);
  return safeReturnPath ? `${base}?returnUrl=${encodeURIComponent(safeReturnPath)}` : base;
}
