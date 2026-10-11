// Fake for next/link in the admin check scripts: a plain anchor, so a view
// can be rendered with react-dom/server outside Next.
import { createElement } from 'react';

export default function Link({ href, children, prefetch: _prefetch, replace: _replace, scroll: _scroll, ...rest }) {
  return createElement('a', { ...rest, href: typeof href === 'string' ? href : String(href) }, children);
}
