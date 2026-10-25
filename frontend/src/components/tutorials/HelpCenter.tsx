'use client';

import { useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Play } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { Icon } from '@/components/ui/icon';
import { useToast } from '@/components/ui/toast';
import {
    DEFAULT_TUTORIAL_SETTINGS,
    EMPLOYER_TOUR_IDS,
    WORKER_TOUR_IDS,
    type TutorialId,
    type TutorialRole,
    type TutorialSettingsPatch,
} from '@/lib/api/tutorials';
import { useGuideLaunchers, type GuideLauncher } from '@/lib/tutorials/launchers';
import { useTutorialProgress } from '@/lib/tutorials/progress';
import { tutorialsForRole } from '@/lib/tutorials/registry';

/**
 * The Help center (K1-v2): `/employer/help` and `/worker/help`, inside the
 * role's shell, where the header's Help link leads. Top to bottom:
 *  - "Show guides every time I start a task", the account's `always_show`;
 *  - the role's app tour, played again;
 *  - every guide of the role, each replayable, a muted one tagged Off; a
 *    guide whose task can start its step-by-step guide from here (its host
 *    registered a launcher, `lib/tutorials/launchers`) also gets "Guide me
 *    through it", which opens the task with that guide;
 *  - the guides turned off with "Don't show this again", each with
 *    "Show again".
 *
 * SAVING. A change shows at once (the progress store saves it
 * optimistically), and a failed save flips it back and says so in a toast.
 * The controls that save wait for the progress read, so nothing is saved
 * over settings the page has not seen, and take one save at a time.
 *
 * REPLAYS work whatever the read did, as Help's always have, and record
 * nothing. Each takes focus first (Safari does not focus a clicked button),
 * so the player hands focus back to the button that opened it.
 */

const TOUR_ID = { employer: EMPLOYER_TOUR_IDS[0], worker: WORKER_TOUR_IDS[0] } as const;

const FOCUS_RING = 'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';

