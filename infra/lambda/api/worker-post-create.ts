import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { moderateImage } from '../lib/moderation';
import { MAX_POST_IMAGES, POST_IMAGE_MIME_TO_EXT } from './worker-post-upload-urls';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CAPTION_CHARS = 1000;

interface CreateItem { s3_key?: string; sort_order?: number }
interface VerifiedItem {
  s3_key: string;
  sort_order: number;
  content_type: string;
  file_size: number;
  s3_version_id: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: { post_id?: string; caption?: string | null; items?: CreateItem[] };
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const { post_id, items } = body;
    if (!post_id || !UUID_RE.test(post_id)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_post_id' }) };
    }

    // Strip control chars before trimming so a caption of only
    // whitespace/control bytes collapses to null rather than "".
    const strippedCaption = typeof body.caption === 'string'
      ? body.caption.replace(/[\x00-\x1f\x7f]/g, '').trim()
      : '';
    const caption = strippedCaption.length > 0 ? strippedCaption : null;
    if (caption !== null && caption.length > MAX_CAPTION_CHARS) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'caption_too_long', max: MAX_CAPTION_CHARS }) };
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_POST_IMAGES) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_items', max: MAX_POST_IMAGES }) };
    }
    const sortOrders = new Set(items.map((i) => i.sort_order));
    if (
      items.some((i) => (
        typeof i.sort_order !== 'number'
        || !Number.isInteger(i.sort_order)
        || i.sort_order < 0
        // sort_order is an array index into a <=MAX_POST_IMAGES-item post, and
        // the column is SMALLINT — bound it to the legitimate range (0..9) so
        // an out-of-range value (e.g. 40000) is rejected here as a 400 rather
        // than reaching the DB as a numeric-overflow error mid-transaction.
        || i.sort_order >= MAX_POST_IMAGES
      ))
      || sortOrders.size !== items.length
    ) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_sort_order' }) };
    }

    // ── Transaction 1: resolve identity + compliance (standard skeleton
    // shared with the vault handlers, e.g. worker-doc-confirm-auth.ts) ──
    const pool = await getDbPool();
    let workerId: string;
    client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRlsContext(client, cognitoSub);
      const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
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
            currentVersion: compliance.currentVersion,
          }),
        };
      }
      const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
      if (userRes.rows.length === 0) {
        await client.query('COMMIT');
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) };
      }
      workerId = userRes.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      // Best-effort rollback before release: the pool is max:1 (lib/db.ts),
      // so a released client with an open/aborted transaction is reused
      // as-is by the next warm-container invocation (RLS-context bleed,
      // aborted-transaction poisoning). Rethrow so the outer catch still
      // logs and returns 500 — this block only guarantees the connection
      // goes back to the pool clean.
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
      client = undefined;
    }

    // Every key must sit under THIS caller's prefix for THIS post — the
    // prefix check is the authorization boundary for the confirm step.
    const requiredPrefix = `${workerId}/posts/${post_id}/`;
    if (items.some((i) => typeof i.s3_key !== 'string' || !i.s3_key.startsWith(requiredPrefix) || i.s3_key.includes('..'))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_s3_key' }) };
    }

    // ── Outside any transaction: verify uploads and moderate them. These
    // are external network calls (S3, Rekognition) and must never hold a
    // DB transaction open while they run. ──
    const verified: VerifiedItem[] = [];
    for (const item of items) {
      let head;
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket: process.env.MEDIA_BUCKET!, Key: item.s3_key! }));
      } catch (err) {
        // Only a genuine "object doesn't exist" is the caller's fault
        // (400). Anything else (throttling, access denied, transient
        // network fault) is ours to fix — rethrow to the 500 path rather
        // than mislabeling it as a bad upload.
        if ((err as { name?: string }).name === 'NotFound') {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'uploaded_object_not_found', s3_key: item.s3_key }),
          };
        }
        throw err;
      }
      const contentType = head.ContentType ?? '';
      if (!POST_IMAGE_MIME_TO_EXT[contentType] || !head.ContentLength || head.ContentLength <= 0) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid_uploaded_object', s3_key: item.s3_key }),
        };
      }
      if (!head.VersionId) {
        // The media bucket must be versioned (global constraint): moderation
        // and every presigned GET pin s3_version_id so they always target the
        // exact moderated bytes, never a later overwrite at the same key. A
        // missing VersionId means that guarantee cannot be made — this is a
        // bucket misconfiguration, not a bad client request, so fail closed
        // via the 500 path rather than accepting an unpinned upload.
        throw new Error(`HeadObject returned no VersionId for ${item.s3_key} — is the media bucket versioned?`);
      }
      verified.push({
        s3_key: item.s3_key!,
        sort_order: item.sort_order!,
        content_type: contentType,
        file_size: head.ContentLength,
        s3_version_id: head.VersionId,
      });
    }

    // Moderate before insert so rows are born with a final status (spec §5).
    const statuses = await Promise.all(
      verified.map((v) => moderateImage(process.env.MEDIA_BUCKET!, v.s3_key, v.s3_version_id)),
    );
    const flaggedCount = statuses.filter((s) => s === 'flagged').length;

    // ── Transaction 2: persist the post + media rows ──
    client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRlsContext(client, cognitoSub);
      await setInternalUserRlsContext(client, workerId);

      let postRow;
      try {
        postRow = await client.query(
          `INSERT INTO worker_posts (id, worker_id, caption, source, status)
           VALUES ($1, $2, $3, 'web', 'published')
           RETURNING id, caption, source, created_at`,
          [post_id, workerId, caption],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          await client.query('ROLLBACK');
          return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'post_already_exists' }) };
        }
        throw err;
      }

      for (let i = 0; i < verified.length; i++) {
        const v = verified[i];
        await client.query(
          `INSERT INTO worker_post_media (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [post_id, workerId, v.s3_key, v.s3_version_id, v.sort_order, v.content_type, v.file_size, statuses[i]],
        );
      }
      await client.query('COMMIT');

      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ post: postRow.rows[0], flagged_count: flaggedCount }),
      };
    } catch (err) {
      // Same reasoning as Transaction 1's catch: anything that reaches here
      // (e.g. a non-23505 error from either INSERT, such as the media
      // INSERT failing on a constraint) must not leave the pool's single
      // connection (max:1, lib/db.ts) parked mid-transaction for the next
      // warm-container invocation to inherit.
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
      client = undefined;
    }
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-post-create error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
