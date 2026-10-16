// Test-only fake for next/link, used by check-ui-inbox-view.mjs. It renders
// a plain anchor, plus the prefetch prop as data-prefetch, so a check can see
// that a rendered link was written with prefetch={false}. Never imported by src.
import { createElement } from 'react';

export default function Link({ href, children, prefetch, replace: _replace, scroll: _scroll, ...rest }) {
  const marker = prefetch === undefined ? {} : { 'data-prefetch': String(prefetch) };
  return createElement('a', { ...rest, ...marker, href: typeof href === 'string' ? href : String(href) }, children);
}
