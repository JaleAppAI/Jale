'use client';

import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from 'react';
import { Check, EyeOff, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { decodeImage, MAX_IMAGE_EDGE, REDRAW_JPEG_QUALITY, renderJpeg, type DecodedImage } from '@/lib/report/capture/encode';
import {
    defaultArea,
    keyStep,
    moveArea,
    resizeArea,
    sameRect,
    spanArea,
    type HiddenArea,
    type Rect,
} from './box-geometry';
import { HiddenAreaBox, areaStyle } from './HiddenAreaBox';

export interface ScreenshotEditorLabels {
    previewAlt: string;
    maskedNote: string;
    hideArea: string;
    done: string;
    undo: string;
    remove: string;
    /** Contains `{n}`, which the editor fills in. */
    boxLabel: string;
    keyboardHint: string;
    deleteBox: string;
}

export interface ScreenshotEditorProps {
    image: Blob;
    onChange: (image: Blob | null) => void;
    onBusyChange: (busy: boolean) => void;
    labels: ScreenshotEditorLabels;
}

/** A pointer moved less than this (screen pixels) is a tap, not a drag. */
const TAP_SLOP = 6;

type Gesture =
    | { kind: 'draw'; pointerId: number; startX: number; startY: number; from: { x: number; y: number } }
    | { kind: 'move' | 'resize'; pointerId: number; startX: number; startY: number; area: HiddenArea };

type Draft = { kind: 'draw'; rect: Rect } | { kind: 'move' | 'resize'; id: number; rect: Rect } | null;

function fillBoxLabel(template: string, n: number): string {
    return template.split('{n}').join(String(n));
}

/**
 * Paints the hidden areas into the image and emits the result. There is no
 * unapplied state: every finished change is painted and emitted; `busy` is
 * true from the start of a change until its image is emitted; while any area
 * exists only painted images are emitted. Changes made during a paint are
 * folded into one more paint of the latest state. If a paint fails the image
 * is removed (`null`) rather than left uncovered.
 *
 * A change in progress (a drag) is HELD: a paint of an earlier change that
 * lands meanwhile is still emitted, so what was finished is never lost, but
 * busy stays on until the held change ends, because the area being dragged is
 * not in that image.
 */
function usePainter(image: Blob, decoded: { current: Promise<DecodedImage> | null }, props: ScreenshotEditorProps) {
    const latest = useRef(props);
    useLayoutEffect(() => {
        latest.current = props;
    });
    const busy = useRef(false);
    const generation = useRef(0);
    const queued = useRef<HiddenArea[] | null>(null);
    const running = useRef(false);
    const alive = useRef(true);
    const held = useRef(false);

    const setBusy = useCallback((next: boolean) => {
        if (busy.current === next) return;
        busy.current = next;
        latest.current.onBusyChange(next);
    }, []);

    const pump = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        try {
            while (queued.current && alive.current) {
                const areas = queued.current;
                queued.current = null;
                const mine = generation.current;
                let painted: Blob | null = null;
                try {
                    const source = await decoded.current;
                    if (!source) throw new Error('image_decode_failed');
                    painted = (await renderJpeg(source, { maxEdge: MAX_IMAGE_EDGE, quality: REDRAW_JPEG_QUALITY, boxes: areas })).blob;
                } catch {
                    painted = null;
                }
                if (!alive.current) return;
                // A newer change or a removal superseded this paint.
                if (mine !== generation.current || queued.current) continue;
                latest.current.onChange(painted);
                if (!held.current) setBusy(false);
                if (!painted) return;
            }
        } finally {
            running.current = false;
        }
    }, [decoded, setBusy]);

    /** The image is gone: nothing is sent, and any paint in flight is dropped. */
    const remove = useCallback(() => {
        held.current = false;
        generation.current += 1;
        queued.current = null;
        setBusy(false);
        latest.current.onChange(null);
    }, [setBusy]);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            generation.current += 1;
            queued.current = null;
            if (busy.current) {
                busy.current = false;
                latest.current.onBusyChange(false);
            }
        };
    }, []);

    return {
        /**
         * A change has started (a drag): hold Send until it is painted. Not a
         * new generation: a paint already running still emits its image.
         */
        hold: () => {
            held.current = true;
            setBusy(true);
        },
        /** A started change ended without changing anything. */
        letGo: () => {
            held.current = false;
            if (!running.current && !queued.current) setBusy(false);
        },
        paint: (areas: HiddenArea[]) => {
            held.current = false;
            generation.current += 1;
            if (areas.length === 0) {
                // Nothing is hidden: the image handed in is the image again.
                queued.current = null;
                latest.current.onChange(image);
                setBusy(false);
                return;
            }
            setBusy(true);
            queued.current = areas;
            void pump();
        },
        remove,
    };
}

