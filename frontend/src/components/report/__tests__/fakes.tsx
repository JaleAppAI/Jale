import { useEffect } from 'react';
import type { ScreenshotEditorProps } from '../seams/report-capture';

/**
 * Stand-in for the hide-an-area editor, behind the capture seam. It exposes the
 * editor's outputs as plain buttons -- a repaint starting, a repaint finishing
 * with a new image, and Remove -- and prints the labels it was handed, so the
 * flow's side of the contract can be tested without a canvas.
 *
 * Not a `.test.` file, so vitest collects it as a helper rather than a suite.
 */
export const PAINTED_IMAGE_SIZE = 77;

/**
 * The callbacks of every editor mounted so far, oldest first, keyed by the
 * size of the image it was handed -- so a test can make an editor that has
 * since been replaced call back late, as a real repaint finishing after an
 * unmount would.
 */
export const mountedEditors: Array<{ size: number; onChange: ScreenshotEditorProps['onChange']; onBusyChange: ScreenshotEditorProps['onBusyChange'] }> = [];

export function FakeScreenshotEditor({ image, onChange, onBusyChange, labels }: ScreenshotEditorProps) {
    useEffect(() => {
        mountedEditors.push({ size: image.size, onChange, onBusyChange });
    }, [image, onChange, onBusyChange]);
    return (
        <div data-testid="fake-editor" data-image-size={image.size}>
            <p>{labels.previewAlt}</p>
            <p>{labels.maskedNote}</p>
            <p data-testid="fake-editor-box-label">{labels.boxLabel}</p>
            <button type="button" onClick={() => onBusyChange(true)}>
                fake: start painting
            </button>
            <button
                type="button"
                onClick={() => {
                    onChange(new Blob([new Uint8Array(PAINTED_IMAGE_SIZE)], { type: 'image/jpeg' }));
                    onBusyChange(false);
                }}
            >
                fake: finish painting
            </button>
            <button type="button" onClick={() => onChange(null)}>
                {labels.remove}
            </button>
        </div>
    );
}
