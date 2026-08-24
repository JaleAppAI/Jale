import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});

export const MAX_POST_IMAGES = 10;
export const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024;
export const POST_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface UploadItem { mime_type?: string; file_size?: number }

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: { items?: UploadItem[] };
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_items' }) };
    }
    if (items.length > MAX_POST_IMAGES) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'too_many_items', max: MAX_POST_IMAGES }) };
    }
    for (const item of items) {
      if (!item.mime_type || !POST_IMAGE_MIME_TO_EXT[item.mime_type]) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_mime_type', valid: Object.keys(POST_IMAGE_MIME_TO_EXT) }) };
      }
      if (typeof item.file_size !== 'number' || item.file_size <= 0 || item.file_size > MAX_POST_IMAGE_BYTES) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'file_too_large', max_bytes: MAX_POST_IMAGE_BYTES }) };
      }
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
    await client.query('COMMIT');

    // Draft post id: nothing is inserted until POST /worker/posts confirms.
    const postId = randomUUID();
    const uploads = await Promise.all(
      items.map(async (item) => {
        const s3Key = `${workerId}/posts/${postId}/${randomUUID()}.${POST_IMAGE_MIME_TO_EXT[item.mime_type!]}`;
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({ Bucket: process.env.MEDIA_BUCKET!, Key: s3Key, ContentType: item.mime_type }),
          { expiresIn: 900 },
        );
        return { url, s3_key: s3Key };
      }),
    );

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ post_id: postId, uploads }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-post-upload-urls error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
