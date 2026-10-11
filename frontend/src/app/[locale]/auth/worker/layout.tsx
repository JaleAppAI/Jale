import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

// The worker auth page is a client component, and only a server component can
// export metadata, so its link preview lives in this pass-through layout
// (precedent: j/[code]/layout.tsx). This is what a chat app shows for
// jaleapp.ai/app, which redirects here.

// The opaque 1200x630 brand card, shared with the landing page's preview.
// Every other brand PNG is transparent and previews badly.
const OG_IMAGE = { url: '/brand/og-default.png', width: 1200, height: 630, alt: 'Jale' };

interface MetadataProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: MetadataProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'seo.worker_signup' });
  const title = t('title');
  const description = t('description');

  return {
    title,
    description,
    // robots.txt already disallows auth pages; this covers a crawler that
    // reaches one anyway.
    robots: { index: false },
    openGraph: {
      title,
      description,
      images: [OG_IMAGE],
      type: 'website',
      locale: locale === 'es' ? 'es_US' : 'en_US',
    },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE] },
  };
}

export default function WorkerAuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
