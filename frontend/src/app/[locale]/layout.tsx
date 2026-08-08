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
    <html lang={locale} className={lexend.variable}>
      <body>
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
