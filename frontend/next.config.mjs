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
  experimental: {
    optimizePackageImports: ['@hugeicons/react'],
  },
};

export default withNextIntl(nextConfig);
