const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://*.amazonaws.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  images: {
    unoptimized: true,
  },
  // amazon-cognito-identity-js imports { get, remove } from 'js-cookie' as
  // named ESM exports, which no version of js-cookie actually provides. Under
  // Next 14/webpack that was a hard build error, silenced by aliasing js-cookie
  // to a no-op shim; Next 16 builds with Turbopack, which rejects a `webpack`
  // key outright, so the alias moved here.
  //
  // Turbopack tree-shakes the only importer (CookieStorage — the admin app uses
  // AuthenticationDetails / CognitoUser / CognitoUserPool and never
  // CookieStorage) before resolving the specifier, so as of Next 16.3.4 this
  // alias is inert: a build with a deliberately missing target still succeeds.
  // It is kept as a guard so that a future code path reaching CookieStorage
  // fails over to the shim instead of re-introducing the named-export error.
  turbopack: {
    resolveAlias: {
      'js-cookie': './src/lib/js-cookie-shim.mjs',
    },
  },
};

export default nextConfig;
