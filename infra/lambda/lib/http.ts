import type { APIGatewayProxyEvent } from 'aws-lambda';

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
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  };
}

/** Valid user types for request validation. */
export const VALID_USER_TYPES = ['worker', 'employer'] as const;
export type UserType = (typeof VALID_USER_TYPES)[number];

/** Safely extract error message from unknown error values. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Case-insensitive header lookup on an APIGatewayProxyEvent. API Gateway does
 * not guarantee header key casing (e.g. `User-Agent` vs `user-agent`), so a
 * plain `event.headers['User-Agent']` lookup is unreliable. Shared by the
 * public-jobs endpoints (public-job-open.ts, public-job-apply-intent.ts) --
 * was previously duplicated verbatim in both.
 */
export function getHeader(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? undefined;
  }
  return undefined;
}

/**
 * Validates and normalizes an absolute http(s) base URL read from an env var.
 * Returns null when the value is unset, blank, or not a parseable absolute
 * http(s) URL. Callers must treat null as a hard configuration error and fail
 * the request rather than fall back to a relative path — a link with no
 * origin is dead the moment it's pasted somewhere else (e.g. WhatsApp).
 */
export function requireAbsoluteBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return raw.replace(/\/+$/, '');
}
