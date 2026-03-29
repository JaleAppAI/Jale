import { get } from './helpers/api-client';

describe('GET /health', () => {
  it('returns 200 with healthy status and ISO timestamp', async () => {
    const res = await get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy' });
    expect(typeof (res.body as any).timestamp).toBe('string');
    expect(new Date((res.body as any).timestamp).toISOString()).toBe((res.body as any).timestamp);
  });

  it('includes CORS header in response', async () => {
    const res = await get('/health');

    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });
});
