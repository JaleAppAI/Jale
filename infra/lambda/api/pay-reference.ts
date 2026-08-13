import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isValidTradeCategory, isValidCityKey, lookupPayReference } from '../lib/pay-reference';

const CORS_HEADERS = corsHeaders();

/**
 * GET /pay-reference?trade=<trade_category>&city_key=<slug>
 *
 * Recommended-pay lookup (Feature B / T-B2) against migration 070's
 * wage_references / city_cbsa_crosswalk tables (T-B1). Dual-authenticated --
 * both workers and employers call this endpoint (ApiStack's dualAuthorizer,
 * same authorizer legal/accept-tos.ts uses via LegalStack).
 *
 * No checkCompliance() call, mirroring legal/accept-tos.ts (the only other
 * dual-auth handler in this codebase at the time this was written): this
 * endpoint surfaces only public BLS government statistics, no PII and no
 * per-user data, so gating it on ToS acceptance status isn't warranted
 * either. RLS context is still set for standard transaction hygiene, even
 * though wage_references / city_cbsa_crosswalk grant jale_admin a flat
 * read-all policy (USING (true)) regardless of app.current_user_id.
 *
 * Error bodies never echo the raw trade/city_key query params back -- fixed
 * error codes only (invalid_trade / invalid_city_key / no_reference /
 * unauthorized / internal_error).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const trade = event.queryStringParameters?.trade;
    if (!isValidTradeCategory(trade)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_trade' }) };
    }

    const cityKey = event.queryStringParameters?.city_key;
    if (!isValidCityKey(cityKey)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_city_key' }) };
    }

    // 'other' is a valid trade_category but carries no wage benchmark by
    // design (see migration 070's header / wage-seed-lib.ts
    // TRADED_CATEGORIES_WITH_WAGES) -- short-circuit before touching the DB.
    if (trade === 'other') {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'no_reference' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const reference = await lookupPayReference(client, trade, cityKey);

    await client.query('COMMIT');

    if (!reference) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'no_reference' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(reference) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('pay-reference error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
