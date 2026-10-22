import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/tutorial-progress';
import { corsHeaders } from '../../../../lambda/lib/http';

// The placeholder tutorial progress handler: the read answers the
// "nothing recorded" shape, the record answers 501, and every response carries
// the shared CORS headers.

function makeEvent(httpMethod: string, body: string | null = null): APIGatewayProxyEvent {
  return {
    httpMethod,
    path: '/employer/tutorials',
    resource: '/employer/tutorials',
    body,
    requestContext: { authorizer: { claims: { sub: 'test-sub' } } },
  } as unknown as APIGatewayProxyEvent;
}

describe('tutorial-progress placeholder', () => {
  it('answers GET with an empty tutorials list', async () => {
    const response = await handler(makeEvent('GET'));

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(corsHeaders());
    expect(JSON.parse(response.body)).toEqual({ tutorials: [] });
  });

  it('answers POST with 501 not_implemented', async () => {
    const response = await handler(makeEvent('POST', JSON.stringify({ tutorial_id: 'employer_welcome', outcome: 'completed' })));

    expect(response.statusCode).toBe(501);
    expect(response.headers).toEqual(corsHeaders());
    expect(JSON.parse(response.body)).toEqual({ error: 'not_implemented' });
  });

  it('answers any other method with 405 method_not_allowed', async () => {
    const response = await handler(makeEvent('DELETE'));

    expect(response.statusCode).toBe(405);
    expect(response.headers).toEqual(corsHeaders());
    expect(JSON.parse(response.body)).toEqual({ error: 'method_not_allowed' });
  });
});
