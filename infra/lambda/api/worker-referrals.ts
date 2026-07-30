import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage, requireAbsoluteBaseUrl } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

// One more than the response cap below, so we can tell "exactly 200" apart
// from "more than 200" without a second COUNT(*) query.
const REFERRAL_LIST_LIMIT = 200;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    // Fail fast, before touching the DB, rather than emitting a relative
    // (dead) share_url on every row in the list.
    const base = requireAbsoluteBaseUrl(process.env.PUBLIC_SITE_BASE_URL);
    if (!base) {
      console.error('worker-referrals error: share_url_misconfigured');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'share_url_misconfigured' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    const workerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (workerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    const workerId: string = workerRes.rows[0].id;

    // RLS (policy job_share_links_owner) already scopes job_share_links to
    // rows this caller owns; the WHERE below is defensive, not the only
    // protection.
    //
    // We deliberately do NOT join or count worker_attribution here. That
    // table has FORCE ROW LEVEL SECURITY and, for jale_admin, only the
    // worker_attribution_owner policy -- which scopes rows to the CALLER's
    // own worker_id (migration 055, "A worker reads their own attribution").
    // A COUNT(*) of other workers' worker_attribution rows keyed by
    // first_share_code would be silently filtered to zero by RLS, which is
    // indistinguishable from a true zero -- worse than not reporting it. So
    // this role cannot compute "how many workers a link brought in"; we
    // return open_count (from job_share_links, which this role CAN read)
    // and omit the signup count rather than report a fake zero. Do not add
    // an RLS policy/grant to make this work -- that's out of scope here.
    const result = await client.query(
      `SELECT l.job_id, l.channel, l.code, l.open_count, l.last_opened_at, l.created_at,
              j.public_code AS job_public_code, j.title AS job_title
         FROM job_share_links l
         LEFT JOIN jobs j ON j.id = l.job_id
        WHERE l.referrer_worker_id = $1
        ORDER BY l.created_at DESC
        LIMIT $2`,
      [workerId, REFERRAL_LIST_LIMIT + 1],
    );
    await client.query('COMMIT');

    // jobs is also RLS-scoped for jale_admin (jobs_worker_read_active limits
    // a worker to status = 'active' jobs). A LEFT JOIN is used rather than
    // an INNER JOIN so referral history for a job that has since been
    // paused/filled/closed still shows up -- with job_public_code/job_title
    // as null -- instead of silently disappearing from the list.
    const truncated = result.rows.length > REFERRAL_LIST_LIMIT;
    const rows = truncated ? result.rows.slice(0, REFERRAL_LIST_LIMIT) : result.rows;
    const referrals = rows.map((row) => ({
      job_id: row.job_id,
      job_public_code: row.job_public_code ?? null,
      job_title: row.job_title ?? null,
      channel: row.channel,
      open_count: row.open_count,
      last_opened_at: row.last_opened_at,
      created_at: row.created_at,
      share_url: row.job_public_code ? `${base}/j/${row.job_public_code}?r=${row.code}` : null,
    }));

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ referrals, truncated }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-referrals error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
