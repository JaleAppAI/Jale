import { S3Client } from '@aws-sdk/client-s3';
import {
  detectMediaCategory,
  buildS3Key,
  ALLOWED_PHOTO_TYPES,
  ALLOWED_VOICE_TYPES,
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  sniffDocumentType,
  uploadDocumentToS3,
  downloadTwilioMediaBounded,
  MediaTooLargeError,
} from '../../../../../lambda/whatsapp/lib/media';

// Manual mock (aws-sdk-client-mock is not a dependency) — mirrors the shape
// used in test/unit/lambda/api/worker-doc-confirm.test.ts. media.ts
// constructs a single module-scoped S3Client, so the mocked `send` for that
// one instance is captured via S3Client's first (and only) mock result.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const sendMock = (S3Client as unknown as jest.Mock).mock.results[0].value.send as jest.Mock;

describe('detectMediaCategory', () => {
  test.each([
    ['image/jpeg', 'photo'],
    ['image/png', 'photo'],
    ['image/webp', 'photo'],
  ])('%s → photo', (ct, expected) => {
    expect(detectMediaCategory(ct)).toBe(expected);
  });

  test.each([
    ['audio/ogg', 'voice'],
    ['audio/mpeg', 'voice'],
    ['audio/mp4', 'voice'],
  ])('%s → voice', (ct, expected) => {
    expect(detectMediaCategory(ct)).toBe(expected);
  });

  test.each([
    ['application/pdf'],
    ['video/mp4'],
    ['text/plain'],
    [''],
  ])('%s → null', (ct) => {
    expect(detectMediaCategory(ct)).toBeNull();
  });
});

describe('buildS3Key', () => {
  test('photo key uses profile-photos prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'photo');
    expect(key).toBe('user-1/profile-photos/media-1');
  });

  test('work_sample key uses work-samples prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'work_sample');
    expect(key).toBe('user-1/work-samples/media-1');
  });

  test('voice key uses voice-messages prefix', () => {
    const key = buildS3Key('user-1', 'media-1', 'voice');
    expect(key).toBe('user-1/voice-messages/media-1');
  });
});

describe('ALLOWED_PHOTO_TYPES and ALLOWED_VOICE_TYPES', () => {
  test('ALLOWED_PHOTO_TYPES contains image types', () => {
    expect(ALLOWED_PHOTO_TYPES).toContain('image/jpeg');
    expect(ALLOWED_PHOTO_TYPES).toContain('image/png');
    expect(ALLOWED_PHOTO_TYPES).toContain('image/webp');
  });

  test('ALLOWED_VOICE_TYPES contains audio types', () => {
    expect(ALLOWED_VOICE_TYPES).toContain('audio/ogg');
    expect(ALLOWED_VOICE_TYPES).toContain('audio/mpeg');
    expect(ALLOWED_VOICE_TYPES).toContain('audio/mp4');
  });
});

describe('ALLOWED_DOCUMENT_TYPES and MAX_DOCUMENT_BYTES', () => {
  test('ALLOWED_DOCUMENT_TYPES contains pdf/jpeg/png', () => {
    expect(ALLOWED_DOCUMENT_TYPES).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
  });

  test('MAX_DOCUMENT_BYTES is exactly 10MB (web-policy parity, worker-doc-upload-url.ts)', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('sniffDocumentType', () => {
  it.each([
    [Buffer.from('%PDF-1.7 rest'), 'application/pdf'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from('GIF89a'), null],
    [Buffer.from('<html>'), null],
  ])('sniffDocumentType %#', (buf, expected) => {
    expect(sniffDocumentType(buf as Buffer)).toBe(expected);
  });

  test('rejects a too-short buffer that happens to share a prefix byte', () => {
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffDocumentType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffDocumentType(Buffer.alloc(0))).toBeNull();
  });
});

describe('uploadDocumentToS3', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('sends NO ServerSideEncryption header and returns versionId from the PutObject response', async () => {
    sendMock.mockResolvedValueOnce({ VersionId: 'v123' });

    const res = await uploadDocumentToS3('bkt', 'k', Buffer.from('%PDF-'), 'application/pdf');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ServerSideEncryption).toBeUndefined();
    expect(input.Bucket).toBe('bkt');
    expect(input.Key).toBe('k');
    expect(input.ContentType).toBe('application/pdf');
    expect(res.versionId).toBe('v123');
  });

  it('returns versionId: null when the S3 response has no VersionId (unversioned bucket)', async () => {
    sendMock.mockResolvedValueOnce({});

    const res = await uploadDocumentToS3('bkt', 'k', Buffer.from('%PDF-'), 'application/pdf');

    expect(res.versionId).toBeNull();
  });
});

describe('downloadTwilioMediaBounded', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    (global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
  });

  it('rejects on Content-Length header before reading the body', async () => {
    const arrayBufferSpy = jest.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(11 * 1024 * 1024) : null) },
      arrayBuffer: arrayBufferSpy,
    });

    await expect(downloadTwilioMediaBounded('url', 'sid', 'tok', MAX_DOCUMENT_BYTES))
      .rejects.toBeInstanceOf(MediaTooLargeError);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('rejects when the buffered body exceeds maxBytes despite a small/missing Content-Length header', async () => {
    const oversized = new ArrayBuffer(11 * 1024 * 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: jest.fn().mockResolvedValueOnce(oversized),
    });

    await expect(downloadTwilioMediaBounded('url', 'sid', 'tok', MAX_DOCUMENT_BYTES))
      .rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it('resolves with the buffered body when within bounds', async () => {
    const small = new TextEncoder().encode('%PDF-1.7').buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => '8' },
      arrayBuffer: jest.fn().mockResolvedValueOnce(small),
    });

    const buf = await downloadTwilioMediaBounded('url', 'sid', 'tok', MAX_DOCUMENT_BYTES);
    expect(buf.toString()).toBe('%PDF-1.7');
  });

  it('propagates a non-ok response as an error without buffering', async () => {
    const arrayBufferSpy = jest.fn();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: arrayBufferSpy,
    });

    await expect(downloadTwilioMediaBounded('url', 'sid', 'tok', MAX_DOCUMENT_BYTES)).rejects.toThrow();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });
});
