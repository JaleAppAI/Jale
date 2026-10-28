// Response headers for `headers()` in next.config.mjs. A module of its own so
// a test can import it without the next-intl plugin or computeBuildId.

// Must equal `locales` in src/i18n/locales.ts (that file is TypeScript, which
// next.config.mjs cannot import); security-headers.test.ts checks they agree.
export const HEADER_LOCALES = ['en', 'es'];

const LOCALE = `:locale(${HEADER_LOCALES.join('|')})`;

const NO_REFERRER = [{ key: 'Referrer-Policy', value: 'no-referrer' }];

// Pages whose address carries a secret `?token=`: the employer invite and the
// digest unsubscribe link. The invite's layout also emits
// `<meta name="referrer" content="no-referrer">`, but a meta tag only applies
// once parsed; the header covers the whole response from the start. Sources
// ignore the query string, so these match with any `?token=`. The unprefixed
// path is the one the next-intl proxy redirects to `/en/...`.
const TOKEN_PAGES = ['/auth/employer/invite', '/digest-unsubscribe'];

/** @returns {Promise<import('next/dist/lib/load-custom-routes').Header[]>} */
export async function securityHeaders() {
  return TOKEN_PAGES.flatMap((page) => [
    { source: `/${LOCALE}${page}`, headers: NO_REFERRER },
    { source: page, headers: NO_REFERRER },
  ]);
}
