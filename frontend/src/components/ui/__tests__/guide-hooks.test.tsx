import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { CheckboxCard } from '../checkbox-card';
import { DashboardPanel } from '../dashboard-panel';
import { InlineFeedback } from '../inline-feedback';
import { LocationPicker } from '../LocationPicker';
import { Modal } from '../modal';
import { OptionGrid } from '@/components/worker/onboarding/OptionGrid';

/*
 * The step-by-step guides find their controls by `data-guide`
 * (`components/tutorials/spotlight`). The primitives that did not pass extra
 * attributes through take it as a prop and put it on their outer element, so
 * a flow marks a control without editing the primitive.
 */

function intl(node: ReactNode) {
    return render(
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            {node}
        </NextIntlClientProvider>,
    );
}

describe('data-guide on the primitives', () => {
    it('LocationPicker: on its outer element, with `data-picked` only for a picked value', () => {
        const { rerender } = intl(<LocationPicker value="Hayward, CA" onChange={vi.fn()} data-guide="f.city" />);
        const root = document.querySelector('[data-guide="f.city"]');
        expect(root?.contains(screen.getByRole('combobox'))).toBe(true);
        expect(root).not.toHaveAttribute('data-picked');

        rerender(
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                <LocationPicker value="Hayward, CA" onChange={vi.fn()} data-guide="f.city" picked />
            </NextIntlClientProvider>,
        );
        expect(document.querySelector('[data-guide="f.city"]')).toHaveAttribute('data-picked');
    });

    it('OptionGrid: on the group', () => {
        intl(
            <OptionGrid
                options={[{ value: 'a', label: 'A' }]}
                value={null}
                onChange={vi.fn()}
                data-guide="f.trade"
            />,
        );
        expect(screen.getByRole('group')).toHaveAttribute('data-guide', 'f.trade');
    });

    it('CheckboxCard: on the card, which holds the checkbox', () => {
        intl(<CheckboxCard checked={false} label="Day" onChange={vi.fn()} data-guide="f.day" />);
        expect(document.querySelector('[data-guide="f.day"]')?.contains(screen.getByRole('checkbox'))).toBe(true);
    });

    it('DashboardPanel: on the panel', () => {
        intl(
            <DashboardPanel as="div" data-guide="f.panel">
                Panel
            </DashboardPanel>,
        );
        expect(screen.getByText('Panel')).toHaveAttribute('data-guide', 'f.panel');
    });

    it('InlineFeedback: on the banner', () => {
        intl(
            <InlineFeedback tone="danger" data-guide="f.error">
                Something to fix
            </InlineFeedback>,
        );
        expect(screen.getByRole('alert')).toHaveAttribute('data-guide', 'f.error');
    });

    it('Modal: on the panel and on the pinned footer', () => {
        intl(
            <Modal open onClose={vi.fn()} title="Post a Job" data-guide="f.wizard" footerGuide="f.footer" footer={<button type="button">Next</button>}>
                <p>Body</p>
            </Modal>,
        );
        expect(screen.getByRole('dialog')).toHaveAttribute('data-guide', 'f.wizard');
        expect(document.querySelector('[data-guide="f.footer"]')?.contains(screen.getByRole('button', { name: 'Next' }))).toBe(true);
    });

    it('none of them renders the attribute when it is not given', () => {
        intl(
            <>
                <LocationPicker value="" onChange={vi.fn()} />
                <DashboardPanel>Panel</DashboardPanel>
            </>,
        );
        expect(document.querySelector('[data-guide]')).toBeNull();
        expect(document.querySelector('[data-picked]')).toBeNull();
    });
});

describe('Modal and an Escape a layer above it handled', () => {
    it('does not close on an Escape already marked handled, and still closes on a plain one', () => {
        const onClose = vi.fn();
        intl(
            <Modal open onClose={onClose} title="Post a Job">
                <input aria-label="City" />
            </Modal>,
        );
        const mark = (event: KeyboardEvent) => {
            if (event.key === 'Escape') event.preventDefault();
        };
        window.addEventListener('keydown', mark, true);
        screen.getByLabelText('City').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        window.removeEventListener('keydown', mark, true);
        expect(onClose).not.toHaveBeenCalled();

        screen.getByLabelText('City').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
