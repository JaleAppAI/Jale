import type { MetadataRoute } from 'next';
import { getPublicJobsList } from '@/lib/api/publicJob';
import { getSiteBaseUrl } from '@/lib/seo/siteUrl';

// Force dynamic rendering. Without this, a build where
// NEXT_PUBLIC_API_BASE_URL happens to be unset would return an empty jobs
// list *before any fetch fires* (see getPublicJobsList), giving Next no
// signal that this route is data-dependent -- it could get prerendered as
// a static two-URL file baked in permanently at image-build time. Job
// listings must always be fetched fresh per request.
export const dynamic = 'force-dynamic';

// Top-level (not under [locale]) so Next.js serves this at /sitemap.xml,
// unauthenticated and locale-middleware-free. Must never 500 --
// getPublicJobsList already tolerates fetch failure by returning whatever
// it managed to accumulate (possibly an empty array).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteBaseUrl();
  const now = new Date();

  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/en`, lastModified: now },
    { url: `${base}/es`, lastModified: now },
  ];

  const jobs = await getPublicJobsList();
  for (const job of jobs) {
    const updatedAt = new Date(job.updated_at);
    entries.push({
      url: `${base}/en/j/${encodeURIComponent(job.code)}`,
      lastModified: Number.isNaN(updatedAt.getTime()) ? now : updatedAt,
    });
  }

  return entries;
}
