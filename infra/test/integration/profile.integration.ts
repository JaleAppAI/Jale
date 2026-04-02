import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { get } from './helpers/api-client';

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

describe('Profile endpoints and RLS isolation', () => {
  let tokens: TokenStore;

  beforeAll(() => {
    tokens = loadTokens();
  });

  it('Worker A profile returns correct shape with user_type "worker"', async () => {
    const res = await get('/worker/profile', tokens.workerA.idToken);

    expect(res.status).toBe(200);
    // Workers authenticate via phone — email is null, phone holds the identifier
    expect(res.body).toMatchObject({
      user_type: 'worker',
      phone: '+19999000001',
    });
    expect(typeof (res.body as any).id).toBe('string');
    expect(typeof (res.body as any).created_at).toBe('string');
  });

  it('Employer profile returns correct shape with user_type "employer"', async () => {
    const res = await get('/employer/profile', tokens.employer.idToken);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user_type: 'employer',
      email: 'test-integration-employer@jale.test',
    });
    expect(typeof (res.body as any).id).toBe('string');
  });

  it('Worker A and Employer have different database IDs (RLS isolation)', async () => {
    const [workerRes, employerRes] = await Promise.all([
      get('/worker/profile', tokens.workerA.idToken),
      get('/employer/profile', tokens.employer.idToken),
    ]);

    expect(workerRes.status).toBe(200);
    expect(employerRes.status).toBe(200);
    expect((workerRes.body as any).id).not.toBe((employerRes.body as any).id);
  });

  it('Employer JWT cannot access worker profile (401 from authorizer)', async () => {
    const res = await get('/worker/profile', tokens.employer.idToken);
    expect(res.status).toBe(401);
  });

  it('Worker JWT cannot access employer profile (401 from authorizer)', async () => {
    const res = await get('/employer/profile', tokens.workerA.idToken);
    expect(res.status).toBe(401);
  });
});
