import { notFound } from 'next/navigation';

/**
 * Catch-all for URLs under a locale that match no real route.
 *
 * Next.js resolves static and more specific dynamic segments first, so this
 * only ever runs for paths nothing else claimed -- a stale link, a typo, a
 * probe. Without it those render Next's unbranded default 404; with it they
 * fall into `[locale]/not-found.tsx` like any other missing resource.
 *
 * `force-dynamic` because there is no finite set of wrong URLs to prerender.
 *
 * The non-localized compliance routes (/terms, /privacypolicy, /sms-opt-in,
 * /legal/*, /feed.xml, sitemap, robots) live OUTSIDE `[locale]` and are
 * therefore unreachable from here.
 */
export const dynamic = 'force-dynamic';

export default function CatchAll(): never {
    notFound();
}
