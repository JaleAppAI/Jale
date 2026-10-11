// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { isMaskedForCapture } from './marks-helpers';

/*
 * The public upload page (a link sent by text message): the names of the
 * files the person chose are hidden in a report screenshot, before and after
 * sending. All values are fake.
 */

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
    getUploadUrl: vi.fn(async () => ({ url: 'https://upload.example.invalid/put', s3_key: 'incoming/fake' })),
    uploadFileToS3: vi.fn(async () => undefined),
    confirmUpload: vi.fn(async () => undefined),
    submitUpload: vi.fn(async () => undefined),
}));

import { renderIntl, message } from '@/components/worker/onboarding/__tests__/render-intl';
import UploadPage from '@/app/[locale]/upload/[token]/page';

describe('upload page: capture marks', () => {
    it('hides the chosen file name on the form and on the receipt', async () => {
        const { container } = renderIntl(<UploadPage />);
        const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
        const file = new File(['x'], 'fake-chosen-file.pdf', { type: 'application/pdf' });
        fireEvent.change(input, { target: { files: [file] } });
        const onForm = await screen.findByText('fake-chosen-file.pdf');
        expect(isMaskedForCapture(onForm)).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: message('upload_page.submit') }));
        await waitFor(() => expect(screen.queryByRole('button', { name: message('upload_page.submit') })).toBeNull());
        const onReceipt = screen.getByText('fake-chosen-file.pdf');
        expect(isMaskedForCapture(onReceipt)).toBe(true);
    });

    it('leaves the hint visible while no file is chosen', () => {
        renderIntl(<UploadPage />);
        expect(isMaskedForCapture(screen.getAllByText(message('upload_page.file_hint'))[0])).toBe(false);
    });
});
