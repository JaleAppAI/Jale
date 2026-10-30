import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './globals.css';

// Lexend's latin subset, committed (src/fonts, with its OFL licence) so the
// build never fetches from Google: next/font/google failed two production
// builds on 2026-10-29 while Turbopack rewrote Google's font CSS, then passed
// on a rerun. It is the variable font, so one file covers every weight.
// next/font serves it from /_next/static, which the CSP's font-src 'self'
// allows.
const lexend = localFont({
  src: '../fonts/lexend-latin.woff2',
  variable: '--font-lexend',
  display: 'swap',
  weight: '300 800',
});

export const metadata: Metadata = {
  title: 'Jale Admin',
  description: 'Jale admin console',
};

/**
 * The document only. The console shell lives in (console)/layout.tsx and the
 * sign-in frame in (auth)/layout.tsx.
 *
 * public/theme-init.js adds the dark class to <html> before hydration, so the
 * server markup and the live class list differ there on purpose
 * (suppressHydrationWarning covers <html> only). It is loaded first in <head>
 * and parser-blocking, so no page paints in the wrong theme.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={lexend.variable} suppressHydrationWarning>
      <head>
        <script src="/theme-init.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
