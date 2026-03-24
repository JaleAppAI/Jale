import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({});

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'http://localhost:3000',
};

const BUCKET_NAME = process.env.LEGAL_BUCKET_NAME!;
const REQUIRED_TOS_VERSION = process.env.REQUIRED_TOS_VERSION!;
const PRESIGN_EXPIRY_SECONDS = 3600; // 1 hour

export const handler = async (): Promise<any> => {
  try {
    const tosUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'tos.md',
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );

    const privacyUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'privacy-policy.md',
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        version: REQUIRED_TOS_VERSION,
        tosUrl,
        privacyUrl,
      }),
    };
  } catch (err) {
    console.error('get-tos handler error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error', message: 'Failed to generate document URLs' }),
    };
  }
};
