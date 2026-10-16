// Test-only stand-in for next/link in the FE-1 checks: a plain anchor that
// also shows the prefetch prop it was given, so a check can see that every
// rendered link asks for prefetch={false}.
import { createElement } from 'react';

export default function Link({ href, children, prefetch, replace: _replace, scroll: _scroll, ...rest }) {
  return createElement(
    'a',
    { ...rest, href: typeof href === 'string' ? href : String(href), 'data-prefetch': String(prefetch) },
    children,
  );
}
