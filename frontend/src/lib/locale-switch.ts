// Href construction for a language toggle that must not drop the visitor's
// query string.
//
// This exists because of the `?r=` share tag on the public job page. That tag
// IS the referral attribution chain: `ReferralContext` resolves who shared the
// link from it, `ApplyButton` sends it back with the apply intent, and
// `WebApplyButton` carries it into the signup flow. A locale toggle whose href
// is a bare path therefore does not merely change language -- it silently
// detaches the rest of the visit from the person who referred it, and nothing
// downstream can tell that it happened.
//
// Kept as a standalone pure function rather than inlined at the call site so
// the preservation rule is testable without a DOM, and so a second locale
// toggle added later has an obvious thing to reuse.

/**
 * Re-attaches `search` to `path`.
 *
 * `search` is accepted in either shape the platform hands out --
 * `URLSearchParams.toString()` gives `"r=demo"`, `location.search` gives
 * `"?r=demo"` -- because the caller should not have to care which one it is
 * holding.
 *
 * An absent or empty query yields the bare path and never a dangling `"?"`:
 * `/es/j/ABC?` and `/es/j/ABC` are the same page but two cache keys and two
 * canonical-looking URLs, and the empty case is the common one (most visitors
 * arrive without a share tag).
 *
 * Parameter order and encoding are whatever the caller already has. The tag is
 * passed through verbatim rather than parsed and re-serialized, so a value the
 * API issued survives byte-for-byte.
 */
export function localeSwitchHref(path: string, search: string | null | undefined): string {
  if (!search) return path;
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query ? `${path}?${query}` : path;
}
