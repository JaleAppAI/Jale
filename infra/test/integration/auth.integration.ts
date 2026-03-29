import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { get, post } from './helpers/api-client';

interface TokenStore {
  workerA:  { username: string; idToken: string; accessToken: string; refreshToken: string };
  workerB:  { username: string; idToken: string; accessToken: string; refreshToken: string };
  employer: { username: string; idToken: string; accessToken: string; refreshToken: string };
}

function loadTokens(): TokenStore {
  return JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'jale-integration-tokens.json'), 'utf-8'),
  );
}

describe('Cross-role rejection', () => {
  let tokens: TokenStore;

  beforeAll(() => {
    tokens = loadTokens();
  });

  it('GET /worker/profile with no token returns 401', async () => {
    const res = await get('/worker/profile');
    expect(res.status).toBe(401);
  });

  it('GET /employer/profile with no token returns 401', async () => {
    const res = await get('/employer/profile');
    expect(res.status).toBe(401);
  });

  it('GET /employer/profile with Worker JWT returns 401', async () => {
    const res = await get('/employer/profile', tokens.workerA.idToken);
    expect(res.status).toBe(401);
  });

  it('GET /worker/profile with Employer JWT returns 401', async () => {
    const res = await get('/worker/profile', tokens.employer.idToken);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  let tokens: TokenStore;

  beforeAll(() => {
    tokens = loadTokens();
  });

  it('refreshes Worker A tokens successfully', async () => {
    const res = await post('/auth/refresh', {
      refreshToken: tokens.workerA.refreshToken,
      userType: 'worker',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      expiresIn: expect.any(Number),
    });
  });

  it('refreshes Employer tokens successfully', async () => {
    const res = await post('/auth/refresh', {
      refreshToken: tokens.employer.refreshToken,
      userType: 'employer',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      idToken: expect.any(String),
      accessToken: expect.any(String),
      expiresIn: expect.any(Number),
    });
  });

  it('returns 400 when refreshToken is missing', async () => {
    const res = await post('/auth/refresh', { userType: 'worker' });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('missing_params');
  });

  it('returns 400 when userType is invalid', async () => {
    const res = await post('/auth/refresh', {
      refreshToken: 'any-token',
      userType: 'admin',
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('invalid_user_type');
  });
});

describe('POST /auth/logout', () => {
  let tokens: TokenStore;

  beforeAll(() => {
    tokens = loadTokens();
  });

  it('returns 400 when params are missing', async () => {
    const res = await post('/auth/logout', { userType: 'worker' });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('missing_params');
  });

  it('logs out Worker B and returns { loggedOut: true }', async () => {
    const res = await post('/auth/logout', {
      accessToken: tokens.workerB.accessToken,
      refreshToken: tokens.workerB.refreshToken,
      userType: 'worker',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loggedOut: true });
  });

  it('Worker B refresh token is revoked after logout', async () => {
    // RevokeToken (called in logout) invalidates the refresh token immediately.
    // This is distinct from access token invalidation which is subject to API Gateway cache TTL.
    const res = await post('/auth/refresh', {
      refreshToken: tokens.workerB.refreshToken,
      userType: 'worker',
    });

    expect(res.status).toBe(401);
  });
});
