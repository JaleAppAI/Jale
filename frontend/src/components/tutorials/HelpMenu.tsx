'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, CircleHelp } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Icon } from '@/components/ui/icon';
import type { TutorialId, TutorialRole } from '@/lib/api/tutorials';
import { useTutorialProgress, type TutorialProgressValue } from '@/lib/tutorials/progress';
import { tutorialsForRole } from '@/lib/tutorials/registry';

/**
 * Help in a signed-in header: "How Jale works", the list of this role's
 * tutorials, any of which can be replayed at any time (ruling R10). A replay
 * never records anything and works even when the progress read failed.
 *
 * There is no popover primitive, so the menu is a `Modal` with a list.
 * Choosing a tutorial closes Help FIRST and replays from a post-commit effect,
 * once Help's dialog has handed focus back to this button, so there is never
 * more than one dialog and the tutorial returns focus here when it closes.
 *
 * Renders nothing outside the tutorial provider, and nothing on a page that
 * belongs to no signed-in shell: `AppShell` and `OnboardingHeader` render
 * exactly what they did before wherever the provider is not mounted.
 */

// `ReportEntryButton`'s recipe, so the two header buttons are one family.
const TONES = {
    default: [
        'border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]',
        'hover:bg-[var(--jale-paper-2)] focus-visible:shadow-[var(--shadow-focus)]',
    ].join(' '),
    // The navy brand bands (onboarding): white ink, the 20%-white border.
    brand: [
        'border border-white/20 bg-transparent text-white/85',
        'hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60',
    ].join(' '),
} as const;

const SIZES = {
    md: 'h-10 gap-1.5 px-3 text-xs',
    sm: 'h-8 gap-1 px-2.5 text-xs',
} as const;

/** Icon only on phones (a square, like the controls beside it); icon and label from 640px. */
const PHONE_SQUARE = { md: 'max-sm:w-10 max-sm:px-0', sm: 'max-sm:w-8 max-sm:px-0' } as const;

export function HelpEntryButton({
    tone = 'default',
    size = 'md',
}: {
    tone?: keyof typeof TONES;
    size?: keyof typeof SIZES;
}) {
    const progress = useTutorialProgress();
    if (!progress || progress.shellRole === null) return null;
    return <HelpEntry progress={progress} role={progress.shellRole} tone={tone} size={size} />;
}

function HelpEntry({
    progress,
    role,
    tone,
    size,
}: {
    progress: TutorialProgressValue;
    role: TutorialRole;
    tone: keyof typeof TONES;
    size: keyof typeof SIZES;
}) {
    const tCommon = useTranslations('tutorial.common');
    const label = tCommon('help');
    const [open, setOpen] = useState(false);
    const chosen = useRef<TutorialId | null>(null);

    // Help has closed and its cleanup has returned focus to this button:
    // now the chosen tutorial may open, and will hand focus back here too.
    useEffect(() => {
        if (open || chosen.current === null) return;
        const id = chosen.current;
        chosen.current = null;
        progress.play({ id, mode: 'replay', vars: progress.varsFor(id) });
    }, [open, progress]);

    const onOpen = (event: MouseEvent<HTMLButtonElement>) => {
        // Safari does not focus a clicked button; the dialogs return focus to
        // whatever had it, and that should be this button.
        event.currentTarget.focus();
        setOpen(true);
    };

    return (
        <>
            <button
                type="button"
                aria-label={label}
                title={label}
                aria-haspopup="dialog"
                onClick={onOpen}
                className={[
                    'relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-full font-bold',
                    'transition-colors focus-visible:outline-none',
                    "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:min-w-11 after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                    TONES[tone],
                    SIZES[size],
                    PHONE_SQUARE[size],
                ].join(' ')}
            >
                <CircleHelp aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">{label}</span>
            </button>
            {open ? (
                <HelpMenu
                    role={role}
                    onClose={() => setOpen(false)}
                    onChoose={(id) => {
                        chosen.current = id;
                        setOpen(false);
                    }}
                />
            ) : null}
        </>
    );
}

function HelpMenu({
    role,
    onClose,
    onChoose,
}: {
    role: TutorialRole;
    onClose: () => void;
    onChoose: (id: TutorialId) => void;
}) {
    const t = useTranslations();
    const tCommon = useTranslations('tutorial.common');
    const titleId = useId();
    const firstRef = useRef<HTMLButtonElement>(null);
    const tutorials = tutorialsForRole(role);

    return (
        <Modal open onClose={onClose} labelledById={titleId} size="sm" initialFocusRef={firstRef}>
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 id={titleId} className="text-base font-bold text-[var(--jale-ink)]">
                        {tCommon('help_title')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={tCommon('close')}
                        title={tCommon('close')}
                        className={[
                            // `Sheet`'s close recipe: a 40px box, a 44px pointer target.
                            '-mr-2 relative inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full',
                            'text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                        ].join(' ')}
                    >
                        <Icon name="x" />
                    </button>
                </div>
                <ul className="-mx-2 flex flex-col">
                    {tutorials.map((tutorial, index) => (
                        <li key={tutorial.id}>
                            <button
                                ref={index === 0 ? firstRef : undefined}
                                type="button"
                                onClick={() => onChoose(tutorial.id)}
                                className={[
                                    'flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-input)] px-2 py-2.5 text-left',
                                    'text-sm font-semibold text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)]',
                                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                ].join(' ')}
                            >
                                {t(`${tutorial.namespace}.${tutorial.titleKey}`)}
                                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--jale-ink-2)]" />
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </Modal>
    );
}
