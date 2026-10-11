import { createHash, randomBytes } from 'node:crypto';
import { roleFromIssuer } from '../../../../lambda/reports/lib/role';
import { hashAttachToken, newAttachToken } from '../../../../lambda/reports/lib/tokens';

/** A pool id of the real shape, random per run. */
const fakePoolId = (): string => `test-region-1_${randomBytes(6).toString('hex')}`;
const issuerFor = (poolId: string): string => `https://cognito-idp.test-region-1.example.invalid/${poolId}`;

describe('roleFromIssuer', () => {
  const workerPool = fakePoolId();
  const employerPool = fakePoolId();
  const env = { WORKER_USER_POOL_ID: workerPool, EMPLOYER_USER_POOL_ID: employerPool };

  it('reads a worker sign-in from the worker pool issuer', () => {
    expect(roleFromIssuer(issuerFor(workerPool), env)).toBe('worker');
  });

  it('reads an employer sign-in from the employer pool issuer', () => {
    expect(roleFromIssuer(issuerFor(employerPool), env)).toBe('employer');
  });

  it('gives unknown for an issuer of neither pool', () => {
    expect(roleFromIssuer(issuerFor(fakePoolId()), env)).toBe('unknown');
  });

  it('gives unknown when the claim is missing or not text', () => {
    expect(roleFromIssuer(undefined, env)).toBe('unknown');
    expect(roleFromIssuer('', env)).toBe('unknown');
    expect(roleFromIssuer(42, env)).toBe('unknown');
  });

  it('compares the whole last path segment only', () => {
    expect(roleFromIssuer(`${issuerFor(workerPool)}/`, env)).toBe('unknown');
    expect(roleFromIssuer(issuerFor(`${workerPool}x`), env)).toBe('unknown');
    expect(roleFromIssuer(workerPool, env)).toBe('worker');
  });

  it('gives unknown when the pool ids are not configured, or are the same', () => {
    expect(roleFromIssuer(issuerFor(workerPool), {})).toBe('unknown');
    expect(roleFromIssuer('https://cognito-idp.example.invalid/', { WORKER_USER_POOL_ID: '', EMPLOYER_USER_POOL_ID: '' }))
      .toBe('unknown');
    expect(roleFromIssuer(issuerFor(workerPool), { WORKER_USER_POOL_ID: workerPool, EMPLOYER_USER_POOL_ID: workerPool }))
      .toBe('unknown');
  });

  it('reads the pool ids from the environment by default', () => {
    process.env.WORKER_USER_POOL_ID = workerPool;
    process.env.EMPLOYER_USER_POOL_ID = employerPool;
    try {
      expect(roleFromIssuer(issuerFor(employerPool))).toBe('employer');
    } finally {
      delete process.env.WORKER_USER_POOL_ID;
      delete process.env.EMPLOYER_USER_POOL_ID;
    }
  });
});

describe('attach tokens', () => {
  it('are 32 random bytes, base64url without padding', () => {
    const { token } = newAttachToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('differ every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newAttachToken().token));
    expect(tokens.size).toBe(50);
  });

  it('come with the SHA-256 hex of the token text, which is all the database sees', () => {
    const { token, hash } = newAttachToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashAttachToken(token)).toBe(hash);
  });
});
