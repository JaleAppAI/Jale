import type { ReportRole } from './validate';

/**
 * The role a verified sign-in implies, from its issuer.
 *
 * The dual authorizer accepts a token from either user pool and cannot say
 * which one it came from, so the role is read from the token's `iss` claim:
 * its last path segment is the id of the pool that issued it, compared with
 * the two pool ids the stack passes in. Anything else, including a missing
 * claim, is `unknown`, and then the reporter's account decides the role in
 * SQL. The request body never names the role of a signed-in reporter.
 */
export function roleFromIssuer(
  iss: unknown,
  env: { WORKER_USER_POOL_ID?: string; EMPLOYER_USER_POOL_ID?: string } = process.env,
): ReportRole {
  if (typeof iss !== 'string' || iss === '') return 'unknown';
  const poolId = iss.slice(iss.lastIndexOf('/') + 1);
  const workerPool = env.WORKER_USER_POOL_ID ?? '';
  const employerPool = env.EMPLOYER_USER_POOL_ID ?? '';
  if (poolId === '' || workerPool === employerPool) return 'unknown';
  if (poolId === workerPool) return 'worker';
  if (poolId === employerPool) return 'employer';
  return 'unknown';
}
