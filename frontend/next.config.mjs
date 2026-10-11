import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

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
  // `experimental.optimizePackageImports` used to list '@hugeicons/react'. That
  // package (and '@hugeicons/core-free-icons', and 'tw-animate-css') is no
  // longer imported anywhere in src/, so the entry optimized nothing and the
  // dependencies were dropped. The icon set in use is `lucide-react`, which
  // Next.js already optimizes by default.
};

export default withNextIntl(nextConfig);
