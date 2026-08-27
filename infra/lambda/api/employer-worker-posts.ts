import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const workerId = event.pathParameters?.worker_id;
    if (!workerId || !UUID_RE.test(workerId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_params' }) };
    }

    const rawLimit = Number(event.queryStringParameters?.limit ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    // Composite keyset cursor: `before` (timestamp) and `before_id` (uuid)
    // must be provided together or not at all — a lone `before` can't be
    // used to build the tie-broken (created_at, id) comparison below.
    const rawBefore = event.queryStringParameters?.before;
    const rawBeforeId = event.queryStringParameters?.before_id;
    let before: string | null = null;
    let beforeId: string | null = null;
    if (rawBefore || rawBeforeId) {
      if (!rawBefore || !rawBeforeId) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_before' }) };
      }
      const parsed = new Date(rawBefore);
      if (Number.isNaN(parsed.getTime()) || !UUID_RE.test(rawBeforeId)) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_before' }) };
      }
      before = parsed.toISOString();
      beforeId = rawBeforeId;
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(
      client,
      cognitoSub,
      process.env.REQUIRED_TOS_VERSION!,
    );
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
        }),
      };
    }

    // Resolve the employer's own internal id — the DEFINER-based RLS
    // policies key on app.current_internal_user_id, and this must be the
    // employer's id, never the worker's (setting it to the worker's id
    // would satisfy the worker self-access policies instead).
    const employerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    const employerId: string | undefined = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    await setInternalUserRlsContext(client, employerId);

    // Relationship check: any application from this worker to any of the
    // employer's jobs unlocks the board (relationship-scoped, not job-scoped).
    // This is the explicit 403 source — RLS above is defense-in-depth.
    const relationship = await client.query(
      `SELECT 1
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users employer ON employer.id = j.employer_id
       WHERE ja.worker_id = $1
         AND employer.cognito_sub = $2
       LIMIT 1`,
      [workerId, cognitoSub],
    );
    if (relationship.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    // Only posts with at least one approved media item are visible to
    // employers — filtered in SQL so next_before/next_before_id (computed
    // below from this same result set) never skew against a client-side
    // filter removing rows after the page boundary was fixed.
    const params: unknown[] = [workerId, before, beforeId, limit];
    const postsRes = await client.query(
      `SELECT id, caption, source, created_at
       FROM worker_posts p
       WHERE p.worker_id = $1 AND p.status = 'published'
         AND EXISTS (SELECT 1 FROM worker_post_media m
                     WHERE m.post_id = p.id AND m.moderation_status = 'approved')
         AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $4`,
      params,
    );

    let mediaRows: { id: string; post_id: string; s3_key: string; s3_version_id: string | null; sort_order: number; moderation_status: string }[] = [];
    if (postsRes.rows.length > 0) {
      const mediaRes = await client.query(
        `SELECT id, post_id, s3_key, s3_version_id, sort_order, moderation_status
         FROM worker_post_media
         WHERE post_id = ANY($1) AND moderation_status = 'approved'
         ORDER BY sort_order ASC`,
        [postsRes.rows.map((p: { id: string }) => p.id)],
      );
      mediaRows = mediaRes.rows;
    }
    await client.query('COMMIT');

    const mediaByPost = new Map<string, typeof mediaRows>();
    for (const m of mediaRows) {
      const list = mediaByPost.get(m.post_id) ?? [];
      list.push(m);
      mediaByPost.set(m.post_id, list);
    }
    const posts = await Promise.all(
      postsRes.rows.map(async (post: { id: string; caption: string | null; source: string; created_at: string }) => ({
        ...post,
        media: await Promise.all(
          (mediaByPost.get(post.id) ?? []).map(async (m) => ({
            id: m.id,
            sort_order: m.sort_order,
            moderation_status: m.moderation_status,
            url: await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: process.env.MEDIA_BUCKET!,
                Key: m.s3_key,
                ...(m.s3_version_id ? { VersionId: m.s3_version_id } : {}),
              }),
              { expiresIn: 900 },
            ),
          })),
        ),
      })),
    );

    // next_before/next_before_id come straight from this (already SQL-filtered)
    // result set — nothing is dropped after the fact, so no cursor skew.
    const lastPost = postsRes.rows[postsRes.rows.length - 1];
    const hasMore = postsRes.rows.length === limit;
    const nextBefore = hasMore ? lastPost.created_at : null;
    const nextBeforeId = hasMore ? lastPost.id : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ posts, next_before: nextBefore, next_before_id: nextBeforeId }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('employer-worker-posts error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
