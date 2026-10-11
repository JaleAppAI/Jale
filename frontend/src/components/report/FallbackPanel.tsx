'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Mail, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SheetBody, SheetFooter } from '@/components/ui/sheet';
import { SUPPORT_CONTACT } from '@/lib/support-contact';
import type { ReportRole } from '@/lib/report/categories';
import { roleNamespace } from './types';

export type FallbackReason = 'paused' | 'signed_out_paused' | 'load_failed';

/**
 * What the sheet shows when the form cannot be used: reporting is paused, the
 * signed-out door is paused for a signed-out visitor, or the form itself did
 * not load. The person still leaves with a way to reach the team: the support
 * address the legal pages publish, and the WhatsApp keyword.
 */
export function FallbackPanel({
    reason,
    role,
    onClose,
}: {
    reason: FallbackReason;
    role: ReportRole;
    onClose: () => void;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const headingRef = useRef<HTMLHeadingElement>(null);

    // Replaces whatever had focus (often a control that no longer exists).
    useEffect(() => {
        headingRef.current?.focus();
    }, []);

    const title =
        reason === 'paused'
            ? t('paused_title')
            : reason === 'signed_out_paused'
              ? t('signed_out_paused_title')
              : t('load_failed');

    return (
        <>
            <SheetBody>
                <div className="space-y-4">
                    <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-[var(--jale-ink)] outline-none">
                        {title}
                    </h3>
                    <p className="text-sm text-[var(--jale-ink-2)]">{tRole('fallback.body')}</p>
                    <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
                        <li className="flex items-center gap-3 px-4 py-3">
                            <span className="stat-icon" aria-hidden="true">
                                <Mail className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('contact_email_label')}</p>
                                <a
                                    href={`mailto:${SUPPORT_CONTACT.email}`}
                                    translate="no"
                                    className="text-sm font-semibold break-all text-[var(--jale-blue-700)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                                >
                                    {SUPPORT_CONTACT.email}
                                </a>
                            </div>
                        </li>
                        <li className="flex items-center gap-3 px-4 py-3">
                            <span className="stat-icon" aria-hidden="true">
                                <MessageCircle className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('contact_whatsapp_label')}</p>
                                <p className="text-sm font-semibold text-[var(--jale-ink)]">
                                    {tRole('fallback.whatsapp', { keyword: SUPPORT_CONTACT.whatsappKeyword })}
                                </p>
                            </div>
                        </li>
                    </ul>
                    {reason === 'signed_out_paused' ? (
                        <p className="text-sm text-[var(--jale-ink-2)]">{tRole('fallback.sign_in')}</p>
                    ) : null}
                </div>
            </SheetBody>
            <SheetFooter>
                <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">
                    {t('close')}
                </Button>
            </SheetFooter>
        </>
    );
}

/** The other ways to reach the team, as one sentence, for messages inside the form. */
export function FallbackContacts({ role }: { role: ReportRole }) {
    const tRole = useTranslations(roleNamespace(role));
    return (
        <>
            {tRole.rich('fallback_contacts', {
                email: SUPPORT_CONTACT.email,
                keyword: SUPPORT_CONTACT.whatsappKeyword,
                mail: (chunks) => (
                    <a
                        href={`mailto:${SUPPORT_CONTACT.email}`}
                        translate="no"
                        className="font-semibold break-all underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                        {chunks}
                    </a>
                ),
            })}
        </>
    );
}
