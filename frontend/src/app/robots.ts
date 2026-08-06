import type { MetadataRoute } from 'next';
import { getSiteBaseUrl } from '@/lib/seo/siteUrl';

// Paths that must never be crawled: authenticated worker/employer areas,
// auth flows, the token-gated document upload flow, and the legal-accept
// wall. Listed both bare and locale-prefixed since the app serves both
// forms (bare paths redirect through next-intl, but a crawler may still
// hit them directly).
const DISALLOWED_PATHS = ['/worker/', '/employer/', '/auth/', '/upload/', '/legal/accept'];

export default function robots(): MetadataRoute.Robots {
  const base = getSiteBaseUrl();
  const disallow = [
    ...DISALLOWED_PATHS,
    ...DISALLOWED_PATHS.map((p) => `/en${p}`),
    ...DISALLOWED_PATHS.map((p) => `/es${p}`),
  ];

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow,
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