export function HelpCenter({ role }: { role: TutorialRole }) {
    const t = useTranslations('tutorial.help_center');
    const tAll = useTranslations();
    const progress = useTutorialProgress();
    const toast = useToast();
    const switchLabelId = useId();
    const switchHelperId = useId();
    const guidesHeadingId = useId();
    const mutedHeadingId = useId();
    const mutedHeadingRef = useRef<HTMLHeadingElement>(null);
    const [saving, setSaving] = useState(false);
    const launchers = useGuideLaunchers();

    const tutorials = tutorialsForRole(role);
    const settings = progress?.settings ?? DEFAULT_TUTORIAL_SETTINGS;
    const ready = progress !== null && progress.status === 'ready' && progress.role === role;
    const mutedTutorials = tutorials.filter((tutorial) => settings.muted.includes(tutorial.id));

    function save(patch: TutorialSettingsPatch) {
        if (!progress || !ready || saving) return;
        const failed = t(`${role}.save_failed`);
        setSaving(true);
        void progress.updateSettings(patch).then((saved) => {
            setSaving(false);
            if (!saved) toast.error(failed);
        });
    }

    function replay(event: MouseEvent<HTMLButtonElement>, id: TutorialId) {
        event.currentTarget.focus();
        progress?.play({ id, mode: 'replay', vars: progress.varsFor(id) });
    }

    function guideMe(event: MouseEvent<HTMLButtonElement>, launch: GuideLauncher) {
        event.currentTarget.focus();
        launch();
    }

    function playTour(event: MouseEvent<HTMLButtonElement>) {
        event.currentTarget.focus();
        progress?.play({ id: TOUR_ID[role], mode: 'replay' });
    }

    function showAgain(id: TutorialId) {
        // The button goes with its row: keep the reader in this section.
        mutedHeadingRef.current?.focus();
        save({ muted: settings.muted.filter((muted) => muted !== id) });
    }

    const always = settings.always_show;

    return (
        <AppShell role={role} title={t('title')} subtitle={t('subtitle')}>
            <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 md:px-6">
                <div className="grid gap-4 md:grid-cols-2">
                    <DashboardPanel as="div" className="flex items-start gap-3 py-4 pl-5 pr-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <span id={switchLabelId} className="text-base font-bold text-[var(--jale-ink)]">
                                {t(`${role}.switch`)}
                            </span>
                            <span id={switchHelperId} className="text-sm text-[var(--jale-ink-2)]">
                                {always ? t(`${role}.helper_on`) : t('helper_off')}
                            </span>
                        </div>
                        {/* The `role="switch"` recipe of `DigestSettingsPanel`,
                            in a 44px target. Disabled until the settings are
                            known; while a save is in flight it stays focusable
                            and ignores presses. */}
                        <button
                            type="button"
                            role="switch"
                            aria-checked={always}
                            aria-labelledby={switchLabelId}
                            aria-describedby={switchHelperId}
                            aria-disabled={saving || undefined}
                            disabled={!ready}
                            onClick={() => save({ always_show: !always })}
                            className={[
                                'group inline-flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center rounded-full',
                                'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-progress',
                                FOCUS_RING,
                            ].join(' ')}
                        >
                            <span
                                aria-hidden
                                className={[
                                    'inline-flex h-6 w-11 items-center rounded-full border transition-colors duration-150',
                                    always
                                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
                                        : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
                                ].join(' ')}
                            >
                                <span
                                    className={[
                                        'inline-block h-4 w-4 rounded-full transition-transform duration-150',
                                        always
                                            ? 'translate-x-[1.4375rem] bg-[var(--jale-blue-500)]'
                                            : 'translate-x-[0.1875rem] bg-[var(--jale-ink-2)]',
                                    ].join(' ')}
                                />
                            </span>
                        </button>
                    </DashboardPanel>

                    <DashboardPanel as="div" className="flex">
                        <button
                            type="button"
                            onClick={playTour}
                            className={[
                                'flex min-h-11 w-full cursor-pointer items-center gap-3.5 rounded-[var(--radius-card)] py-4 pl-5 pr-4 text-left',
                                'transition-colors hover:bg-[var(--jale-paper-2)]',
                                FOCUS_RING,
                            ].join(' ')}
                        >
                            <span
                                aria-hidden
                                className={[
                                    'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-input)]',
                                    role === 'worker'
                                        ? 'bg-[var(--jale-teal-50)] text-[var(--jale-teal-500)]'
                                        : 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
                                ].join(' ')}
                            >
                                <Icon name="spark" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-base font-bold text-[var(--jale-ink)]">{t('tour_again')}</span>
                                <span className="text-sm text-[var(--jale-ink-2)]">{t('tour_again_sub')}</span>
                            </span>
                            <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--jale-ink-2)]" />
                        </button>
                    </DashboardPanel>
                </div>

                <section aria-labelledby={guidesHeadingId} className="flex flex-col gap-3">
                    <h2 id={guidesHeadingId} className="text-lg font-bold text-[var(--jale-ink)]">
                        {t('guides')}
                    </h2>
                    <ul aria-labelledby={guidesHeadingId} className="grid gap-4 md:grid-cols-2">
                        {tutorials.map((tutorial) => {
                            const title = tAll(`${tutorial.namespace}.${tutorial.titleKey}`);
                            const muted = settings.muted.includes(tutorial.id);
                            const launch = launchers.get(tutorial.id);
                            return (
                                <li key={tutorial.id}>
                                    <DashboardPanel as="div" className="flex h-full items-center gap-3.5 py-4 pl-5 pr-4">
                                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                                            <h3 className="text-base font-bold text-[var(--jale-ink)]">{title}</h3>
                                            <p className="text-sm text-[var(--jale-ink-2)]">
                                                {tAll(`${tutorial.namespace}.description`)}
                                            </p>
                                            <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--jale-ink-2)]">
                                                <span>{tAll(`${tutorial.namespace}.duration`)}</span>
                                                {muted ? <Badge tone="warning">{t('off_tag')}</Badge> : null}
                                            </div>
                                            {launch ? (
                                                <button
                                                    type="button"
                                                    aria-label={t(`${role}.guide_me_label`, { title })}
                                                    onClick={(event) => guideMe(event, launch)}
                                                    className={[
                                                        'mt-1 inline-flex h-11 w-fit shrink-0 cursor-pointer items-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4',
                                                        'text-sm font-semibold text-[var(--jale-blue-700)] transition-colors hover:bg-[var(--jale-paper-2)]',
                                                        FOCUS_RING,
                                                    ].join(' ')}
                                                >
                                                    {t(`${role}.guide_me`)}
                                                </button>
                                            ) : null}
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={t('play_label', { title })}
                                            title={t('play')}
                                            onClick={(event) => replay(event, tutorial.id)}
                                            className={[
                                                'inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full',
                                                'bg-[var(--jale-blue-500)] text-white shadow-[var(--shadow-btn)] transition-colors hover:bg-[var(--jale-blue-600)]',
                                                FOCUS_RING,
                                            ].join(' ')}
                                        >
                                            <Play aria-hidden="true" className="h-[18px] w-[18px] fill-current" />
                                        </button>
                                    </DashboardPanel>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                <section aria-labelledby={mutedHeadingId} className="flex flex-col gap-3">
                    <h2
                        id={mutedHeadingId}
                        ref={mutedHeadingRef}
                        tabIndex={-1}
                        className="text-lg font-bold text-[var(--jale-ink)] focus-visible:outline-none"
                    >
                        {t(`${role}.muted_title`)}
                    </h2>
                    {mutedTutorials.length === 0 ? (
                        <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--jale-divider)] px-5 py-4 text-sm text-[var(--jale-ink-2)]">
                            {t(`${role}.muted_empty`)}
                        </p>
                    ) : (
                        <ul aria-labelledby={mutedHeadingId} className="flex flex-col gap-3">
                            {mutedTutorials.map((tutorial) => {
                                const title = tAll(`${tutorial.namespace}.${tutorial.titleKey}`);
                                return (
                                    <li key={tutorial.id}>
                                        <DashboardPanel as="div" className="flex items-center gap-3 py-2.5 pl-5 pr-2.5">
                                            <span className="min-w-0 flex-1 text-[15px] font-semibold text-[var(--jale-ink)]">
                                                {title}
                                            </span>
                                            <button
                                                type="button"
                                                aria-label={t('show_again_label', { title })}
                                                disabled={!ready}
                                                aria-disabled={saving || undefined}
                                                onClick={() => showAgain(tutorial.id)}
                                                className={[
                                                    'inline-flex h-11 shrink-0 cursor-pointer items-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4',
                                                    'text-sm font-semibold text-[var(--jale-blue-700)] transition-colors hover:bg-[var(--jale-paper-2)]',
                                                    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-progress',
                                                    FOCUS_RING,
                                                ].join(' ')}
                                            >
                                                {t('show_again')}
                                            </button>
                                        </DashboardPanel>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </main>
        </AppShell>
    );
}
