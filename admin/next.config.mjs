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

// Old admin URLs land on the new pages, query kept: Next merges the request
// query into the destination's, and the destination's own keys win. Temporary
// (307) while the console settles; a 308 would be cached by browsers.
// Report ids are UUIDs, so the pattern keeps /reports/settings out of the
// /reports/:id rule; that page stays where it is.
// The old report `status` is renamed to `reportStatus` (K2.3: the Inbox's own
// `status` is a different filter). Next cannot drop a request key, so the old
// `status` is still on the landed URL; the Reports tab ignores it once
// `reportStatus` is set.
const OLD_URL_REDIRECTS = [
  { source: '/cases', destination: '/inbox?tab=support', permanent: false },
  { source: '/cases/:id', destination: '/inbox/support/:id', permanent: false },
  {
    source: '/reports',
    has: [{ type: 'query', key: 'status', value: '(?<reportStatus>.+)' }],
    destination: '/inbox?tab=reports&reportStatus=:reportStatus',
    permanent: false,
  },
  { source: '/reports', destination: '/inbox?tab=reports', permanent: false },
  { source: '/reports/:id([0-9a-f-]{36})', destination: '/inbox/reports/:id', permanent: false },
  { source: '/verifications', destination: '/inbox?tab=lockouts', permanent: false },
  { source: '/verifications/:id', destination: '/inbox/lockouts/:id', permanent: false },
  { source: '/access-history', destination: '/security', permanent: false },
  { source: '/audit', destination: '/security', permanent: false },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async redirects() {
    return OLD_URL_REDIRECTS.map((rule) => ({ ...rule }));
  },
  images: {
    unoptimized: true,
  },
  // Under Next 14/webpack, amazon-cognito-identity-js 6.3.16 read js-cookie as
  // a namespace (`import * as Cookies`, then Cookies.set/get/remove), and
  // js-cookie 3's ESM build exports only a default, so the build failed with a
  // named-export error; aliasing js-cookie to a no-op shim silenced it. Next 16
  // builds with Turbopack, which rejects a `webpack` key outright, so the alias
  // moved here. SDK 6.3.20 uses a default import instead, so that error no
  // longer exists; the alias stays for the reason below.
  //
  // As of Next 16.3.8 / js-cookie 3.0.8 / amazon-cognito-identity-js 6.3.20,
  // the app never reaches CookieStorage (the SDK's only js-cookie importer),
  // so neither js-cookie nor the shim is bundled. The alias is what keeps
  // js-cookie out: without it Turbopack bundles it, unused, into the client
  // and SSR chunks. A missing alias target is not a build error (Turbopack
  // silently falls back to the real package), so keep the shim at this path.
  // Code that does reach CookieStorage gets the no-op shim.
  turbopack: {
    resolveAlias: {
      'js-cookie': './src/lib/js-cookie-shim.mjs',
    },
  },
};

export default nextConfig;