function Editor(props: ScreenshotEditorProps) {
    const { image, labels } = props;
    const hintId = useId();
    const stageRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const areaRefs = useRef(new Map<number, HTMLDivElement>());
    const decoded = useRef<Promise<DecodedImage> | null>(null);
    const previewRef = useRef<HTMLImageElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const [hiding, setHiding] = useState(false);
    const [areas, setAreas] = useState<HiddenArea[]>([]);
    const [history, setHistory] = useState<HiddenArea[][]>([]);
    const [draft, setDraft] = useState<Draft>(null);
    /** Where focus goes after the next render: an area's id, or the drawing surface. */
    const focusNext = useRef<number | 'surface' | null>(null);
    const areasRef = useRef(areas);
    const historyRef = useRef(history);
    const nextId = useRef(1);
    const gesture = useRef<Gesture | null>(null);

    const painter = usePainter(image, decoded, props);
    const removeImage = painter.remove;

    // Set on the element rather than through state: the URL is created and
    // revoked by the same effect run, so a re-run never leaves a revoked URL.
    useLayoutEffect(() => {
        const url = URL.createObjectURL(image);
        if (previewRef.current) previewRef.current.src = url;
        return () => URL.revokeObjectURL(url);
    }, [image]);

    useEffect(() => {
        let current = true;
        const pending = decodeImage(image);
        decoded.current = pending;
        pending.then(
            (d) => {
                if (current) setSize({ w: d.width, h: d.height });
            },
            () => {
                // An image that cannot be decoded cannot be masked or checked:
                // it is removed, as after a failed repaint.
                if (current) removeImage();
            },
        );
        return () => {
            current = false;
            pending.then((d) => d.release(), () => {});
        };
    }, [image, removeImage]);

    useEffect(() => {
        const next = focusNext.current;
        if (next === null) return;
        focusNext.current = null;
        (next === 'surface' ? surfaceRef.current : areaRefs.current.get(next))?.focus();
    });

    const setFocusId = (next: number | 'surface') => {
        focusNext.current = next;
    };

    const commit = (next: HiddenArea[]) => {
        historyRef.current = [...historyRef.current, areasRef.current];
        areasRef.current = next;
        setHistory(historyRef.current);
        setAreas(next);
        painter.paint(next);
    };

    const addArea = (rect: Rect) => {
        const area = { ...rect, id: nextId.current++ };
        commit([...areasRef.current, area]);
        return area.id;
    };

    const replaceArea = (id: number, rect: Rect) => {
        commit(areasRef.current.map((a) => (a.id === id ? { ...rect, id } : a)));
    };

    const deleteArea = (id: number) => {
        commit(areasRef.current.filter((a) => a.id !== id));
    };

    const undo = () => {
        const past = historyRef.current;
        if (!past.length) return;
        const previous = past[past.length - 1];
        historyRef.current = past.slice(0, -1);
        areasRef.current = previous;
        setHistory(historyRef.current);
        setAreas(previous);
        painter.paint(previous);
    };

    /** Screen point -> image pixels, plus the scale of one screen pixel. */
    const toImage = (clientX: number, clientY: number) => {
        const stage = stageRef.current!.getBoundingClientRect();
        const sx = size!.w / (stage.width || 1);
        const sy = size!.h / (stage.height || 1);
        return { x: (clientX - stage.left) * sx, y: (clientY - stage.top) * sy, sx, sy };
    };

    const capture = (event: PointerEvent<Element>) => {
        const target = event.currentTarget as Element;
        if (typeof target.setPointerCapture === 'function') {
            try {
                target.setPointerCapture(event.pointerId);
            } catch {
                // The pointer is already gone; the gesture ends on its own.
            }
        }
    };

    const isPrimary = (event: PointerEvent<Element>) => event.pointerType !== 'mouse' || event.button === 0;

    const startDraw = (event: PointerEvent<HTMLDivElement>) => {
        if (!size || !isPrimary(event)) return;
        capture(event);
        const from = toImage(event.clientX, event.clientY);
        gesture.current = { kind: 'draw', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from };
        painter.hold();
    };

    const startOnArea = (kind: 'move' | 'resize', area: HiddenArea) => (event: PointerEvent<Element>) => {
        if (!size || !isPrimary(event)) return;
        capture(event);
        gesture.current = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, area };
        painter.hold();
    };

    const gestureRect = (g: Gesture, clientX: number, clientY: number): Rect => {
        const at = toImage(clientX, clientY);
        if (g.kind === 'draw') return spanArea(g.from.x, g.from.y, at.x, at.y, size!.w, size!.h);
        const dx = (clientX - g.startX) * at.sx;
        const dy = (clientY - g.startY) * at.sy;
        return g.kind === 'move'
            ? moveArea(g.area, dx, dy, size!.w, size!.h)
            : resizeArea(g.area, dx, dy, size!.w, size!.h);
    };

    const isTap = (g: Gesture, clientX: number, clientY: number) =>
        Math.hypot(clientX - g.startX, clientY - g.startY) < TAP_SLOP;

    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== event.pointerId || !size) return;
        if (isTap(g, event.clientX, event.clientY)) return;
        const rect = gestureRect(g, event.clientX, event.clientY);
        setDraft(g.kind === 'draw' ? { kind: 'draw', rect } : { kind: g.kind, id: g.area.id, rect });
    };

    const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== event.pointerId || !size) return;
        gesture.current = null;
        setDraft(null);
        if (g.kind === 'draw') {
            const rect = isTap(g, event.clientX, event.clientY)
                ? defaultArea(g.from.x, g.from.y, size.w, size.h)
                : gestureRect(g, event.clientX, event.clientY);
            setFocusId(addArea(rect));
            return;
        }
        const rect = isTap(g, event.clientX, event.clientY) ? g.area : gestureRect(g, event.clientX, event.clientY);
        if (sameRect(rect, g.area)) painter.letGo();
        else replaceArea(g.area.id, rect);
    };

    const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== event.pointerId) return;
        gesture.current = null;
        setDraft(null);
        painter.letGo();
    };

    const onSurfaceKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!size || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        // Each new area lands a step lower and to the right, so they do not stack exactly.
        const offset = keyStep(size.w, size.h) * 2 * areasRef.current.length;
        setFocusId(addArea(defaultArea(size.w / 2 + offset, size.h / 2 + offset, size.w, size.h)));
    };

    const onAreaKey = (area: HiddenArea) => (event: KeyboardEvent<HTMLDivElement>) => {
        if (!size) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteArea(area.id);
            setFocusId('surface');
            return;
        }
        const step = keyStep(size.w, size.h);
        const delta: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };
        const d = delta[event.key];
        if (!d) return;
        event.preventDefault();
        const rect = event.shiftKey
            ? resizeArea(area, d[0], d[1], size.w, size.h)
            : moveArea(area, d[0], d[1], size.w, size.h);
        if (!sameRect(rect, area)) replaceArea(area.id, rect);
    };

    const toggleHiding = () => {
        if (hiding) {
            setHiding(false);
            return;
        }
        setHiding(true);
        setFocusId('surface');
    };

    const shown = (area: HiddenArea): Rect =>
        draft && draft.kind !== 'draw' && draft.id === area.id ? draft.rect : area;

    return (
        <div className="space-y-3">
            <div className="flex justify-center">
                <div
                    ref={stageRef}
                    className="relative inline-block max-w-full select-none"
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    // Capture lost without a pointerup (the browser took the
                    // touch over): the gesture ends as a cancel, so busy clears.
                    onLostPointerCapture={onPointerCancel}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
                    <img
                        ref={previewRef}
                        alt={labels.previewAlt}
                        draggable={false}
                        className="block h-auto max-h-[60vh] w-auto max-w-full rounded-[var(--radius-input)] border border-[var(--jale-divider)]"
                    />
                    {hiding && size ? (
                        <div
                            ref={surfaceRef}
                            role="button"
                            tabIndex={0}
                            aria-label={labels.hideArea}
                            aria-describedby={hintId}
                            onPointerDown={startDraw}
                            onKeyDown={onSurfaceKey}
                            className="absolute inset-0 cursor-crosshair touch-none rounded-[var(--radius-input)] outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[var(--jale-blue-500)]"
                        />
                    ) : null}
                    {size
                        ? areas.map((area, index) =>
                              hiding ? (
                                  <HiddenAreaBox
                                      key={area.id}
                                      ref={(el) => {
                                          if (el) areaRefs.current.set(area.id, el);
                                          else areaRefs.current.delete(area.id);
                                      }}
                                      rect={shown(area)}
                                      imageWidth={size.w}
                                      imageHeight={size.h}
                                      label={fillBoxLabel(labels.boxLabel, index + 1)}
                                      deleteLabel={labels.deleteBox}
                                      hintId={hintId}
                                      onMoveStart={startOnArea('move', area)}
                                      onResizeStart={startOnArea('resize', area)}
                                      onKeyDown={onAreaKey(area)}
                                      onDelete={() => {
                                          deleteArea(area.id);
                                          setFocusId('surface');
                                      }}
                                  />
                              ) : (
                                  <div
                                      key={area.id}
                                      aria-hidden="true"
                                      data-hidden-area=""
                                      className="pointer-events-none absolute"
                                      style={areaStyle(area, size.w, size.h)}
                                  />
                              ),
                          )
                        : null}
                    {draft?.kind === 'draw' && size ? (
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute opacity-80 ring-2 ring-white/80"
                            style={areaStyle(draft.rect, size.w, size.h)}
                        />
                    ) : null}
                </div>
            </div>

            <p className="text-xs text-[var(--jale-ink-2)]">{labels.maskedNote}</p>
            {hiding ? (
                <p id={hintId} className="text-xs text-[var(--jale-ink-2)]">
                    {labels.keyboardHint}
                </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={toggleHiding} disabled={!size}>
                    {hiding ? <Check aria-hidden="true" className="h-4 w-4" /> : <EyeOff aria-hidden="true" className="h-4 w-4" />}
                    {hiding ? labels.done : labels.hideArea}
                </Button>
                <Button type="button" variant="ghost" onClick={undo} disabled={history.length === 0}>
                    <Undo2 aria-hidden="true" className="h-4 w-4" />
                    {labels.undo}
                </Button>
                <Button type="button" variant="ghost" onClick={() => painter.remove()}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                    {labels.remove}
                </Button>
            </div>
        </div>
    );
}

const imageKeys = new WeakMap<Blob, number>();
let lastImageKey = 0;
function keyFor(image: Blob): number {
    let key = imageKeys.get(image);
    if (key === undefined) {
        key = ++lastImageKey;
        imageKeys.set(image, key);
    }
    return key;
}

/**
 * The screenshot preview with "Hide an area". A drag
 * draws a box and a tap places one; boxes move and resize by pointer or
 * keyboard; Undo steps back; Remove drops the image (`onChange(null)`).
 * Every finished change is painted into a new JPEG and emitted, and the
 * uncovered image is never emitted while any box exists. A new `image`
 * starts a fresh editor.
 */
export function ScreenshotEditor(props: ScreenshotEditorProps) {
    return <Editor key={keyFor(props.image)} {...props} />;
}
