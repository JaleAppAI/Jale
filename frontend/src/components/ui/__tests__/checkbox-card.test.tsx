// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckboxCard } from '@/components/ui/checkbox-card';

/*
 * The card's checkbox is visually hidden, so a keyboard user sees focus only
 * if the card shows it. `focusRing` (additive) draws the app's focus shadow on
 * the card while its checkbox has keyboard focus; without it the card renders
 * exactly as before.
 */
const RING = 'has-[:focus-visible]:shadow-[var(--shadow-focus)]';

function card(props: Partial<Parameters<typeof CheckboxCard>[0]> = {}) {
    render(<CheckboxCard checked={false} label="Day" onChange={vi.fn()} {...props} />);
    return screen.getByRole('checkbox', { name: 'Day' }).closest('label') as HTMLLabelElement;
}

describe('CheckboxCard focus ring', () => {
    it('shows the focus shadow on an unchecked card when asked to', () => {
        const label = card({ focusRing: true } as never);
        expect(label.className).toContain(RING);
        // An inline "none" would beat the class; it is left out.
        expect(label.style.boxShadow).toBe('');
    });

    it('renders exactly as before without the prop', () => {
        const label = card();
        expect(label.className).not.toContain(RING);
        expect(label.style.boxShadow).toBe('none');
    });
});
