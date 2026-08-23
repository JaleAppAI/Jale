'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { PanelHeader } from '@/components/ui/panel-header';
import { Select } from '@/components/ui/select';
import { SkeletonLine } from '@/components/ui/skeleton';
import {
    getEmployerDigestSettings,
    updateEmployerDigestSettings,
    type EmployerDigestSettingsPatch,
} from '@/lib/api/employer';
import {
    DIGEST_HOURS,
    DIGEST_LANGUAGES,
    digestHourLabel,
    digestTimezoneLabelKey,
    digestTimezoneOptions,
    normalizeDigestSettings,
    type DigestSettings,
} from '@/lib/employer-digest-form';

/**
 * The employer's daily applicant-digest email preferences — the "Notifications"
 * section of the settings page (`/employer/profile`, which is what the nav's
 * "Settings" tab points at).
 *
 * NO SAVE BUTTON, deliberately. `PATCH /employer/settings/digest` accepts any
 * subset of the four fields and answers with the full stored row, so each
 * control writes only its own field the moment it changes and the response
 * becomes the new state. One shared `saving` flag disables all four controls
 * while a write is in flight, so two overlapping PATCHes cannot land in an
 * order that contradicts what the employer sees. A staged form with a Save
 * button would add a "you have unsaved changes" state to a panel of four
 * independent switches for nothing.
 *
 * The panel owns its own load rather than joining the page's `usePageData`
 * fetch: a failed digest read must not take the profile page down with it, and
 * a failed profile read must not hide these controls.
 *
 * The switch markup is a local copy of the `role="switch"` control in
 * `RequirementsPicker.tsx` and `PublicListingCard.tsx` (which is also where
 * the saving/disabled behaviour comes from). Copied rather than extracted on
 * purpose: three call sites is where a shared primitive starts to earn itself,
 * and those two files are owned by other in-flight work.
 */

/** Same two-tone split as the profile form above it: two problems, two tones. */
type PanelFeedback = { tone: Extract<FeedbackTone, 'success' | 'danger'>; text: string };

const labelClasses = 'text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]';
const hintClasses = 'text-xs text-[var(--jale-ink-2)]';

