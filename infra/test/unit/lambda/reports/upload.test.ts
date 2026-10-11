import { randomBytes, randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  MAX_DELETE_KEYS,
  UPLOAD_EXPIRES_SECONDS,
  deleteKeys,
  deleteObjectQuietly,
  finalImageKey,
  magicMatches,
  pinUpload,
  presignUpload,
} from '../../../../lambda/reports/lib/upload';

const BUCKET = 'test-report-images';
const KMS_KEY = 'test-report-images-key';

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];
const SVG = Array.from(Buffer.from('<svg xmlns="http'));

/** A real client with throwaway credentials: a presigned POST is signed locally, with no request. */
function signingClient(): S3Client {
  return new S3Client({
    region: 'us-east-2',
    credentials: { accessKeyId: `TEST${randomBytes(8).toString('hex').toUpperCase()}`, secretAccessKey: randomBytes(20).toString('hex') },
  });
}

function decodePolicy(policy: string): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(policy, 'base64').toString('utf8'));
}

describe('presignUpload', () => {
  const key = `incoming/${randomUUID()}`;

  it('signs a POST for the exact key with the expected conditions, expiring in 10 minutes', async () => {
    const before = Date.now();
    const grant = await presignUpload(signingClient(), { bucket: BUCKET, key, contentType: 'image/png', kmsKeyId: KMS_KEY });
    const after = Date.now();

    expect(grant.url).toContain(BUCKET);
    expect(grant.fields).toMatchObject({
      key,
      'Content-Type': 'image/png',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': KMS_KEY,
    });

    const policy = decodePolicy(grant.fields.Policy);
    expect(policy.conditions).toEqual(expect.arrayContaining([
      ['content-length-range', 1, 5242880],
      { key },
      { bucket: BUCKET },
      { 'Content-Type': 'image/png' },
      { 'x-amz-server-side-encryption': 'aws:kms' },
      { 'x-amz-server-side-encryption-aws-kms-key-id': KMS_KEY },
    ]));
    // An exact key, never a prefix the uploader could choose under.
    expect(JSON.stringify(policy.conditions)).not.toContain('starts-with');

    expect(UPLOAD_EXPIRES_SECONDS).toBe(600);
    const expiration = Date.parse(policy.expiration);
    expect(expiration).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 600_000 - 1000);
    expect(expiration).toBeLessThanOrEqual(after + 600_000);
    const expiresAt = Date.parse(grant.expires_at);
    expect(Math.abs(expiresAt - expiration)).toBeLessThan(2000);
    expect(expiresAt).toBeLessThanOrEqual(expiration + 1000);
  });

  it('signs the declared type, whichever it is', async () => {
    for (const contentType of ['image/jpeg', 'image/webp'] as const) {
      const grant = await presignUpload(signingClient(), { bucket: BUCKET, key, contentType, kmsKeyId: KMS_KEY });
      expect(decodePolicy(grant.fields.Policy).conditions).toContainEqual({ 'Content-Type': contentType });
    }
  });
});

describe('magicMatches', () => {
  it.each<[string, number[], string, boolean]>([
    ['a JPEG as JPEG', JPEG, 'image/jpeg', true],
    ['a PNG as PNG', PNG, 'image/png', true],
    ['a WebP as WebP', WEBP, 'image/webp', true],
    ['a JPEG declared as PNG', JPEG, 'image/png', false],
    ['a PNG declared as JPEG', PNG, 'image/jpeg', false],
    ['a WebP declared as JPEG', WEBP, 'image/jpeg', false],
    ['an SVG as PNG', SVG, 'image/png', false],
    ['an SVG as JPEG', SVG, 'image/jpeg', false],
    ['an SVG as WebP', SVG, 'image/webp', false],
    ['empty bytes', [], 'image/jpeg', false],
    ['a RIFF that is not WebP', [...WEBP.slice(0, 8), 0x41, 0x56, 0x49, 0x20], 'image/webp', false],
    ['a truncated PNG header', PNG.slice(0, 7), 'image/png', false],
    ['an undeclared type', JPEG, 'image/gif', false],
  ])('%s: %s', (_label, bytes, contentType, expected) => {
    expect(magicMatches(Uint8Array.from(bytes), contentType)).toBe(expected);
  });
});

