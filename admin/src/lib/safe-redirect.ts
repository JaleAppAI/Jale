// ASCII control characters: C0 (U+0000-U+001F) and DEL (U+007F).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Returns a safe SAME-ORIGIN relative path, or '/' if the candidate could be an
 * open redirect. Accepts only paths that start with a single '/' and are not
 * protocol-relative ('//evil.com') or scheme-bearing ('https:...'). Used both
 * where the `next` param is written (the proxy) and where it is consumed
 * (login redirect) so an attacker-controlled `?next=` can never send an
 * authenticated admin off-site.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (!candidate) return '/';
  // Must start with exactly one '/', and contain no control chars / backslashes
  // (some browsers treat '/\' like '//', and drop a tab or newline before
  // resolving a URL).
  if (!/^\/(?!\/)/.test(candidate) || candidate.includes('\\') || CONTROL_CHARACTER.test(candidate)) {
    return '/';
  }
  return candidate;
}
