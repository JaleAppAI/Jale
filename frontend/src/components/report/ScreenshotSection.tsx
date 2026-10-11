'use client';

import { useCallback, useId, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ReportRole } from '@/lib/report/categories';
import { ScreenshotEditor, type ScreenshotEditorLabels } from './seams/report-capture';
import { roleNamespace } from './types';

/**
 * Full width on phones, and free to wrap: at 200% text, or in Spanish, a
 * label such as "Adjuntar una foto en su lugar" is wider than the sheet.
 */
const WRAPPING_BUTTON = 'w-full sm:w-auto !h-auto min-h-11 py-2.5 !whitespace-normal !leading-snug text-center';

/** The image types the intake accepts; anything else is refused before a redraw. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * What the screenshot area shows:
 * - `pending`: the capture is still drawing (Send waits for it);
 * - `editor`: an image -- the capture or an attached photo -- in the editor;
 * - `failed`: the capture did not work and nothing was chosen yet;
 * - `none`: the person chose to send no image.
 */
export type ScreenshotView =
    | { kind: 'pending' }
    | { kind: 'editor'; image: Blob; source: 'capture' | 'photo'; version: number }
    | { kind: 'failed' }
    | { kind: 'none' };

export type PhotoState = 'idle' | 'preparing' | 'error';

/**
 * Step 2's image: the capture taken on the tap (already masked), the
 * hide-an-area editor, and "Attach a photo" for a screenshot taken outside the
 * app. A photo never reaches the editor un-redrawn: the flow redraws it first,
 * which also drops its metadata.
 *
 * The file input has no `capture` attribute, so the phone offers the camera
 * AND the gallery -- a screenshot the person already took is in the gallery.
 */
export function ScreenshotSection({
    role,
    view,
    photo,
    onPhotoChosen,
    onContinueWithout,
    onEditorChange,
    onEditorBusyChange,
}: {
    role: ReportRole;
    view: ScreenshotView;
    photo: PhotoState;
    onPhotoChosen: (file: File) => void;
    onContinueWithout: () => void;
    /** Called with the version of the image the editor was handed. */
    onEditorChange: (version: number, image: Blob | null) => void;
    onEditorBusyChange: (version: number, busy: boolean) => void;
}) {
    const t = useTranslations('report_common');
    const tRole = useTranslations(roleNamespace(role));
    const headingId = useId();
    const inputRef = useRef<HTMLInputElement>(null);

    const labels = useMemo<ScreenshotEditorLabels>(
        () => ({
            previewAlt: tRole('editor.preview_alt'),
            maskedNote: tRole('editor.masked_note'),
            hideArea: t('editor.hide_area'),
            done: t('editor.done'),
            undo: t('editor.undo'),
            remove: t('editor.remove'),
            // Raw: the editor fills `{n}` in itself, per box.
            boxLabel: t.raw('editor.box_label') as string,
            keyboardHint: t('editor.keyboard_hint'),
            deleteBox: t('editor.delete_box'),
        }),
        [t, tRole],
    );

    // Stable per image, so an editor never sees its callbacks change under it.
    const version = view.kind === 'editor' ? view.version : -1;
    const editorChange = useCallback((painted: Blob | null) => onEditorChange(version, painted), [onEditorChange, version]);
    const editorBusyChange = useCallback((busy: boolean) => onEditorBusyChange(version, busy), [onEditorBusyChange, version]);

    const choosePhoto = () => inputRef.current?.click();
    const preparing = photo === 'preparing';

    const attachButton = (label: string) => (
        <Button type="button" variant="outline" onClick={choosePhoto} disabled={preparing} className={WRAPPING_BUTTON}>
            <ImagePlus aria-hidden="true" className="h-4 w-4" />
            {label}
        </Button>
    );

    return (
        <section aria-labelledby={headingId} className="space-y-3">
            <h3 id={headingId} className="text-sm font-semibold text-[var(--jale-ink)]">
                {t('screenshot_heading')}
            </h3>

            {/* Opened by the buttons below; kept out of the tab order and the
                accessibility tree so it is not a second, unlabeled control. */}
            <input
                ref={inputRef}
                type="file"
                accept={PHOTO_ACCEPT}
                data-testid="report-photo-input"
                tabIndex={-1}
                aria-hidden="true"
                className="sr-only"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Cleared, so choosing the same file again still fires.
                    event.target.value = '';
                    if (file) onPhotoChosen(file);
                }}
            />

            {view.kind === 'pending' ? (
                <p role="status" className="flex items-center gap-2 text-sm text-[var(--jale-ink-2)]">
                    <Spinner />
                    {t('capture_pending')}
                </p>
            ) : null}

            {view.kind === 'editor' ? (
                <div className="space-y-3">
                    {view.source === 'capture' ? (
                        <p className="text-sm text-[var(--jale-ink-2)]">{tRole('masked_note')}</p>
                    ) : null}
                    <ScreenshotEditor
                        key={view.version}
                        image={view.image}
                        onChange={editorChange}
                        onBusyChange={editorBusyChange}
                        labels={labels}
                    />
                    {attachButton(t('attach_photo_instead'))}
                </div>
            ) : null}

            {view.kind === 'failed' ? (
                <div className="space-y-3 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-4 py-3">
                    <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('capture_failed_title')}</p>
                    <p className="text-sm text-[var(--jale-ink-2)]">{tRole('capture_failed_body')}</p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        {attachButton(t('attach_photo'))}
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onContinueWithout}
                            disabled={preparing}
                            className={WRAPPING_BUTTON}
                        >
                            {t('continue_without_image')}
                        </Button>
                    </div>
                </div>
            ) : null}

            {view.kind === 'none' ? (
                <div className="space-y-3">
                    <p className="text-sm text-[var(--jale-ink-2)]">{t('no_image')}</p>
                    {attachButton(t('attach_photo'))}
                </div>
            ) : null}

            {preparing ? (
                <p role="status" className="flex items-center gap-2 text-sm text-[var(--jale-ink-2)]">
                    <Spinner />
                    {t('photo_preparing')}
                </p>
            ) : null}
            {photo === 'error' ? (
                <p role="alert" className="text-sm font-medium text-[var(--jale-danger-text)]">
                    {tRole('photo_error')}
                </p>
            ) : null}
        </section>
    );
}
