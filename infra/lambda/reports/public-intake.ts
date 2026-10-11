import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import {
  CREATE_COLUMNS,
  attachAction,
  createReport,
  createRow,
  intakeHandler,
  invalid,
  parseBody,
  respond,
  uploadAction,
  type Action,
  type ActionResult,
  type CreateRow,
} from './lib/actions';
import { getAddressSalt, hashAddress, readViewerAddress } from './lib/address';
import { validatePublicCreate } from './lib/validate';

/**
 * /public/reports/{action}: "report a problem", signed out (no authorizer,
 * login `jale_api_public_reports`, which may only execute the report intake
 * functions).
 *
 *   GET  config   the effective switches, cached for a minute
 *   POST create   save an unverified report
 *   POST upload   a new image upload for a saved report, by its attach token
 *   POST attach   check and attach the uploaded image, by its attach token
 *
 * upload and attach accept the attach token of any report, signed in or
 * not: the token is the whole credential on these routes.
 *
 * A create is limited per viewer address. The address comes from the header
 * the edge sets, hashed with a salt from Secrets Manager that is read before
 * the transaction opens; a request without the header is refused, and a salt
 * that cannot be read fails the request rather than skipping the limits.
 */

async function config(): Promise<ActionResult> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ reporting: unknown; signed_out: unknown; screenshots: unknown }>(
      'SELECT reporting, signed_out, screenshots FROM jale_cap.problem_report_config()',
    );
    const row = rows[0];
    if (!row) throw new Error('problem_report_config: no row');
    return {
      response: respond(
        200,
        { reporting: row.reporting === true, signed_out: row.signed_out === true, screenshots: row.screenshots === true },
        { 'Cache-Control': 'public, max-age=60' },
      ),
      outcome: 'ok',
    };
  } finally {
    client.release();
  }
}

async function create(event: APIGatewayProxyEvent): Promise<ActionResult> {
  const body = parseBody(event);
  if (!body.ok) return body.result;
  const checked = validatePublicCreate(body.value);
  if (!checked.ok) return invalid(checked.fields);
  const input = checked.value;

  const address = readViewerAddress(event);
  if (!address) return invalid(undefined, 'no_viewer_address');
  const addressHash = hashAddress(await getAddressSalt(), address);

  return createReport(input, {
    role: input.roleClaimed,
    verified: false,
    rateLimitScope: 'address',
    create: async (client, tokenHash) => {
      const { rows } = await client.query<CreateRow>(
        `SELECT ${CREATE_COLUMNS}
           FROM jale_cap.problem_report_create_unverified(
                  $1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::text, $7::text, $8::boolean, $9::jsonb,
                  $10::text, $11::text)`,
        [
          input.clientKey, input.roleClaimed, input.category, input.description, input.stopsWork, input.locale,
          input.contact, input.includeTechnical, JSON.stringify(input.context), tokenHash, addressHash,
        ],
      );
      return createRow(rows, 'problem_report_create_unverified');
    },
  });
}

const routes: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['GET config', config],
  ['POST create', create],
  ['POST upload', uploadAction],
  ['POST attach', attachAction],
]);

export const handler = intakeHandler('report_public_intake', routes);
