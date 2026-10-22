import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from '../lib/http';

/**
 * GET/POST /employer/tutorials and /worker/tutorials -- tutorial progress
 * (contract K1.2 and K1.3).
 *
 * PLACEHOLDER. Not wired to any route yet. GET answers the "nothing recorded"
 * shape and POST answers 501 `not_implemented`; the tutorial progress backend
 * lane replaces this body with the stored records.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = (event.httpMethod ?? '').toUpperCase();
  if (method === 'GET') {
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ tutorials: [] }) };
  }
  if (method === 'POST') {
    return { statusCode: 501, headers: corsHeaders(), body: JSON.stringify({ error: 'not_implemented' }) };
  }
  return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'method_not_allowed' }) };
};
