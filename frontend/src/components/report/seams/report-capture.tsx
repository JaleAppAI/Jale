'use client';

/**
 * The report flow's single import point for the in-page screenshot, the photo
 * redraw and the hide-an-area editor. The implementations are
 * `@/lib/report/capture` and `@/components/report/screenshot/ScreenshotEditor`.
 */

export { captureViewport, redrawImage, type CaptureResult } from '@/lib/report/capture';
export {
    ScreenshotEditor,
    type ScreenshotEditorProps,
    type ScreenshotEditorLabels,
} from '@/components/report/screenshot/ScreenshotEditor';
