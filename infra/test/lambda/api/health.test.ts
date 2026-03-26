import { handler } from '../../../lambda/api/health';
import { corsHeaders } from '../../../lambda/lib/http';

describe('Health API Lambda', () => {
  it('should return 200 and healthy status', async () => {
    const response = await handler();

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(corsHeaders());

    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.timestamp).toBeDefined();

    // Verify timestamp is a valid ISO string
    const date = new Date(body.timestamp);
    expect(date.toISOString()).toBe(body.timestamp);
  });
});
