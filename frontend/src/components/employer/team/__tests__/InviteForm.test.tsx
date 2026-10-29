// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { InviteForm } from '../InviteForm';
import type { TeamActionResult } from '../types';

function emailInput(): HTMLInputElement {
    return screen.getByLabelText(message('employer_team.invite.email'));
}
function nameInput(): HTMLInputElement {
    return screen.getByLabelText(message('employer_team.invite.name'));
}
function submit() {
    fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
}
async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function sendButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: message('employer_team.invite.submit') });
}

afterEach(() => {
    vi.useRealTimers();
});

describe('InviteForm', () => {
    it('sends the trimmed email and name, then clears the form on success', async () => {
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: true });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: '  dana@example.com ' } });
        fireEvent.change(nameInput(), { target: { value: ' Dana ' } });
        submit();
        await flush();
        expect(onInvite).toHaveBeenCalledWith({ email: 'dana@example.com', contactName: 'Dana' });
        expect(emailInput().value).toBe('');
        expect(nameInput().value).toBe('');
    });

    it('a blank name is left out', async () => {
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: true });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        submit();
        await flush();
        expect(onInvite).toHaveBeenCalledWith({ email: 'dana@example.com' });
    });

    it('a blank email is refused on the client, linked to the input and focused', async () => {
        const onInvite = vi.fn();
        renderIntl(<InviteForm onInvite={onInvite} />);
        submit();
        await flush();
        expect(onInvite).not.toHaveBeenCalled();
        const msg = message('employer_team.errors.invalid_email');
        expect(screen.getByRole('alert')).toHaveTextContent(msg);
        expect(emailInput()).toHaveAccessibleDescription(msg);
        expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
        expect(document.activeElement).toBe(emailInput());
    });

    it('an email refusal marks and describes only the email; the values are kept', async () => {
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: false, message: 'Email in use.', code: 'email_in_use' });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        submit();
        await flush();
        expect(screen.getByRole('alert')).toHaveTextContent('Email in use.');
        expect(emailInput()).toHaveAccessibleDescription('Email in use.');
        expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
        expect(nameInput()).not.toHaveAttribute('aria-invalid');
        expect(nameInput()).toHaveAccessibleDescription('');
        expect(emailInput().value).toBe('dana@example.com');
    });

    it('invalid_contact_name marks and describes only the name', async () => {
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: false, message: 'Too long.', code: 'invalid_contact_name' });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        fireEvent.change(nameInput(), { target: { value: 'Dana' } });
        submit();
        await flush();
        expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
        expect(nameInput()).toHaveAccessibleDescription('Too long.');
        expect(emailInput()).not.toHaveAttribute('aria-invalid');
        expect(emailInput()).toHaveAccessibleDescription('');
    });

    it('a refusal about neither field (busy) describes both and marks neither', async () => {
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: false, message: 'Busy.', code: 'busy' });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        submit();
        await flush();
        expect(emailInput()).toHaveAccessibleDescription('Busy.');
        expect(nameInput()).toHaveAccessibleDescription('Busy.');
        expect(emailInput()).not.toHaveAttribute('aria-invalid');
        expect(nameInput()).not.toHaveAttribute('aria-invalid');
    });

    it('a rate limit disables Send for retryAfterSeconds and keeps the error visible meanwhile', async () => {
        vi.useFakeTimers();
        const onInvite = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({
            ok: false,
            message: 'Too many invites.',
            code: 'invite_rate_limited',
            retryAfterSeconds: 30,
        });
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        submit();
        await flush();
        expect(sendButton()).toBeDisabled();
        expect(screen.getByRole('alert')).toHaveTextContent('Too many invites.');
        // No dismiss while the wait lasts.
        expect(screen.queryByRole('button', { name: message('common.feedback.dismiss') })).toBeNull();
        act(() => { vi.advanceTimersByTime(29_000); });
        expect(sendButton()).toBeDisabled();
        expect(screen.getByRole('alert')).toHaveTextContent('Too many invites.');
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(sendButton()).toBeEnabled();
        submit();
        await flush();
        expect(onInvite).toHaveBeenCalledTimes(2);
    });

    it('seats full: Send is disabled and the remedy is shown', () => {
        const onInvite = vi.fn();
        renderIntl(<InviteForm onInvite={onInvite} seatsFull />);
        const remedy = message('employer_team.invite.seats_full');
        expect(screen.getByText(remedy)).toBeInTheDocument();
        expect(remedy).toBe('All seats are in use. Remove a member or revoke an invite to free one.');
        expect(sendButton()).toBeDisabled();
        expect(sendButton()).toHaveAccessibleDescription(remedy);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        fireEvent.submit(emailInput().closest('form')!);
        expect(onInvite).not.toHaveBeenCalled();
    });

    it('the submit button is busy while the request runs and a second submit is ignored', async () => {
        let resolve!: (r: TeamActionResult) => void;
        const onInvite = vi.fn(() => new Promise<TeamActionResult>((r) => { resolve = r; }));
        renderIntl(<InviteForm onInvite={onInvite} />);
        fireEvent.change(emailInput(), { target: { value: 'dana@example.com' } });
        submit();
        submit();
        expect(onInvite).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: message('employer_team.invite.submit') })).toBeDisabled();
        await act(async () => { resolve({ ok: true }); });
        expect(screen.getByRole('button', { name: message('employer_team.invite.submit') })).toBeEnabled();
    });
});
