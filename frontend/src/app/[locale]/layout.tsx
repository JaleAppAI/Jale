import type { Metadata } from "next";
import localFont from "next/font/local";
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
import { WorkerAttentionProvider } from "@/contexts/WorkerAttentionContext";
import { ReportProblemProvider } from "@/contexts/ReportProblemContext";
import { OverlayPresenceProvider } from "@/lib/tutorials/overlay";
import { TutorialProgressProvider } from "@/lib/tutorials/progress";
import { WorkerTourGate } from "@/components/tutorials/WorkerTourGate";

// Lexend's latin subset, committed (src/fonts, with its OFL licence) so the
// build never fetches from Google: next/font/google failed two production
// builds on 2026-10-29 while Turbopack rewrote Google's font CSS, then passed
// on a rerun. It is the variable font, so one file covers every weight, and
// latin holds every Spanish character (á é í ó ú ñ ü ¿ ¡).
const lexend = localFont({
  src: "../../fonts/lexend-latin.woff2",
  variable: "--font-lexend",
  display: "swap",
  weight: "300 800",
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
          {/* One record of which dialogs are open, above everything that
              opens one (the report sheet, the job wizard, the plan-limit
              notice, the conversation drawer), so a tutorial never
              auto-opens over another dialog. `Modal` and `Sheet` report
              themselves to it. */}
          <OverlayPresenceProvider>
            <AuthProvider locale={locale}>
              {/* "Report a problem" from anywhere: inside AuthProvider (the
                  form needs the session) and above everything else, so every
                  header, sign-in screen and error state below can open it. It
                  mounts its own sheet, and records the screens visited and
                  uncaught errors for the report's context. */}
              <ReportProblemProvider>
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
                      {/* The worker's "needs your attention" summary, once for
                          the session: the nav badge on both rails and the home
                          page's banners read the same answer -- see
                          WorkerAttentionContext. It asks nothing for an
                          employer or a visitor. */}
                      <WorkerAttentionProvider>
                        {/* Tutorial progress, read once for the session, and the one
                            tutorial player. Inside AuthProvider (it reads the
                            session) and above the job wizard and the conversation
                            drawer, whose tutorials play before they open. */}
                        <TutorialProgressProvider>
                          {/* Outside the pages, so "Post a job" is reachable from every
                              employer surface rather than only from the dashboard. A
                              post is confirmed on the wizard's own "Job posted" screen. */}
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
                          {/* Plays the worker app tour once, at the first
                              worker page after onboarding where nothing else
                              is up. Renders nothing. */}
                          <WorkerTourGate />
                        </TutorialProgressProvider>
                      </WorkerAttentionProvider>
                    </UnreadMessagesProvider>
                  </ToastProvider>
                </SidebarProfileProvider>
              </ReportProblemProvider>
            </AuthProvider>
          </OverlayPresenceProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
