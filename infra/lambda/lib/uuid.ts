/**
 * The one UUID check.
 *
 * It lived in `billing-operations.ts`, and the two keyset pagers each grew
 * their own copy of the same regex -- which is how a validator ends up
 * accepting three slightly different things. It is here, with no dependencies,
 * so that a handler needing nothing but this (an unauthenticated jobs index,
 * say) does not pull the billing and compliance module graph into its bundle
 * to get at it.
 *
 * Version 1-5, RFC 4122 variant: exactly what PostgreSQL's `uuid` columns hold
 * and what `::uuid` will accept without erroring.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
