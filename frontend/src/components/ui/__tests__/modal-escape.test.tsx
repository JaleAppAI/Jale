import { useState } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import { LocationPicker } from '../LocationPicker';
import { Modal } from '../modal';

/*
 * Escape in a dialog that holds a control with a list of its own: the key
 * closes the open list first, and the dialog (with the form typed into it)
 * only on the next Escape. The dialog listens in the capture phase, ahead of
 * the control's own handler, so it asks whether the key is the list's.
 */

vi.mock('@/lib/location-search', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/location-search')>()),
    queryLocations: vi.fn().mockResolvedValue([
        {
            label: 'Hayward, CA',
            cityKey: 'hayward-ca',
            zip: '94541',
            city: 'Hayward',
            state: 'CA',
            latitude: 37.67,
            longitude: -122.08,
            source: 'geocoded_zip',
        },
    ]),
}));

function Wizard({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
    const [city, setCity] = useState('');
    return (
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            <Modal open onClose={onClose} title="Post a Job">
                <LocationPicker value={city} onChange={(value) => setCity(value.label)} />
                {children}
            </Modal>
        </NextIntlClientProvider>
    );
}

const escape = (element: Element) =>
    act(() => {
        fireEvent.keyDown(element, { key: 'Escape' });
    });

describe('Modal and Escape for an open list', () => {
    it('closes the open suggestions and keeps the dialog; the next Escape closes the dialog', async () => {
        const onClose = vi.fn();
        render(<Wizard onClose={onClose} />);
        const city = screen.getByRole('combobox');
        act(() => city.focus());
        fireEvent.change(city, { target: { value: 'Hay' } });
        await waitFor(() => expect(city).toHaveAttribute('aria-expanded', 'true'));
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        escape(city);
        expect(onClose).not.toHaveBeenCalled();
        expect(city).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(screen.getByRole('dialog', { name: 'Post a Job' })).toBeInTheDocument();

        escape(city);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a disclosure open in the dialog has no Escape of its own: Escape closes the dialog', () => {
        const onClose = vi.fn();
        render(
            <Wizard onClose={onClose}>
                <button type="button" aria-expanded="true" aria-controls="more">
                    More options
                </button>
                <div id="more">Options</div>
            </Wizard>,
        );
        const disclosure = screen.getByRole('button', { name: 'More options' });
        act(() => disclosure.focus());
        escape(disclosure);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
