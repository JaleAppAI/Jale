import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
import { computeBuildId } from './scripts/build-id.mjs';
import { securityHeaders } from './security-headers.mjs';

const withNextIntl = createNextIntlPlugin();

// The build identity problem reports carry: a content hash of the sources,
// the same value `node scripts/build-id.mjs` prints for this checkout. It is
// inlined as NEXT_PUBLIC_JALE_BUILD only. Next's own build id stays at its
// default (random per build): one content hash can be built with different
// NEXT_PUBLIC_* values, and a repeated build id would reuse the long-cached
// `/_next/static/<build id>/` manifest paths.
const jaleBuild = computeBuildId(fileURLToPath(new URL('.', import.meta.url)));
console.log(`jale-build ${jaleBuild}`);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone build: produces .next/standalone/ with self-contained server bundle
  // Used by both Lambda (container image) and future EC2/ECS deployments
  output: 'standalone',
  reactStrictMode: true,
  // Disable Next.js Image Optimization (Lambda fs is read-only; CloudFront can do this later)
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_JALE_BUILD: jaleBuild,
  },
  // Response headers on chosen pages, e.g. Referrer-Policy on pages whose
  // address carries a secret token. Rules and reasons: security-headers.mjs.
  headers: securityHeaders,
  // `experimental.optimizePackageImports` used to list '@hugeicons/react'. That
  // package (and '@hugeicons/core-free-icons', and 'tw-animate-css') is no
  // longer imported anywhere in src/, so the entry optimized nothing and the
  // dependencies were dropped. The icon set in use is `lucide-react`, which
  // Next.js already optimizes by default.
};

export default withNextIntl(nextConfig);
