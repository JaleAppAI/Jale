import { get, postExpect } from './helpers/api-client';
import { loadTokens, TokenStore } from './helpers/tokens';

describe('Profile endpoints and RLS isolation', () => {
  let tokens: TokenStore;

  beforeAll(async () => {
    tokens = loadTokens();
    await postExpect('/legal/accept', { tosVersion: '1.0' }, 200, tokens.profileWorker.idToken);
    await postExpect('/legal/accept', { tosVersion: '1.0' }, 200, tokens.profileEmployer.idToken);
  });

  it('Worker A profile returns correct shape with user_type "worker"', async () => {
    const res = await get('/worker/profile', tokens.profileWorker.idToken);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user_type: 'worker',
      phone: '+19999000003',
    });
    expect(typeof (res.body as any).id).toBe('string');
    expect(typeof (res.body as any).created_at).toBe('string');
  });

  it('Employer profile returns correct shape with user_type "employer"', async () => {
    const res = await get('/employer/profile', tokens.profileEmployer.idToken);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user_type: 'employer',
      email: 'test-integration-profile-employer@jale.test',
    });
    expect(typeof (res.body as any).id).toBe('string');
  });

  it('Worker A and Employer have different database IDs (RLS isolation)', async () => {
    const [workerRes, employerRes] = await Promise.all([
      get('/worker/profile', tokens.profileWorker.idToken),
      get('/employer/profile', tokens.profileEmployer.idToken),
    ]);

    expect(workerRes.status).toBe(200);
    expect(employerRes.status).toBe(200);
    expect((workerRes.body as any).id).not.toBe((employerRes.body as any).id);
  });
});
