'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { InlineFeedback } from '@/components/ui/inline-feedback';

/**
 * "Add start details for N new hires" (contract K4.4): the employer's prompt,
 * on the applicants page (no link, the rows are right below) and on the
 * dashboard (with a link to them). Nothing at all at zero.
 */
export function HireDetailsNeededBanner({ count, href }: { count: number; href?: string }) {
  const t = useTranslations('employer_applicants.hire_details');
  if (count <= 0) return null;
  return (
    <InlineFeedback tone="info" className="mb-4">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold">{t('banner', { count })}</span>
        {href ? (
          <Link
            href={href}
            className="text-xs font-bold underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {t('banner_cta')}
          </Link>
        ) : null}
      </span>
    </InlineFeedback>
  );
}
