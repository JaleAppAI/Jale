// Shared absolute-URL derivation for SEO surfaces (sitemap, robots, RSS feed,
// job-page canonical/JSON-LD). Mirrors the fallback used by
// `src/app/[locale]/layout.tsx`'s `metadataBase` -- keep these in sync.

const DEFAULT_SITE_URL = 'https://jaleapp.ai';

/** Absolute site origin, no trailing slash. Respects NEXT_PUBLIC_SITE_URL. */
export function getSiteBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * The canonical (`en`) and `es` URLs for a public job page. The `/en/`
 * URL is canonical for both locales by product decision -- see the public
 * job page's `generateMetadata`.
 */
export function buildJobPageUrls(code: string): { en: string; es: string } {
  const base = getSiteBaseUrl();
  const encoded = encodeURIComponent(code);
  return {
    en: `${base}/en/j/${encoded}`,
    es: `${base}/es/j/${encoded}`,
  };
}
