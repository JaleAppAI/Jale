'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SheetBody, SheetFooter } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { SUPPORT_CONTACT } from '@/lib/support-contact';
import type { ReportRole } from '@/lib/report/categories';
import { roleNamespace } from './types';

/**
 * Where the report's image stands. The report itself is saved whatever this
 * says: the image follows it, and can fail on its own.
 */
export type ImageDeliveryState = 'none' | 'sending' | 'sent' | 'paused' | 'failed' | 'failed_final';

/**
 * Step 3: the report number and what happens next. It promises no reply.
 *
 * A signed-out report says it could not be verified, and repeats the WhatsApp
 * keyword: the person may never be able to sign in to see anything else.
 */
export function SentStep({
    role,
    verified,
    number,
    image,
    onRetryImage,
    onClose,
}: {
    role: ReportRole;
    verified: boolean;
    number: string;
    image: ImageDeliveryState;
    onRetryImage: () => void;
    onClose: () => void;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const headingRef = useRef<HTMLHeadingElement>(null);

    // The form the focus was in is gone; the outcome is what to read next.
    useEffect(() => {
        headingRef.current?.focus();
    }, []);

    return (
        <>
            <SheetBody>
                <div className="space-y-4 text-center">
                    <span
                        aria-hidden="true"
                        className="mx-auto mt-2 inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]"
                    >
                        <Icon name="check" />
                    </span>
                    <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-[var(--jale-ink)] outline-none">
                        {verified ? tRole('sent.title') : tRole('sent.title_unverified')}
                    </h3>
                    <div className="rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-4 py-3">
                        <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{tRole('sent.number_label')}</p>
                        <p translate="no" className="mt-1 text-2xl font-extrabold tracking-wide text-[var(--jale-ink)] tabular-nums">
                            {number}
                        </p>
                    </div>
                    <p className="text-sm text-[var(--jale-ink-2)]">
                        {verified ? tRole('sent.body') : tRole('sent.body_unverified')}
                    </p>
                    {verified ? null : (
                        <p className="text-sm text-[var(--jale-ink-2)]">
                            {tRole('sent.whatsapp', { keyword: SUPPORT_CONTACT.whatsappKeyword })}
                        </p>
                    )}

                    {image === 'sending' ? (
                        <p role="status" className="flex items-center justify-center gap-2 text-sm text-[var(--jale-ink-2)]">
                            <Spinner />
                            {t('image_sending')}
                        </p>
                    ) : null}
                    {image === 'sent' ? (
                        <p role="status" className="text-sm font-medium text-[var(--jale-success-text)]">
                            {t('image_sent')}
                        </p>
                    ) : null}
                    {image === 'paused' ? (
                        <p role="status" className="text-sm text-[var(--jale-ink-2)]">
                            {tRole('sent.image_paused')}
                        </p>
                    ) : null}
                    {image === 'failed' ? (
                        <div role="alert" className="space-y-3 rounded-[var(--radius-input)] bg-[var(--jale-warning-bg)] px-4 py-3 text-[var(--jale-warning-text)]">
                            <p className="text-sm font-medium">{tRole('sent.image_failed')}</p>
                            <Button type="button" variant="outline" size="sm" onClick={onRetryImage} className="h-11">
                                {t('try_again')}
                            </Button>
                        </div>
                    ) : null}
                    {image === 'failed_final' ? (
                        <p role="alert" className="rounded-[var(--radius-input)] bg-[var(--jale-warning-bg)] px-4 py-3 text-sm font-medium text-[var(--jale-warning-text)]">
                            {tRole('sent.image_failed_final')}
                        </p>
                    ) : null}
                </div>
            </SheetBody>
            <SheetFooter>
                <Button type="button" onClick={onClose} className="w-full sm:w-auto">
                    {verified ? t('done') : t('back')}
                </Button>
            </SheetFooter>
        </>
    );
}
