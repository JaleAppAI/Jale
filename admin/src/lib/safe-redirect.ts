/**
 * Returns a safe SAME-ORIGIN relative path, or '/' if the candidate could be an
 * open redirect. Accepts only paths that start with a single '/' and are not
 * protocol-relative ('//evil.com') or scheme-bearing ('https:...'). Used both
 * where the `next` param is written (middleware) and where it is consumed
 * (login redirect) so an attacker-controlled `?next=` can never send an
 * authenticated admin off-site.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (!candidate) return '/';
  // Must start with exactly one '/', and contain no control chars / backslashes
  // (some browsers treat '/\' like '//').
  if (!/^\/(?!\/)/.test(candidate) || candidate.includes('\\')) {
    return '/';
  }
  return candidate;
}
