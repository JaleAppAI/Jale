import { getPublicJobsList, type PublicJobListItem } from '@/lib/api/publicJob';
import { escapeXml, toRfc822 } from '@/lib/seo/rss';
import { getSiteBaseUrl } from '@/lib/seo/siteUrl';

// Top-level (not under [locale]), matching sitemap.ts/robots.ts, so this
// serves at /feed.xml unauthenticated and locale-middleware-free.
export const dynamic = 'force-dynamic';

function buildItemDescription(job: PublicJobListItem): string {
  const locationPart = [job.city, job.state_region].filter(Boolean).join(', ');
  return [job.trade_category, locationPart].filter(Boolean).join(' — ');
}

function buildItem(job: PublicJobListItem, base: string): string {
  const link = `${base}/en/j/${encodeURIComponent(job.code)}`;
  return [
    '    <item>',
    `      <title>${escapeXml(job.title)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(job.code)}</guid>`,
    `      <pubDate>${toRfc822(job.created_at)}</pubDate>`,
    `      <description>${escapeXml(buildItemDescription(job))}</description>`,
    '    </item>',
  ].join('\n');
}

/**
 * GET /feed.xml -- RSS 2.0 of active public job postings.
 *
 * Never 500s: `getPublicJobsList` already tolerates fetch failure by
 * returning whatever it accumulated (possibly empty), and the try/catch
 * below is defense-in-depth in case of an unexpected parse error while
 * building items -- an empty channel is always a valid response.
 *
 * All interpolated text is untrusted employer input (job title, trade
 * category, city/state) and MUST be XML-escaped via `escapeXml` -- never
 * concatenate it into the XML string raw.
 */
export async function GET(): Promise<Response> {
  const base = getSiteBaseUrl();
  let itemsXml = '';

  try {
    const jobs = await getPublicJobsList();
    itemsXml = jobs.map((job) => buildItem(job, base)).join('\n');
  } catch {
    itemsXml = '';
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    '    <title>Jale — Jobs</title>',
    `    <link>${escapeXml(base)}</link>`,
    '    <description>Active job postings on Jale</description>',
    itemsXml,
    '  </channel>',
    '</rss>',
  ]
    .filter(Boolean)
    .join('\n');

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  });
}
