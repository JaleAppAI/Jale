// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { WorkerVaultDoc } from '@/lib/api/worker';
import { ToastProvider } from '@/components/ui/toast';
import { message, renderIntl, type TestLocale } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * One saved document in the worker's profile.
 *
 * Two things a worker on a phone needs: the buttons say what they do in words
 * at every width, not only as icons, and Delete asks before it deletes. The
 * question is asked inside the slot itself -- no dialog -- so nothing can
 * stack over it and the worker never loses their place in the list.
 */

const { deleteVaultDocument } = vi.hoisted(() => ({ deleteVaultDocument: vi.fn() }));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    deleteVaultDocument,
}));

import { DocumentSlot } from '../DocumentSlot';

const SAVED: WorkerVaultDoc = {
    id: 'v1',
    doc_type: 'driver_license',
    file_name: 'fake-license-file.jpg',
    file_size: 1024,
    uploaded_at: '2026-08-20T00:00:00.000Z',
    url: 'https://files.example.invalid/v1',
} as WorkerVaultDoc;

const d = (key: string, locale: TestLocale = 'en') => message(`worker_profile.documents.${key}`, locale);

function renderSlot(locale: TestLocale = 'en', onChange = vi.fn()) {
    const view = renderIntl(
        <ToastProvider>
            <DocumentSlot token="test-token" doc_type="driver_license" existing={SAVED} onChange={onChange} />
        </ToastProvider>,
        locale,
    );
    return { ...view, onChange };
}

beforeEach(() => {
    deleteVaultDocument.mockReset();
    deleteVaultDocument.mockResolvedValue(undefined);
});

describe('DocumentSlot — labels', () => {
    it('shows each action as words at every width, never as a hidden label', () => {
        const { container } = renderSlot();
        expect(screen.getByRole('link', { name: d('view') })).toHaveTextContent(d('view'));
        expect(screen.getByRole('button', { name: d('replace') })).toHaveTextContent(d('replace'));
        expect(screen.getByRole('button', { name: d('delete') })).toHaveTextContent(d('delete'));
        expect(container.querySelector('.sr-only')).toBeNull();
    });
});

describe('DocumentSlot — delete asks first', () => {
    it('does not delete on the first press, and asks in place', async () => {
        const user = userEvent.setup();
        renderSlot();

        await user.click(screen.getByRole('button', { name: d('delete') }));

        expect(deleteVaultDocument).not.toHaveBeenCalled();
        expect(screen.getByText(d('delete_confirm'))).toBeInTheDocument();
        // In place: the question is part of the page, not a dialog over it.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('deletes once the worker confirms', async () => {
        const user = userEvent.setup();
        const { onChange } = renderSlot();

        await user.click(screen.getByRole('button', { name: d('delete') }));
        const confirm = screen.getByRole('group', { name: d('delete_confirm') });
        await user.click(within(confirm).getByRole('button', { name: d('delete') }));

        expect(deleteVaultDocument).toHaveBeenCalledTimes(1);
        expect(deleteVaultDocument).toHaveBeenCalledWith('test-token', 'driver_license');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('keeps the document on Cancel and puts focus back on Delete', async () => {
        const user = userEvent.setup();
        renderSlot();

        await user.click(screen.getByRole('button', { name: d('delete') }));
        // The safe choice takes the focus while the question is open.
        expect(screen.getByRole('button', { name: d('delete_cancel') })).toHaveFocus();
        await user.click(screen.getByRole('button', { name: d('delete_cancel') }));

        expect(deleteVaultDocument).not.toHaveBeenCalled();
        expect(screen.queryByText(d('delete_confirm'))).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: d('delete') })).toHaveFocus();
    });

    it('asks in Spanish', async () => {
        const user = userEvent.setup();
        renderSlot('es');

        await user.click(screen.getByRole('button', { name: d('delete', 'es') }));

        expect(screen.getByText(d('delete_confirm', 'es'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: d('delete_cancel', 'es') })).toBeInTheDocument();
        expect(deleteVaultDocument).not.toHaveBeenCalled();
    });
});

/*
 * The question is about one document. If that document goes while it is
 * open -- deleted from another tab, or the list refetched without it -- the
 * question goes with it, so the next document saved here starts on the
 * ordinary actions rather than on "Delete this document?".
 */
describe('DocumentSlot — the question follows its document', () => {
    const LATER: WorkerVaultDoc = { ...SAVED, id: 'v2', file_name: 'fake-license-file-2.jpg' } as WorkerVaultDoc;

    function slot(existing?: WorkerVaultDoc) {
        return (
            <ToastProvider>
                <DocumentSlot token="test-token" doc_type="driver_license" existing={existing} onChange={vi.fn()} />
            </ToastProvider>
        );
    }

    it('closes when the document goes, and a later document opens on the ordinary actions', async () => {
        const user = userEvent.setup();
        const { rerender } = renderIntl(slot(SAVED));
        await user.click(screen.getByRole('button', { name: d('delete') }));
        expect(screen.getByRole('group', { name: d('delete_confirm') })).toBeInTheDocument();

        rerender(slot(undefined));
        expect(screen.queryByRole('group', { name: d('delete_confirm') })).toBeNull();

        rerender(slot(LATER));
        expect(screen.queryByRole('group', { name: d('delete_confirm') })).toBeNull();
        expect(screen.getByRole('button', { name: d('delete') })).toBeInTheDocument();
        expect(deleteVaultDocument).not.toHaveBeenCalled();
    });

    it('closes when the document is replaced while it is open', async () => {
        const user = userEvent.setup();
        const { rerender } = renderIntl(slot(SAVED));
        await user.click(screen.getByRole('button', { name: d('delete') }));

        rerender(slot(LATER));
        expect(screen.queryByRole('group', { name: d('delete_confirm') })).toBeNull();
    });

    it('stays open when the list is read again with the same document', async () => {
        const user = userEvent.setup();
        const { rerender } = renderIntl(slot(SAVED));
        await user.click(screen.getByRole('button', { name: d('delete') }));

        rerender(slot({ ...SAVED } as WorkerVaultDoc));
        expect(screen.getByRole('group', { name: d('delete_confirm') })).toBeInTheDocument();
    });

    it('puts focus on the upload button when the question closes under it', async () => {
        const user = userEvent.setup();
        const { rerender } = renderIntl(slot(SAVED));
        await user.click(screen.getByRole('button', { name: d('delete') }));
        expect(screen.getByRole('button', { name: d('delete_cancel') })).toHaveFocus();

        rerender(slot(undefined));
        expect(screen.getByRole('button', { name: d('upload') })).toHaveFocus();
    });
});
