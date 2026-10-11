'use client';

import { forwardRef, type KeyboardEvent, type PointerEvent } from 'react';
import { X } from 'lucide-react';
import { MASK_FILL } from '@/lib/report/capture/mask';
import type { Rect } from './box-geometry';

/** Percent position of an area over the preview, so it follows the preview's size. */
export function areaStyle(rect: Rect, width: number, height: number) {
    return {
        left: `${(rect.x / width) * 100}%`,
        top: `${(rect.y / height) * 100}%`,
        width: `${(rect.w / width) * 100}%`,
        height: `${(rect.h / height) * 100}%`,
        backgroundColor: MASK_FILL,
    };
}

/**
 * One hidden area while the hide mode is on: focusable, moved by dragging its
 * body or with the arrow keys, resized by its corner handle or Shift+arrows,
 * deleted by its button or the Delete key. The delete button and the handle
 * are 44px hit areas around a smaller visible mark.
 */
export const HiddenAreaBox = forwardRef<
    HTMLDivElement,
    {
        rect: Rect;
        imageWidth: number;
        imageHeight: number;
        label: string;
        deleteLabel: string;
        hintId: string;
        onMoveStart: (event: PointerEvent<HTMLDivElement>) => void;
        onResizeStart: (event: PointerEvent<HTMLSpanElement>) => void;
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
        onDelete: () => void;
    }
>(function HiddenAreaBox(
    { rect, imageWidth, imageHeight, label, deleteLabel, hintId, onMoveStart, onResizeStart, onKeyDown, onDelete },
    ref,
) {
    return (
        <div
            ref={ref}
            role="group"
            tabIndex={0}
            aria-label={label}
            aria-describedby={hintId}
            data-hidden-area=""
            onPointerDown={onMoveStart}
            onKeyDown={onKeyDown}
            style={areaStyle(rect, imageWidth, imageHeight)}
            className="absolute cursor-move touch-none outline-none ring-2 ring-white/80 focus-visible:ring-4 focus-visible:ring-[var(--jale-blue-500)]"
        >
            <button
                type="button"
                aria-label={deleteLabel}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onDelete}
                className="absolute -right-5 -top-5 flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] shadow">
                    <X aria-hidden="true" className="h-4 w-4" />
                </span>
            </button>
            <span
                aria-hidden="true"
                data-resize-handle=""
                onPointerDown={(event) => {
                    event.stopPropagation();
                    onResizeStart(event);
                }}
                className="absolute -bottom-5 -right-5 flex h-11 w-11 cursor-nwse-resize touch-none items-center justify-center"
            >
                <span className="h-4 w-4 rounded-sm border-2 border-white bg-[var(--jale-blue-500)] shadow" />
            </span>
        </div>
    );
});
