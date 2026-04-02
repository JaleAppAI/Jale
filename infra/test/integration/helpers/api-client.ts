// infra/test/integration/helpers/api-client.ts

const BASE_URL = process.env.API_URL;

export interface ApiResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * GET request to the API. Pass idToken for authenticated requests.
 * Never throws on non-2xx — always returns status + body so tests can assert errors.
 */
export async function get(path: string, idToken?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (idToken) headers['Authorization'] = idToken;

  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const body = await parseBody(res);
  return { status: res.status, body, headers: extractHeaders(res) };
}

/**
 * POST request to the API. Pass idToken for authenticated requests.
 * Never throws on non-2xx.
 */
export async function post(path: string, data: unknown, idToken?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = idToken;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await parseBody(res);
  return { status: res.status, body, headers: extractHeaders(res) };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => { out[key] = value; });
  return out;
}