describe('finalImageKey', () => {
  it('is images/<report>/<upload uuid>.<ext>, the uuid taken from the pending key', () => {
    const reportId = randomUUID();
    const upload = randomUUID();
    expect(finalImageKey(reportId, `incoming/${upload}`, 'image/jpeg')).toBe(`images/${reportId}/${upload}.jpg`);
    expect(finalImageKey(reportId, `incoming/${upload}`, 'image/png')).toBe(`images/${reportId}/${upload}.png`);
    expect(finalImageKey(reportId, `incoming/${upload}`, 'image/webp')).toBe(`images/${reportId}/${upload}.webp`);
  });

  it('throws on a pending key or a type the database would never issue', () => {
    const reportId = randomUUID();
    expect(() => finalImageKey(reportId, `images/${randomUUID()}`, 'image/png')).toThrow();
    expect(() => finalImageKey(reportId, 'incoming/../../etc', 'image/png')).toThrow();
    expect(() => finalImageKey(reportId, `incoming/${randomUUID()}`, 'image/gif')).toThrow();
  });
});

/** A stand-in S3 client: answers each command by its class, records every call. */
function fakeS3(answers: {
  head?: object | Error;
  range?: number[] | Error;
  copy?: object | Error;
  del?: object | Error;
}) {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const send = jest.fn(async (command: { input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    calls.push({ command: name, input: command.input });
    const answer = command instanceof HeadObjectCommand ? answers.head
      : command instanceof GetObjectCommand ? answers.range
        : command instanceof CopyObjectCommand ? answers.copy
          : command instanceof DeleteObjectCommand ? answers.del ?? {}
            : undefined;
    if (answer instanceof Error) throw answer;
    if (command instanceof GetObjectCommand) {
      return { Body: { transformToByteArray: async () => Uint8Array.from(answer as number[]) } };
    }
    return answer;
  });
  return { client: { send } as unknown as S3Client, calls };
}

function s3Error(name: string, status: number): Error {
  const err = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

describe('pinUpload', () => {
  const reportId = randomUUID();
  const upload = randomUUID();
  const pendingKey = `incoming/${upload}`;
  const finalKey = `images/${reportId}/${upload}.png`;
  const etag = `"${randomBytes(16).toString('hex')}"`;
  const goodHead = { ContentLength: 2048, ContentType: 'image/png', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS_KEY, ETag: etag };
  const pin = (client: S3Client) => pinUpload(client, {
    bucket: BUCKET, reportId, pendingKey, contentType: 'image/png', kmsKeyId: KMS_KEY,
  });

  it('checks, copies under the checked ETag, then removes the upload', async () => {
    const { client, calls } = fakeS3({ head: goodHead, range: PNG, copy: {} });
    await expect(pin(client)).resolves.toEqual({ ok: true, finalKey, byteSize: 2048 });
    expect(calls.map((c) => c.command)).toEqual(['HeadObjectCommand', 'GetObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand']);
    expect(calls[0].input).toEqual({ Bucket: BUCKET, Key: pendingKey });
    expect(calls[1].input).toEqual({ Bucket: BUCKET, Key: pendingKey, Range: 'bytes=0-15', IfMatch: etag });
    expect(calls[2].input).toEqual({
      Bucket: BUCKET,
      Key: finalKey,
      CopySource: `${BUCKET}/${pendingKey}`,
      CopySourceIfMatch: etag,
      MetadataDirective: 'REPLACE',
      ContentType: 'image/png',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY,
      BucketKeyEnabled: true,
    });
    expect(calls[3].input).toEqual({ Bucket: BUCKET, Key: pendingKey });
  });

  it.each<[string, object, number[], string]>([
    ['an empty object', { ...goodHead, ContentLength: 0 }, PNG, 'size'],
    ['an object over 5 MB', { ...goodHead, ContentLength: 5242881 }, PNG, 'size'],
    ['an object without SSE-KMS', { ...goodHead, ServerSideEncryption: 'AES256' }, PNG, 'encryption'],
    ['an object under another key', { ...goodHead, SSEKMSKeyId: 'another-key' }, PNG, 'encryption'],
    ['an object of another stored type', { ...goodHead, ContentType: 'image/jpeg' }, PNG, 'content_type'],
    ['a JPEG declared as PNG', goodHead, JPEG, 'magic'],
    ['an SVG declared as PNG', goodHead, SVG, 'magic'],
    ['empty bytes', goodHead, [], 'magic'],
  ])('rejects %s and deletes the upload, copying nothing', async (_label, head, bytes, reason) => {
    const { client, calls } = fakeS3({ head, range: bytes });
    await expect(pin(client)).resolves.toEqual({ ok: false, reason });
    expect(calls.map((c) => c.command)).not.toContain('CopyObjectCommand');
    expect(calls[calls.length - 1]).toEqual({ command: 'DeleteObjectCommand', input: { Bucket: BUCKET, Key: pendingKey } });
  });

  it.each([['NotFound', 404], ['Forbidden', 403]])(
    'answers missing when the upload is not there (%s: no listing right, so absent can read as 403)',
    async (name, status) => {
      const { client, calls } = fakeS3({ head: s3Error(name, status) });
      await expect(pin(client)).resolves.toEqual({ ok: false, reason: 'missing' });
      expect(calls.map((c) => c.command)).toEqual(['HeadObjectCommand']);
    },
  );

  it('answers changed and deletes the upload when it is replaced between the check and the copy', async () => {
    const { client, calls } = fakeS3({ head: goodHead, range: PNG, copy: s3Error('PreconditionFailed', 412) });
    await expect(pin(client)).resolves.toEqual({ ok: false, reason: 'changed' });
    expect(calls.map((c) => c.command)).toEqual(['HeadObjectCommand', 'GetObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand']);
  });

  it('answers changed when it is replaced between the head and the byte read', async () => {
    const { client, calls } = fakeS3({ head: goodHead, range: s3Error('PreconditionFailed', 412) });
    await expect(pin(client)).resolves.toEqual({ ok: false, reason: 'changed' });
    expect(calls[calls.length - 1].command).toBe('DeleteObjectCommand');
  });

  it('throws on any other storage failure, so the request answers 500', async () => {
    await expect(pin(fakeS3({ head: s3Error('InternalError', 500) }).client)).rejects.toThrow('InternalError');
    await expect(pin(fakeS3({ head: goodHead, range: PNG, copy: s3Error('KMS.DisabledException', 400) }).client))
      .rejects.toThrow();
  });

  it('still succeeds when removing the upload after the copy fails: the lifecycle rule is the backstop', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { client } = fakeS3({ head: goodHead, range: PNG, copy: {}, del: s3Error('InternalError', 500) });
      await expect(pin(client)).resolves.toEqual({ ok: true, finalKey, byteSize: 2048 });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(upload);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('deleteObjectQuietly', () => {
  it('deletes one key and reports success', async () => {
    const { client, calls } = fakeS3({});
    await expect(deleteObjectQuietly(client, BUCKET, 'images/x')).resolves.toBe(true);
    expect(calls).toEqual([{ command: 'DeleteObjectCommand', input: { Bucket: BUCKET, Key: 'images/x' } }]);
  });

  it('logs a failure without the key and reports it', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const key = `images/${randomUUID()}/${randomUUID()}.png`;
      const { client } = fakeS3({ del: s3Error('InternalError', 500) });
      await expect(deleteObjectQuietly(client, BUCKET, key)).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(key);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('deleteKeys', () => {
  function batchClient(answer: (keys: string[]) => object | Error) {
    const batches: string[][] = [];
    const send = jest.fn(async (command: { input: { Bucket: string; Delete: { Objects: Array<{ Key: string }>; Quiet: boolean } } }) => {
      expect(command).toBeInstanceOf(DeleteObjectsCommand);
      expect(command.input.Bucket).toBe(BUCKET);
      expect(command.input.Delete.Quiet).toBe(true);
      const keys = command.input.Delete.Objects.map((o) => o.Key);
      batches.push(keys);
      const result = answer(keys);
      if (result instanceof Error) throw result;
      return result;
    });
    return { client: { send } as unknown as S3Client, batches };
  }

  it('deletes in chunks of at most 1000 and counts what it deleted', async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `images/${i}`);
    const { client, batches } = batchClient(() => ({}));
    expect(MAX_DELETE_KEYS).toBe(1000);
    await expect(deleteKeys(client, BUCKET, keys)).resolves.toBe(2500);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat()).toEqual(keys);
  });

  it('makes no call for no keys', async () => {
    const { client, batches } = batchClient(() => ({}));
    await expect(deleteKeys(client, BUCKET, [])).resolves.toBe(0);
    expect(batches).toHaveLength(0);
  });

  it('throws when S3 reports a key it could not delete, naming no key', async () => {
    const key = `images/${randomUUID()}/${randomUUID()}.jpg`;
    const { client } = batchClient(() => ({ Errors: [{ Key: key, Code: 'AccessDenied' }] }));
    const failure = await deleteKeys(client, BUCKET, [key]).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(key);
  });

  it('throws when a batch call fails', async () => {
    const { client } = batchClient(() => s3Error('SlowDown', 503));
    await expect(deleteKeys(client, BUCKET, ['images/a'])).rejects.toThrow('SlowDown');
  });
});
