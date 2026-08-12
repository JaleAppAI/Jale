import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import React from 'react';
import { Header } from "@/components/layout/Header";
import { AuthProvider } from "@/contexts/AuthContext";
import { ConversationDrawer } from "@/components/employer/ConversationDrawer";
import { ToastProvider } from "@/components/ui/toast";

const lexend = Lexend({
  subsets: ["latin"],
  variable: "--font-lexend",
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800"],
});

/**
 * Applies the dark class BEFORE the browser paints, so a dark-theme user never
 * sees a white flash on first load. It runs where it is written -- as the first
 * thing in <body>, parser-blocking -- which is earlier than any React code can
 * possibly run, including a layout effect.
 *
 * Contract with `components/ui/theme-toggle.tsx`:
 *   'dark'   -> force dark
 *   'light'  -> force light (do nothing; light is the :root default)
 *   absent   -> follow the OS
 * Anything else is treated as light rather than throwing.
 *
 * Everything is wrapped: localStorage throws outright in some privacy modes,
 * and a failure here must not stop the page from rendering.
 */
const THEME_INIT_SCRIPT =
  "try{var t=localStorage.getItem('jale-theme');" +
  "if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches))" +
  "document.documentElement.classList.add('dark')}catch(e){}";

export const metadata: Metadata = {
  // Needed so relative openGraph/twitter `images` paths (e.g. the public job
  // page's OG image) resolve to absolute URLs -- required for link previews
  // in WhatsApp/iMessage/Twitter, which will not fetch a relative image URL.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://jaleapp.ai"),
  title: "Jale",
  description: "Find work. Find workers.",
};

export function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'es' }];
}

// Allow unknown locale params (for static export, we skip prerendering specific IDs)
export const dynamicParams = false;

export default async function RootLayout({
  children,
  params: { locale },
}: Readonly<{
  children: React.ReactNode;
  params: { locale: string };
}>) {
  const messages = await getMessages();
  return (
    // The init script below mutates <html>'s class list before hydration, so
    // the server markup and the live DOM legitimately differ here.
    <html lang={locale} className={lexend.variable} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AuthProvider locale={locale}>
            <ToastProvider>
              <Header />
              {children}
              <ConversationDrawer />
            </ToastProvider>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
