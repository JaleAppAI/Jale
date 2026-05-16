import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import React from 'react';
import { Header } from "@/components/layout/Header";
import { AuthProvider } from "@/contexts/AuthContext";

const lexend = Lexend({
  subsets: ["latin"],
  variable: "--font-lexend",
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
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
            <Header />
            {children}
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
