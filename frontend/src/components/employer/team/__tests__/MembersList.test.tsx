// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { MembersList } from '../MembersList';
import { ANA, BETO, CARLA, OWNER } from './fixtures';

function rows(): HTMLElement[] {
    return screen.getAllByRole('listitem');
}

describe('MembersList', () => {
    it('lists the owner first, then foremen by joinedAt', () => {
        renderIntl(<MembersList members={[ANA, OWNER, CARLA, BETO]} onRemove={vi.fn()} />);
        const names = rows().map((row) => within(row).getByTestId('member-name').textContent);
        // Beto joined 09-02, Carla 09-05, Ana 09-10.
        expect(names).toEqual([OWNER.name, BETO.name, CARLA.name, ANA.name]);
    });

    it('no Remove button on the owner row', () => {
        renderIntl(<MembersList members={[OWNER, ANA]} onRemove={vi.fn()} />);
        const [ownerRow, anaRow] = rows();
        expect(within(ownerRow).queryByRole('button', { name: message('employer_team.members.remove') })).toBeNull();
        expect(within(anaRow).getByRole('button', { name: message('employer_team.members.remove') })).toBeInTheDocument();
    });

    it('shows role and suspended badges and each foreman\'s open-jobs count', () => {
        renderIntl(<MembersList members={[OWNER, ANA, CARLA]} onRemove={vi.fn()} />);
        const [ownerRow, carlaRow, anaRow] = rows();
        expect(within(ownerRow).getByText(message('employer_team.members.owner'))).toBeInTheDocument();
        expect(within(anaRow).getByText(message('employer_team.members.foreman'))).toBeInTheDocument();
        expect(within(anaRow).queryByText(message('employer_team.members.suspended'))).toBeNull();
        expect(within(carlaRow).getByText(message('employer_team.members.suspended'))).toBeInTheDocument();
        expect(within(anaRow).getByText('2 open jobs')).toBeInTheDocument();
        expect(within(carlaRow).getByText('0 open jobs')).toBeInTheDocument();
        // The owner row carries no job count: it is never removed.
        expect(within(ownerRow).queryByText(/open job/)).toBeNull();
    });

    it('marks the signed-in owner as "You"', () => {
        renderIntl(<MembersList members={[OWNER, ANA]} currentUserId={OWNER.userId} onRemove={vi.fn()} />);
        const [ownerRow, anaRow] = rows();
        expect(within(ownerRow).getByText(message('employer_team.members.you'))).toBeInTheDocument();
        expect(within(anaRow).queryByText(message('employer_team.members.you'))).toBeNull();
    });

    it('Remove hands the row\'s member to onRemove and is described by the member\'s name', () => {
        const onRemove = vi.fn();
        renderIntl(<MembersList members={[OWNER, ANA]} onRemove={onRemove} />);
        const button = within(rows()[1]).getByRole('button', { name: message('employer_team.members.remove') });
        expect(button).toHaveAccessibleDescription(ANA.name);
        fireEvent.click(button);
        expect(onRemove).toHaveBeenCalledWith(ANA);
    });

    it('renders the Spanish copy', () => {
        renderIntl(<MembersList members={[OWNER, ANA]} onRemove={vi.fn()} />, 'es');
        expect(screen.getByText(message('employer_team.members.title', 'es'))).toBeInTheDocument();
        expect(screen.getByText('Propietario')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Quitar' })).toBeInTheDocument();
        expect(screen.getByText('2 empleos abiertos')).toBeInTheDocument();
    });
});
