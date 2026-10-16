// Applies the admin's saved theme, or the OS theme when none is saved, before
// the first paint. app/layout.tsx loads this file first in <head>
// (parser-blocking). It is a file, not inline HTML: the UI contract bans
// dangerouslySetInnerHTML, and the CSP allows script-src 'self'.
// components/ui/theme-toggle.tsx writes the same key: 'dark' or 'light';
// absent means follow the OS; any other value reads as light. Storage can
// throw in some privacy modes, and nothing here may stop the page rendering.
(function () {
  try {
    var saved = window.localStorage.getItem('jale-admin-theme');
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
