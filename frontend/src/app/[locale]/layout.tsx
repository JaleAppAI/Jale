import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import React from 'react';
import { Header } from "@/components/layout/Header";


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
    <html lang={locale} className={GeistSans.variable}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Header />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
