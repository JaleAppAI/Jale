import { getPublicJobsList, type PublicJobListItem } from '@/lib/api/publicJob';
import { escapeXml, toRfc822 } from '@/lib/seo/rss';
import { getSiteBaseUrl } from '@/lib/seo/siteUrl';

// Top-level (not under [locale]), matching sitemap.ts/robots.ts, so this
// serves at /feed.xml unauthenticated and locale-middleware-free.
export const dynamic = 'force-dynamic';

/**
 * Most recent jobs to include in the feed. This is a property of THIS
 * route only -- `getPublicJobsList`'s default (unlimited) behavior is
 * shared with `sitemap.ts`, which must keep listing every active job, so
 * the cap is applied here via the `maxItems` option rather than by
 * changing that shared default.
 */
const MAX_FEED_ITEMS = 50;

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
 * GET /feed.xml -- RSS 2.0 of the most recent active public job postings.
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
  const feedUrl = `${base}/feed.xml`;
  let jobs: PublicJobListItem[] = [];

  try {
    // Capped to the MAX_FEED_ITEMS most recent jobs -- the backend list is
    // already ordered `created_at DESC`, so `maxItems` keeps exactly the
    // newest ones. `getPublicJobsList()` (no options), used by sitemap.ts,
    // is untouched by this.
    jobs = await getPublicJobsList(undefined, { maxItems: MAX_FEED_ITEMS });
  } catch {
    jobs = [];
  }

  const itemsXml = jobs.map((job) => buildItem(job, base)).join('\n');

  // RFC-822 <lastBuildDate>, derived from the newest item's pubDate (jobs[0]
  // -- the list is created_at DESC) rather than Date.now(), so the feed's
  // build time reflects its actual newest content. Falls back to the
  // current time only when there are no items to derive it from.
  const lastBuildDate = jobs.length > 0 ? toRfc822(jobs[0].created_at) : toRfc822(new Date().toISOString());

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Jale — Jobs</title>',
    `    <link>${escapeXml(base)}</link>`,
    '    <description>Active job postings on Jale</description>',
    // The feed intentionally links only /en/ URLs (see buildItem), so it
    // declares itself English regardless of the reader's own locale.
    '    <language>en-us</language>',
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
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
