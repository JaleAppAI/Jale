import type { Metadata } from "next";
import { Syne } from "next/font/google";
import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import React from 'react';
import { Header } from "@/components/layout/Header";
import { AuthProvider } from "@/contexts/AuthContext";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Jale",
  description: "Find work. Find workers.",
};

export default async function RootLayout({
  children,
  params: { locale },
}: Readonly<{
  children: React.ReactNode;
  params: { locale: string };
}>) {
  const messages = await getMessages();
  return (
    <html lang={locale} className={syne.variable}>
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
