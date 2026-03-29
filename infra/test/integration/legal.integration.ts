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

describe('Legal wall and ToS acceptance', () => {
  let tokens: TokenStore;

  beforeAll(() => {
    tokens = loadTokens();
  });

  // --- Legal wall (before any ToS acceptance) ---

  it('GET /worker/profile before ToS returns 403 legal_required', async () => {
    const res = await get('/worker/profile', tokens.workerA.idToken);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'legal_required',
      requiredVersion: '1.0',
      currentVersion: null,
    });
  });

  it('GET /employer/profile before ToS returns 403 legal_required', async () => {
    const res = await get('/employer/profile', tokens.employer.idToken);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'legal_required',
      requiredVersion: '1.0',
      currentVersion: null,
    });
  });

  // --- GET /legal/tos ---

  it('GET /legal/tos returns 200 with version and two presigned S3 URLs', async () => {
    const res = await get('/legal/tos');

    expect(res.status).toBe(200);
    expect((res.body as any).version).toBe('1.0');
    expect(typeof (res.body as any).tosUrl).toBe('string');
    expect(typeof (res.body as any).privacyUrl).toBe('string');
    expect((res.body as any).tosUrl).toMatch(/^https:\/\//);
    expect((res.body as any).privacyUrl).toMatch(/^https:\/\//);
  });

  // --- POST /legal/accept error cases ---

  it('POST /legal/accept with no token returns 401', async () => {
    const res = await post('/legal/accept', { tosVersion: '1.0' });
    expect(res.status).toBe(401);
  });

  it('POST /legal/accept with wrong version returns 400 invalid_tos_version', async () => {
    const res = await post('/legal/accept', { tosVersion: 'v1.0' }, tokens.workerA.idToken);

    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('invalid_tos_version');
  });

  it('POST /legal/accept with missing body returns 400 bad_request', async () => {
    const res = await post('/legal/accept', {}, tokens.workerA.idToken);

    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('bad_request');
  });

  // --- POST /legal/accept happy path ---

  it('Worker A accepts ToS and gets { accepted: true, version: "1.0" }', async () => {
    const res = await post('/legal/accept', { tosVersion: '1.0' }, tokens.workerA.idToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, version: '1.0' });
  });

  it('Employer accepts ToS and gets { accepted: true, version: "1.0" }', async () => {
    const res = await post('/legal/accept', { tosVersion: '1.0' }, tokens.employer.idToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, version: '1.0' });
  });

  // --- Profile access after ToS acceptance ---

  it('GET /worker/profile after Worker A accepts ToS returns 200', async () => {
    const res = await get('/worker/profile', tokens.workerA.idToken);
    expect(res.status).toBe(200);
  });

  it('GET /employer/profile after Employer accepts ToS returns 200', async () => {
    const res = await get('/employer/profile', tokens.employer.idToken);
    expect(res.status).toBe(200);
  });

  // --- Per-user legal wall: Worker B has NOT accepted ToS ---

  it('GET /worker/profile for Worker B (no ToS) still returns 403', async () => {
    const res = await get('/worker/profile', tokens.workerB.idToken);

    expect(res.status).toBe(403);
    expect((res.body as any).error).toBe('legal_required');
  });
});
