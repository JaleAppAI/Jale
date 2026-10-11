// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * The one-time document link: Submit spends the link, so it may only run once
 * every chosen document has finished uploading -- a document still on its way
 * would never be confirmed, and the link could not take it afterwards. The
 * receipt lists what was stored, and only that. All values are fake.
 */

const api = vi.hoisted(() => ({
    getUploadUrl: vi.fn(),
    uploadFileToS3: vi.fn(),
    confirmUpload: vi.fn(),
    submitUpload: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'fake-token' }) }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    redirect: vi.fn(),
    usePathname: () => '/upload/fake-token',
}));
vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    ...api,
}));

import { renderIntl, message } from '@/components/worker/onboarding/__tests__/render-intl';
import { ApiError } from '@/lib/api/errors';
import UploadPage from '@/app/[locale]/upload/[token]/page';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.clearAllMocks();
    api.getUploadUrl.mockImplementation(async (_token: string, docType: string) => ({
        url: 'https://upload.example.invalid/put',
        s3_key: `incoming/fake-${docType}`,
    }));
    api.uploadFileToS3.mockResolvedValue(undefined);
    api.confirmUpload.mockResolvedValue(undefined);
    api.submitUpload.mockResolvedValue(undefined);
});

describe('upload page: submit', () => {
    it('stays off while a document is still uploading, then confirms every document and lists each on the receipt', async () => {
        const second = deferred();
        api.uploadFileToS3.mockResolvedValueOnce(undefined).mockImplementationOnce(() => second.promise);
        const { container } = renderIntl(<UploadPage />);
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');

        fireEvent.change(inputs[0], { target: { files: [new File(['a'], 'fake-resume.pdf', { type: 'application/pdf' })] } });
        await screen.findByText('fake-resume.pdf');
        fireEvent.change(inputs[1], { target: { files: [new File(['b'], 'fake-license.pdf', { type: 'application/pdf' })] } });

        const submit = screen.getByRole('button', { name: message('upload_page.submit') });
        await waitFor(() => expect(api.uploadFileToS3).toHaveBeenCalledTimes(2));
        expect(submit).toBeDisabled();
        fireEvent.click(submit);
        expect(api.confirmUpload).not.toHaveBeenCalled();
        expect(api.submitUpload).not.toHaveBeenCalled();

        second.resolve();
        await waitFor(() => expect(submit).toBeEnabled());
        fireEvent.click(submit);

        expect(await screen.findByText(message('upload_page.success_title'))).toBeInTheDocument();
        expect(api.confirmUpload.mock.calls.map((call) => call[2])).toEqual(['resume', 'driver_license']);
        expect(api.submitUpload).toHaveBeenCalledTimes(1);
        const receipt = screen.getByText('fake-resume.pdf').closest('[data-private]') as HTMLElement;
        expect(within(receipt).getByText('fake-license.pdf')).toBeInTheDocument();
    });

    it('never lists on the receipt a document the link did not store', async () => {
        // Submit pressed while the license is still on its way, then the
        // license finishes. Whatever the page does with that press, every name
        // on the receipt must be a document it confirmed.
        const second = deferred();
        api.uploadFileToS3.mockResolvedValueOnce(undefined).mockImplementationOnce(() => second.promise);
        const { container } = renderIntl(<UploadPage />);
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
        fireEvent.change(inputs[0], { target: { files: [new File(['a'], 'fake-resume.pdf', { type: 'application/pdf' })] } });
        await screen.findByText('fake-resume.pdf');
        fireEvent.change(inputs[1], { target: { files: [new File(['b'], 'fake-license.pdf', { type: 'application/pdf' })] } });
        await waitFor(() => expect(api.uploadFileToS3).toHaveBeenCalledTimes(2));

        fireEvent.click(screen.getByRole('button', { name: message('upload_page.submit') }));
        await act(async () => {
            second.resolve();
            await second.promise;
        });
        const submit = screen.queryByRole('button', { name: message('upload_page.submit') });
        if (submit) {
            // The press was refused while the license uploaded: submit now.
            await waitFor(() => expect(submit).toBeEnabled());
            fireEvent.click(submit);
        }

        expect(await screen.findByText(message('upload_page.success_title'))).toBeInTheDocument();
        const confirmed = api.confirmUpload.mock.calls.map((call) => (call[3] as File).name).sort();
        const receipt = screen.getByText('fake-resume.pdf').closest('[data-private]') as HTMLElement;
        const listed = within(receipt).getAllByText(/^fake-/).map((el) => el.textContent).sort();
        expect(listed).toEqual(confirmed);
    });

    /** Picks a resume and a license, and waits until Submit can be pressed. */
    async function chooseBoth(): Promise<HTMLElement> {
        const { container } = renderIntl(<UploadPage />);
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
        fireEvent.change(inputs[0], { target: { files: [new File(['a'], 'fake-resume.pdf', { type: 'application/pdf' })] } });
        await screen.findByText('fake-resume.pdf');
        fireEvent.change(inputs[1], { target: { files: [new File(['b'], 'fake-license.pdf', { type: 'application/pdf' })] } });
        await screen.findByText('fake-license.pdf');
        const submit = screen.getByRole('button', { name: message('upload_page.submit') });
        await waitFor(() => expect(submit).toBeEnabled());
        return submit;
    }

    it.each(['invalid_or_confirmed_upload', 'document_already_confirmed'])(
        'lists a document the link answered %s for as received before, never by the file chosen here',
        async (code) => {
            api.confirmUpload.mockImplementation(async (_token: string, _key: string, docType: string) => {
                if (docType === 'resume') throw new ApiError(409, code);
            });
            fireEvent.click(await chooseBoth());

            expect(await screen.findByText(message('upload_page.success_title'))).toBeInTheDocument();
            expect(api.submitUpload).toHaveBeenCalledTimes(1);
            const receipt = screen.getByText('fake-license.pdf').closest('[data-private]') as HTMLElement;
            expect(within(receipt).queryByText('fake-resume.pdf')).toBeNull();
            expect(within(receipt).getByText(message('doc_types.resume'))).toBeInTheDocument();
            expect(within(receipt).getByText(message('upload_page.error_already_received'))).toBeInTheDocument();
        },
    );

    it('does not confirm such a document again on a later submit', async () => {
        let licenseFails = true;
        api.confirmUpload.mockImplementation(async (_token: string, _key: string, docType: string) => {
            if (docType === 'resume') throw new ApiError(409, 'invalid_or_confirmed_upload');
            if (licenseFails) {
                licenseFails = false;
                throw new ApiError(500, 'internal_error');
            }
        });
        const submit = await chooseBoth();
        fireEvent.click(submit);
        await waitFor(() => expect(submit).toBeEnabled());
        expect(api.submitUpload).not.toHaveBeenCalled();

        fireEvent.click(submit);
        expect(await screen.findByText(message('upload_page.success_title'))).toBeInTheDocument();
        expect(api.confirmUpload.mock.calls.map((call) => call[2])).toEqual(['resume', 'driver_license', 'driver_license']);
        const receipt = screen.getByText('fake-license.pdf').closest('[data-private]') as HTMLElement;
        expect(within(receipt).queryByText('fake-resume.pdf')).toBeNull();
        expect(within(receipt).getByText(message('upload_page.error_already_received'))).toBeInTheDocument();
    });
});
