// Test-only (never imported by src/): renders the four analytics pages with the
// K3-shaped fixture loaders (fe4-loaders.mjs), long and empty, at 8 and 26
// weeks, into standalone HTML pages that link the CSS of the last `next build`
// and follow the OS colour scheme, for the FE-4 browser pass.
// Usage (from admin/, after `npm run build`): node scripts/fixtures/fe4-gallery.mjs <out dir>
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { adminRoot, compileAdminSources } from '../lib/check-harness.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/fixtures/fe4-gallery.mjs <out dir>');
mkdirSync(out, { recursive: true });

const staticDir = resolve(adminRoot, '.next/static');
const css = readdirSync(staticDir, { recursive: true })
  .filter((entry) => entry.endsWith('.css'))
  .map((entry) => pathToFileURL(join(staticDir, entry)).href);
if (css.length === 0) throw new Error('no built CSS under .next/static: run `npm run build` first (under flock "$LOCK")');

const PAGES = {
  growth: 'src/app/(console)/analytics/page.tsx',
  funnels: 'src/app/(console)/analytics/funnels/page.tsx',
  employers: 'src/app/(console)/analytics/employers/page.tsx',
  ops: 'src/app/(console)/analytics/ops/page.tsx',
};
const { load } = compileAdminSources({
  name: 'fe4-gallery',
  sources: Object.values(PAGES),
  fakes: {
    'next/link': 'scripts/fakes/next-link.mjs',
    'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
    'src/lib/server/admin-analytics.ts': 'scripts/fixtures/fe4-loaders.mjs',
  },
});

// The gallery file is a local page, not the app: the OS scheme picks the
// theme, the same `.dark` switch FE-1's theme script sets.
const THEME = "if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');";
const written = [];
for (const [tab, path] of Object.entries(PAGES)) {
  for (const mode of ['long', 'empty']) {
    for (const weeks of ['8', '26']) {
      globalThis.__adminCheck = {
        session: { sub: 'gallery-admin', email: 'ops-admin@example.test', role: 'admin_readonly', groups: ['admin_readonly'] },
        fe4Mode: mode,
      };
      const { default: Page } = await load(path);
      const body = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ weeks }) }));
      const file = join(out, `${tab}-${mode}-${weeks}.html`);
      writeFileSync(
        file,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${THEME}</script>${css
          .map((href) => `<link rel="stylesheet" href="${href}">`)
          .join('')}<title>FE-4 gallery: ${tab} (${mode}, ${weeks} weeks)</title></head><body style="margin:0;background:var(--jale-shell);color:var(--jale-ink)"><div style="max-width:1180px;margin:0 auto;padding:16px">${body}</div></body></html>`,
      );
      written.push(`${tab}-${mode}-${weeks}=${pathToFileURL(file).href}`);
    }
  }
}
writeFileSync(join(out, 'targets.txt'), `${written.join('\n')}\n`);
console.log(`fe4-gallery: ${written.length} pages in ${out} (targets.txt lists name=url pairs for cdp-pass.mjs)`);
