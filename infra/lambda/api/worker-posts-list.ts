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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
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
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }
    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (userRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) };
    }
    const workerId: string = userRes.rows[0].id;
    await setInternalUserRlsContext(client, workerId);

    const params: unknown[] = [workerId, before, beforeId];
    params.push(limit);
    const postsRes = await client.query(
      `SELECT id, caption, source, created_at
       FROM worker_posts
       WHERE worker_id = $1 AND status = 'published'
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );

    let mediaRows: { id: string; post_id: string; s3_key: string; s3_version_id: string | null; sort_order: number; moderation_status: string }[] = [];
    if (postsRes.rows.length > 0) {
      const mediaRes = await client.query(
        `SELECT id, post_id, s3_key, s3_version_id, sort_order, moderation_status
         FROM worker_post_media
         WHERE post_id = ANY($1)
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
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-posts-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
