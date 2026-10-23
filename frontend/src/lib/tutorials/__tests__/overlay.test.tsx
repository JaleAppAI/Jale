import { StrictMode, useEffect, useState } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayPresenceProvider, useOverlayPresence, useOverlayRegistry, type OverlayRegistry } from '../overlay';

/*
 * The overlay coordinator: every overlay reports whether it is open, and a
 * tutorial auto-opens only when nothing is. Presence is a set of per-overlay
 * tokens, so registering twice (a re-render, React's development double
 * effects) changes nothing, and it is registered in the LAYOUT phase, so an
 * effect in the same commit already sees an overlay that just opened.
 */

let registry: OverlayRegistry | null = null;

function keep(value: OverlayRegistry | null) {
    registry = value;
}

function RegistryProbe({ onValue = keep }: { onValue?: (value: OverlayRegistry | null) => void }) {
    onValue(useOverlayRegistry());
    return null;
}

function Overlay({ open }: { open: boolean }) {
    useOverlayPresence(open);
    return open ? <div role="dialog">overlay</div> : null;
}

function present(): boolean {
    if (!registry) throw new Error('no registry');
    return registry.isPresent();
}

describe('overlay presence', () => {
    it('reports an overlay while it is open, and none once it closes', () => {
        const { rerender } = render(
            <OverlayPresenceProvider>
                <RegistryProbe />
                <Overlay open={false} />
            </OverlayPresenceProvider>,
        );
        expect(present()).toBe(false);

        rerender(
            <OverlayPresenceProvider>
                <RegistryProbe />
                <Overlay open />
            </OverlayPresenceProvider>,
        );
        expect(present()).toBe(true);

        rerender(
            <OverlayPresenceProvider>
                <RegistryProbe />
                <Overlay open={false} />
            </OverlayPresenceProvider>,
        );
        expect(present()).toBe(false);
    });

    it('stays present until every open overlay has closed', () => {
        const view = (a: boolean, b: boolean) => (
            <OverlayPresenceProvider>
                <RegistryProbe />
                <Overlay open={a} />
                <Overlay open={b} />
            </OverlayPresenceProvider>
        );
        const { rerender } = render(view(true, true));

        rerender(view(false, true));
        expect(present()).toBe(true);

        rerender(view(false, false));
        expect(present()).toBe(false);
    });

    it('counts an overlay that unmounts while open as gone', () => {
        const { rerender } = render(
            <OverlayPresenceProvider>
                <RegistryProbe />
                <Overlay open />
            </OverlayPresenceProvider>,
        );
        expect(present()).toBe(true);

        rerender(
            <OverlayPresenceProvider>
                <RegistryProbe />
            </OverlayPresenceProvider>,
        );
        expect(present()).toBe(false);
    });

    it('is not confused by the development double effects', () => {
        const { rerender } = render(
            <StrictMode>
                <OverlayPresenceProvider>
                    <RegistryProbe />
                    <Overlay open />
                </OverlayPresenceProvider>
            </StrictMode>,
        );
        expect(present()).toBe(true);

        rerender(
            <StrictMode>
                <OverlayPresenceProvider>
                    <RegistryProbe />
                    <Overlay open={false} />
                </OverlayPresenceProvider>
            </StrictMode>,
        );
        expect(present()).toBe(false);
    });

    it('is visible to an effect in the same commit that opened the overlay', () => {
        const seen: boolean[] = [];

        function SameCommitReader({ open }: { open: boolean }) {
            const reg = useOverlayRegistry();
            useEffect(() => {
                if (open) seen.push(reg?.isPresent() ?? false);
            }, [open, reg]);
            return null;
        }

        function Page() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <SameCommitReader open={open} />
                    <Overlay open={open} />
                    <button type="button" onClick={() => setOpen(true)}>
                        open
                    </button>
                </>
            );
        }

        const { getByRole } = render(
            <OverlayPresenceProvider>
                <Page />
            </OverlayPresenceProvider>,
        );
        act(() => getByRole('button').click());

        // The reader's effect runs BEFORE the overlay's in tree order, and
        // still sees it: presence lands in the layout phase.
        expect(seen).toEqual([true]);
    });
});

describe('without a provider', () => {
    it('useOverlayPresence does nothing and does not throw', () => {
        const { rerender, result } = renderHook(({ open }: { open: boolean }) => useOverlayPresence(open), {
            initialProps: { open: true },
        });
        rerender({ open: false });

        expect(result.current).toBeUndefined();
    });

    it('there is no registry to read', () => {
        const { result } = renderHook(() => useOverlayRegistry());

        expect(result.current).toBeNull();
    });
});