export function DigestSettingsPanel() {
    const { idToken, isLoading: authLoading } = useAuth();
    const t = useTranslations('employer.digest');
    const tZones = useTranslations('employer.digest.timezones');
    const tCommon = useTranslations('common');
    const errorMessage = useErrorMessage();
    const locale = useLocale();
    const fieldId = useId();

    const [settings, setSettings] = useState<DigestSettings | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<PanelFeedback | null>(null);

    useEffect(() => {
        // No token yet means the auth layer has not resolved, not that the
        // employer is anonymous -- firing here would just 401.
        if (!idToken) return;

        const controller = new AbortController();
        let live = true;

        (async () => {
            try {
                const loaded = await getEmployerDigestSettings(idToken, controller.signal);
                if (!live) return;
                setSettings(normalizeDigestSettings(loaded));
                setLoadFailed(false);
            } catch (err) {
                // `apiFetch` rethrows a caller's abort untouched, so this is
                // the one error that must NOT paint: it means the reader
                // navigated away or the token changed, and `classifyError`
                // would otherwise turn it into a danger banner on a dead view.
                if (err instanceof Error && err.name === 'AbortError') return;
                if (!live) return;
                setLoadFailed(true);
            }
        })();

        return () => {
            live = false;
            controller.abort();
        };
    }, [idToken]);

    const save = useCallback(
        async (patch: EmployerDigestSettingsPatch) => {
            if (!idToken || saving) return;
            setFeedback(null);
            setSaving(true);
            try {
                const updated = await updateEmployerDigestSettings(idToken, patch);
                // The PATCH response IS the stored row, so the panel updates
                // from it instead of spending a second round trip re-reading
                // what it just sent.
                setSettings(normalizeDigestSettings(updated));
                setFeedback({ tone: 'success', text: tCommon('feedback.saved') });
            } catch (err) {
                // Never `err.message`: on a failed save that is a backend error
                // CODE or an exception string -- untranslated, sometimes server
                // detail. The three documented 400 codes
                // (invalid_timezone/invalid_hour/invalid_language) are
                // unreachable from these controls, which can only emit values
                // from the curated lists, so they get no bespoke copy.
                setFeedback({ tone: 'danger', text: errorMessage(err, { unknown: t('save_error') }) });
            } finally {
                setSaving(false);
            }
        },
        [idToken, saving, errorMessage, t, tCommon],
    );

    const enabled = settings?.enabled ?? false;
    // Disabled until the row is known: a control bound to a placeholder would
    // let the employer PATCH a value they were never shown.
    const busy = saving || settings === null;

    return (
        <DashboardPanel>
            <PanelHeader
                title={t('title')}
                action={
                    <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={t('toggle_aria')}
                        disabled={busy}
                        onClick={() => void save({ enabled: !enabled })}
                        className={[
                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border',
                            'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            enabled
                                ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
                                : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
                        ].join(' ')}
                    >
                        <span
                            aria-hidden
                            className={[
                                'inline-block h-4 w-4 rounded-full transition-transform duration-150',
                                enabled
                                    ? 'translate-x-[1.4375rem] bg-[var(--jale-blue-500)]'
                                    : 'translate-x-[0.1875rem] bg-[var(--jale-ink-2)]',
                            ].join(' ')}
                        />
                    </button>
                }
            />

            <div className="space-y-4 px-5 py-4">
                <p className="text-sm text-[var(--jale-ink-2)]">{t('description')}</p>

                {settings === null ? (
                    /* `!idToken && !authLoading` is the signed-out shape. The
                       page-level auth gate redirects before it can normally be
                       seen, but a permanent skeleton would be a worse failure
                       than a sentence if it ever is. */
                    loadFailed || (!idToken && !authLoading) ? (
                        <InlineFeedback tone="danger">{t('load_error')}</InlineFeedback>
                    ) : (
                        /* Same geometry as the loaded state, so the swap does
                           not shift the panel below it. */
                        <div className="space-y-4" aria-hidden>
                            <SkeletonLine width="w-32" />
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <SkeletonLine width="w-full" className="h-11" tone="paper" />
                                <SkeletonLine width="w-full" className="h-11" tone="paper" />
                            </div>
                            <SkeletonLine width="w-48" className="h-9" tone="paper" />
                        </div>
                    )
                ) : (
                    <>
                        <Badge tone={enabled ? 'success' : 'neutral'}>
                            {enabled ? t('state_on') : t('state_off')}
                        </Badge>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                                <label className={labelClasses} htmlFor={`${fieldId}-hour`}>
                                    {t('hour_label')}
                                </label>
                                <Select
                                    id={`${fieldId}-hour`}
                                    className="tabular-nums"
                                    value={String(settings.send_hour_local)}
                                    disabled={busy}
                                    onChange={(e) => void save({ send_hour_local: Number(e.target.value) })}
                                >
                                    {DIGEST_HOURS.map((hour) => (
                                        <option key={hour} value={hour}>
                                            {digestHourLabel(hour, locale)}
                                        </option>
                                    ))}
                                </Select>
                                <p className={hintClasses}>{t('hour_hint')}</p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label className={labelClasses} htmlFor={`${fieldId}-timezone`}>
                                    {t('timezone_label')}
                                </label>
                                <Select
                                    id={`${fieldId}-timezone`}
                                    value={settings.timezone}
                                    disabled={busy}
                                    onChange={(e) => void save({ timezone: e.target.value })}
                                >
                                    {digestTimezoneOptions(settings.timezone).map((zone) => {
                                        // A curated zone gets its reviewed bilingual label;
                                        // anything else (a zone set outside this picker)
                                        // shows its raw IANA id. Asking next-intl for a
                                        // message that does not exist renders the key PATH
                                        // to the employer, which is why
                                        // `digestTimezoneLabelKey` returns `null` rather
                                        // than a derived guess.
                                        const segment = digestTimezoneLabelKey(zone);
                                        return (
                                            <option key={zone} value={zone}>
                                                {segment === null ? zone : tZones(segment)}
                                            </option>
                                        );
                                    })}
                                </Select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <p className={labelClasses}>{t('language_label')}</p>
                            <div
                                role="radiogroup"
                                aria-label={t('language_group_aria')}
                                className="flex w-fit gap-1 rounded-full border border-[var(--jale-divider)] p-0.5"
                            >
                                {DIGEST_LANGUAGES.map((language) => {
                                    const selected = settings.language === language;
                                    return (
                                        <button
                                            key={language}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            disabled={busy}
                                            onClick={() => void save({ language })}
                                            className={[
                                                'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                                                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                                'disabled:cursor-not-allowed disabled:opacity-60',
                                                selected
                                                    ? 'bg-[var(--jale-blue-500)] text-white'
                                                    : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
                                            ].join(' ')}
                                        >
                                            {t(`language_option.${language}`)}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className={hintClasses}>{t('language_hint')}</p>
                        </div>
                    </>
                )}

                {feedback && (
                    <InlineFeedback tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                        {feedback.text}
                    </InlineFeedback>
                )}
            </div>
        </DashboardPanel>
    );
}
