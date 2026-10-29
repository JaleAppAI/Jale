// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { RemoveMemberDialog } from '../RemoveMemberDialog';
import { ANA, BETO, CARLA, DIEGO, OWNER, member } from './fixtures';

const MEMBERS = [OWNER, ANA, BETO, CARLA, DIEGO];

function picker(): HTMLSelectElement {
    return screen.getByLabelText(message('employer_team.remove.reassign_label'));
}

function renderDialog(props: Partial<Parameters<typeof RemoveMemberDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = renderIntl(
        <RemoveMemberDialog
            open
            member={ANA}
            members={MEMBERS}
            pending={false}
            error={null}
            onCancel={onCancel}
            onConfirm={onConfirm}
            {...props}
        />,
    );
    return { ...view, onConfirm, onCancel };
}

describe('RemoveMemberDialog', () => {
    it('the picker excludes the target, suspended and billing-suspended members and defaults to the owner; confirm sends reassignTo', () => {
        const { onConfirm } = renderDialog();
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText(interpolate(message('employer_team.remove.title'), { name: ANA.name }))).toBeInTheDocument();

        const values = Array.from(picker().options).map((o) => o.value);
        expect(values).toEqual([OWNER.userId, BETO.userId]);
        expect(picker().value).toBe(OWNER.userId);

        fireEvent.click(screen.getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(onConfirm).toHaveBeenLastCalledWith(OWNER.userId);

        fireEvent.change(picker(), { target: { value: BETO.userId } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(onConfirm).toHaveBeenLastCalledWith(BETO.userId);
    });

    it('explains that jobs and conversations move to the person chosen, and that access ends at once', () => {
        renderDialog();
        expect(screen.getByText(message('employer_team.remove.body'))).toBeInTheDocument();
        expect(screen.getByText(message('employer_team.remove.access'))).toBeInTheDocument();
    });

    it('names how many open jobs move, to the person picked', () => {
        renderDialog();
        expect(screen.getByText(`2 open jobs will move to ${OWNER.name}.`)).toBeInTheDocument();
        expect(picker()).toHaveAccessibleDescription(`2 open jobs will move to ${OWNER.name}.`);
        fireEvent.change(picker(), { target: { value: BETO.userId } });
        expect(screen.getByText(`2 open jobs will move to ${BETO.name}.`)).toBeInTheDocument();
        expect(screen.queryByText(/will move to Olga/)).toBeNull();
    });

    it('one open job reads in the singular; none shows no line', () => {
        const view = renderDialog({ member: BETO });
        expect(screen.getByText(`1 open job will move to ${OWNER.name}.`)).toBeInTheDocument();
        view.unmount();
        renderDialog({ member: member({ userId: 'fm-idle', name: 'Idle Foreman', openJobs: 0 }) });
        expect(screen.queryByText(/will move to/)).toBeNull();
    });

    it('the Spanish jobs-moved line', () => {
        renderIntl(
            <RemoveMemberDialog open member={ANA} members={MEMBERS} pending={false} error={null} onCancel={vi.fn()} onConfirm={vi.fn()} />,
            'es',
        );
        expect(screen.getByText(`2 empleos abiertos pasarán a ${OWNER.name}.`)).toBeInTheDocument();
        expect(screen.getByText(message('employer_team.remove.access', 'es'))).toBeInTheDocument();
    });

    it('while the request is pending the picker, Cancel and Confirm are disabled', () => {
        const { onConfirm, onCancel } = renderDialog({ pending: true });
        expect(picker()).toBeDisabled();
        expect(screen.getByRole('button', { name: message('employer_team.remove.cancel') })).toBeDisabled();
        expect(screen.getByRole('button', { name: message('employer_team.remove.confirm') })).toBeDisabled();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCancel).not.toHaveBeenCalled();
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('an error is announced and describes the picker', () => {
        renderDialog({ error: 'That person can\'t take these jobs.' });
        expect(screen.getByRole('alert')).toHaveTextContent('That person can\'t take these jobs.');
        expect(picker()).toHaveAccessibleDescription(expect.stringContaining('That person can\'t take these jobs.'));
    });

    it('falls back to the owner when the chosen person leaves the list after a refetch', () => {
        const { rerender, onConfirm } = renderDialog();
        fireEvent.change(picker(), { target: { value: BETO.userId } });
        rerender(
            <RemoveMemberDialog
                open
                member={ANA}
                members={[OWNER, ANA, { ...BETO, status: 'suspended' }]}
                pending={false}
                error={null}
                onCancel={vi.fn()}
                onConfirm={onConfirm}
            />,
        );
        expect(picker().value).toBe(OWNER.userId);
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(onConfirm).toHaveBeenLastCalledWith(OWNER.userId);
    });

    it('Cancel closes when not pending', () => {
        const { onCancel } = renderDialog();
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.remove.cancel') }));
        expect(onCancel).toHaveBeenCalled();
    });
});
