/**
 * Shared CORS headers for Lambda responses.
 *
 * API Gateway handles OPTIONS preflight via defaultCorsPreflightOptions.
 * But in Lambda proxy integrations, the Lambda MUST also return
 * Access-Control-Allow-Origin in the actual response headers (200, 400, 500).
 * Both layers are required — API Gateway for preflight, Lambda for responses.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
  };
}
