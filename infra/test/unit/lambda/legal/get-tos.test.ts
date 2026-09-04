/**
 * `GET /legal/tos` — the ONE legal-document path.
 *
 * This handler used to presign S3 objects (`tos.md`, `privacy-policy.md`) in
 * `jale-legal-docs-<account>`. Nothing ever populated that bucket: it was
 * EMPTY in production, so a signup that reached `LegalWall` handed the user a
 * presigned link that rendered S3's `NoSuchKey` XML. Meanwhile the real,
 * maintained documents are the PDFs the Next.js routes `/legal/terms` and
 * `/legal/privacy` serve (`frontend/src/lib/legal-documents.ts`) — the same
 * URLs the branded emails and the WhatsApp flow already send people to.
 *
 * Two mechanisms for one thing, so the broken one is gone. The contract this
 * file pins is that the response points at the SURVIVING mechanism, and that
 * no AWS SDK is involved at all.
 */
describe('get-tos handler', () => {
  const originalEnv = process.env;

  function loadHandler() {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../../lambda/legal/get-tos').handler as () => Promise<{
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    }>;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.FRONTEND_BASE_URL;
    delete process.env.ALLOWED_ORIGIN;
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns the Next.js legal document routes, not presigned S3 URLs', async () => {
    process.env.FRONTEND_BASE_URL = 'https://jaleapp.ai';

    const response = await loadHandler()();

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      version: 'v1.0',
      tosUrl: 'https://jaleapp.ai/legal/terms',
      privacyUrl: 'https://jaleapp.ai/legal/privacy',
    });
  });

  it('honours a non-production FRONTEND_BASE_URL', async () => {
    process.env.FRONTEND_BASE_URL = 'https://dev.jaleapp.ai';

    const body = JSON.parse((await loadHandler()()).body);

    expect(body.tosUrl).toBe('https://dev.jaleapp.ai/legal/terms');
    expect(body.privacyUrl).toBe('https://dev.jaleapp.ai/legal/privacy');
  });

  it('strips a trailing slash rather than emitting a doubled path separator', async () => {
    process.env.FRONTEND_BASE_URL = 'https://jaleapp.ai/';

    const body = JSON.parse((await loadHandler()()).body);

    expect(body.tosUrl).toBe('https://jaleapp.ai/legal/terms');
  });

  it('falls back to the production origin when FRONTEND_BASE_URL is unset', async () => {
    const body = JSON.parse((await loadHandler()()).body);

    expect(body.tosUrl).toBe('https://jaleapp.ai/legal/terms');
    expect(body.privacyUrl).toBe('https://jaleapp.ai/legal/privacy');
  });

  it('falls back to the production origin when FRONTEND_BASE_URL is not an absolute http(s) URL', async () => {
    // A relative or malformed value must not produce `/legal/terms` with no
    // origin: the link is opened in a new tab and is also pasted into emails
    // and WhatsApp, where an origin-less path is dead on arrival.
    process.env.FRONTEND_BASE_URL = 'jaleapp.ai';

    const body = JSON.parse((await loadHandler()()).body);

    expect(body.tosUrl).toBe('https://jaleapp.ai/legal/terms');
  });

  it('still reports the required ToS version LegalWall compares against', async () => {
    process.env.REQUIRED_TOS_VERSION = 'v2.7';

    expect(JSON.parse((await loadHandler()()).body).version).toBe('v2.7');
  });

  it('returns CORS headers so LegalWall can read the response', async () => {
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';

    const response = await loadHandler()();

    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://jaleapp.ai');
    expect(response.headers['Content-Type']).toBe('application/json');
  });

  it('imports no AWS SDK client — the S3 dependency is gone, not merely unused', () => {
    // A leftover `@aws-sdk/client-s3` import would keep the bundle (and the
    // grantRead the legal stack no longer issues) looking necessary, which is
    // how a deleted mechanism grows back.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../../../lambda/legal/get-tos.ts'),
      'utf8',
    ) as string;

    expect(source).not.toMatch(/@aws-sdk\/client-s3/);
    expect(source).not.toMatch(/s3-request-presigner/);
    expect(source).not.toMatch(/LEGAL_BUCKET_NAME/);
  });
});
