import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import React from 'react';
import { Header } from "@/components/layout/Header";
import { AuthProvider } from "@/contexts/AuthContext";
import { SidebarProfileProvider } from "@/contexts/SidebarProfileContext";
import { ConversationDrawerProvider } from "@/contexts/ConversationDrawerContext";
import { ToastProvider } from "@/components/ui/toast";
import { PostJobProvider } from "@/contexts/PostJobContext";
import { UnreadMessagesProvider } from "@/contexts/UnreadMessagesContext";

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
  alternates: {
    types: { 'application/rss+xml': '/feed.xml' },
  },
};

export function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'es' }];
}

// Allow unknown locale params (for static export, we skip prerendering specific IDs)
export const dynamicParams = false;

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const messages = await getMessages();
  return (
    // The init script below mutates <html>'s class list before hydration, so
    // the server markup and the live DOM legitimately differ here.
    <html lang={locale} className={lexend.variable} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AuthProvider locale={locale}>
            {/* One profile load for the whole session. Every page mounts its
                own AppShell, so a chip fetch owned by the shell ran again on
                every navigation -- see SidebarProfileContext. */}
            <SidebarProfileProvider>
              <ToastProvider>
                {/* One inbox read for the whole session, above the router.
                    The nav badge, the drawer and the dashboard panel all
                    render the same unread count, and a hook per surface would
                    be four pollers on one endpoint -- see
                    UnreadMessagesContext. Above PostJobProvider so the drawer
                    (mounted below it) can consume it. */}
                <UnreadMessagesProvider>
                  {/* Inside ToastProvider (it toasts a posted job) and outside
                      the pages, so "Post a job" is reachable from every employer
                      surface rather than only from the dashboard. */}
                  <PostJobProvider>
                    {/* Mounts the drawer itself, the way PostJobProvider
                        mounts the wizard, so any surface can open a thread
                        for one applicant instead of only the drawer's own
                        floating button being able to. */}
                    <ConversationDrawerProvider>
                      <Header />
                      {children}
                    </ConversationDrawerProvider>
                  </PostJobProvider>
                </UnreadMessagesProvider>
              </ToastProvider>
            </SidebarProfileProvider>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
