import type { Metadata } from 'next';
import { Lexend } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Self-hosted at build time: next/font serves the files from /_next/static,
// which the CSP's font-src 'self' allows.
const lexend = Lexend({
  subsets: ['latin'],
  variable: '--font-lexend',
  display: 'swap',
  weight: ['300', '400', '500', '600', '700', '800'],
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
