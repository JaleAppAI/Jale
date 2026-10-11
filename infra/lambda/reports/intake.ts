import type { APIGatewayProxyEvent } from 'aws-lambda';
import { setRlsContext } from '../lib/db';
import {
  CREATE_COLUMNS,
  attachAction,
  createReport,
  createRow,
  intakeHandler,
  invalid,
  parseBody,
  uploadAction,
  type Action,
  type ActionResult,
  type CreateRow,
} from './lib/actions';
import { roleFromIssuer } from './lib/role';
import { validateCreate } from './lib/validate';

/**
 * POST /reports/{action}: "report a problem", signed in (dual authorizer,
 * login `jale_api`).
 *
 *   create   save a report for the verified sign-in
 *   upload   a new image upload for a saved report, by its attach token
 *   attach   check and attach the uploaded image, by its attach token
 *
 * The reporter is the verified sign-in alone. The Lambda reads `sub` and
 * `iss` from the authorizer's claims and nothing about the reporter from the
 * body; SQL takes the caller from the transaction-local setting and decides
 * the role from the account when one exists, else from the issuer's pool.
 * There is no terms check and no "account not ready" answer: a sign-in with
 * no account yet is a normal reporter.
 */

async function create(event: APIGatewayProxyEvent): Promise<ActionResult> {
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined;
  const sub = claims?.sub;
  // The authorizer guarantees a sub on this route; without one the route is
  // misconfigured, which is a server error, not the caller's.
  if (typeof sub !== 'string' || sub === '') throw new Error('report_intake_no_caller');

  const body = parseBody(event);
  if (!body.ok) return body.result;
  const role = roleFromIssuer(claims?.iss);
  const checked = validateCreate(body.value, role);
  if (!checked.ok) return invalid(checked.fields);
  const input = checked.value;

  return createReport(input, {
    role,
    verified: true,
    rateLimitScope: 'account',
    create: async (client, tokenHash) => {
      await setRlsContext(client, sub);
      const { rows } = await client.query<CreateRow>(
        `SELECT ${CREATE_COLUMNS}
           FROM jale_cap.problem_report_create_verified(
                  $1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::text, $7::boolean, $8::jsonb, $9::text)`,
        [
          input.clientKey, role, input.category, input.description, input.stopsWork, input.locale,
          input.includeTechnical, JSON.stringify(input.context), tokenHash,
        ],
      );
      return createRow(rows, 'problem_report_create_verified');
    },
  });
}

const routes: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['POST create', create],
  ['POST upload', uploadAction],
  ['POST attach', attachAction],
]);

export const handler = intakeHandler('report_intake', routes);
