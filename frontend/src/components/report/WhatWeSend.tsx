'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { ReportRole } from '@/lib/report/categories';
import type { ReportContextV1 } from './seams/report-context';
import { roleNamespace } from './types';

type Device = NonNullable<ReportContextV1['device']>;

/** Product names, which read the same in both languages. */
const BROWSER_NAMES: Partial<Record<Device['browser'], string>> = {
    chrome: 'Chrome',
    safari: 'Safari',
    firefox: 'Firefox',
    edge: 'Edge',
    samsung: 'Samsung Internet',
    opera: 'Opera',
};
const OS_NAMES: Partial<Record<Device['os'], string>> = {
    ios: 'iOS',
    android: 'Android',
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    chromeos: 'ChromeOS',
};

const listClasses = 'mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--jale-ink)] marker:text-[var(--jale-ink-2)]';
const overlineClasses = 'text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]';

/**
 * "What we'll send": everything that goes with the report, in plain words,
 * before the person sends it -- and the switch that keeps the technical
 * details on the phone.
 *
 * The list is read from the real context (`preview`) when it is opened, so it
 * names this screen, this build and this device rather than describing them in
 * general. Closed by default: the form stays short, and the one-line notice
 * under it says the same thing in brief.
 */
export function WhatWeSend({
    role,
    signedIn,
    imageIncluded,
    includeTechnical,
    onIncludeTechnicalChange,
    preview,
}: {
    role: ReportRole;
    signedIn: boolean;
    imageIncluded: boolean;
    includeTechnical: boolean;
    onIncludeTechnicalChange: (include: boolean) => void;
    /** The context as it would be sent with technical details on. */
    preview: () => ReportContextV1;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const panelId = useId();
    const switchLabelId = useId();
    const switchHintId = useId();
    // Read once per opening: the list describes the moment the person looked.
    const [context, setContext] = useState<ReportContextV1 | null>(null);
    const open = context !== null;

    const device = context?.device;

    return (
        <section className="rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
            <h3>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    onClick={() => setContext(open ? null : preview())}
                    className={[
                        'flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-input)] px-4 py-2.5',
                        'text-left text-sm font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
                        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                    ].join(' ')}
                >
                    <span>{t('what_we_send.toggle')}</span>
                    <ChevronDown
                        aria-hidden="true"
                        className={`h-4 w-4 shrink-0 text-[var(--jale-ink-2)] transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                    />
                </button>
            </h3>

            {context ? (
                <div id={panelId} className="space-y-4 border-t border-[var(--jale-divider)] px-4 py-3">
                    <div>
                        <h4 className={overlineClasses}>{tRole('what_we_send.with_heading')}</h4>
                        <ul className={listClasses}>
                            <li>{signedIn ? tRole('what_we_send.account') : tRole('what_we_send.contact')}</li>
                            {imageIncluded ? <li>{tRole('what_we_send.image')}</li> : null}
                            <li className="break-words">{t('what_we_send.screen', { pattern: context.screen.pattern })}</li>
                            <li>
                                {t('what_we_send.app', {
                                    build: context.app.build,
                                    language: t(`language.${context.app.locale}`),
                                })}
                            </li>
                            {includeTechnical && device ? (
                                <li>
                                    {t('what_we_send.device', {
                                        kind: t(`device_kind.${device.kind}`),
                                        browser:
                                            BROWSER_NAMES[device.browser] ??
                                            (device.browser === 'webview'
                                                ? t('what_we_send.in_app_browser')
                                                : t('what_we_send.other_family')),
                                        os: OS_NAMES[device.os] ?? t('what_we_send.other_family'),
                                        width: device.viewport[0],
                                        height: device.viewport[1],
                                    })}
                                </li>
                            ) : null}
                            {includeTechnical ? (
                                <>
                                    <li>{t('what_we_send.requests', { count: context.requests?.length ?? 0 })}</li>
                                    <li>{t('what_we_send.errors', { count: context.errors?.length ?? 0 })}</li>
                                </>
                            ) : null}
                        </ul>
                        {includeTechnical ? null : (
                            <p className="mt-2 text-sm text-[var(--jale-ink-2)]">{t('what_we_send.technical_off')}</p>
                        )}
                    </div>

                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <p id={switchLabelId} className="text-sm font-semibold text-[var(--jale-ink)]">
                                {t('what_we_send.technical_label')}
                            </p>
                            <p id={switchHintId} className="mt-0.5 text-xs text-[var(--jale-ink-2)]">
                                {t('what_we_send.technical_hint')}
                            </p>
                        </div>
                        {/* The settings switch recipe (DigestSettingsPanel), with
                            ThemeToggle's ::after overlay for a 44px target. */}
                        <button
                            type="button"
                            role="switch"
                            aria-checked={includeTechnical}
                            aria-labelledby={switchLabelId}
                            aria-describedby={switchHintId}
                            onClick={() => onIncludeTechnicalChange(!includeTechnical)}
                            className={[
                                'relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border',
                                'transition-colors duration-150 motion-reduce:transition-none',
                                'hover:border-[var(--jale-blue-500)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-14 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                                includeTechnical
                                    ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
                                    : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
                            ].join(' ')}
                        >
                            <span
                                aria-hidden="true"
                                className={[
                                    'inline-block h-4 w-4 rounded-full transition-transform duration-150 motion-reduce:transition-none',
                                    includeTechnical
                                        ? 'translate-x-[1.4375rem] bg-[var(--jale-blue-500)]'
                                        : 'translate-x-[0.1875rem] bg-[var(--jale-ink-2)]',
                                ].join(' ')}
                            />
                        </button>
                    </div>

                    <div>
                        <h4 className={overlineClasses}>{t('what_we_send.never_heading')}</h4>
                        <ul className={listClasses}>
                            <li>{tRole('what_we_send.never_typed')}</li>
                            <li>{t('what_we_send.never_codes')}</li>
                            <li>{t('what_we_send.never_content')}</li>
                            <li>{tRole('what_we_send.never_files')}</li>
                        </ul>
                    </div>

                    <p className="text-sm text-[var(--jale-ink-2)]">{t('what_we_send.kept')}</p>
                </div>
            ) : null}
        </section>
    );
}
