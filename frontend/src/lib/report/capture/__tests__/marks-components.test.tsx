// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { WorkerDocument } from '@/lib/api/employer';
import type { WorkerVaultDoc } from '@/lib/api/worker';
import { ToastProvider } from '@/components/ui/toast';
import { DocumentSlots } from '@/app/[locale]/employer/workers/[worker_id]/DocumentSlots';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { CertClaimRow } from '@/components/worker/application-requirements/DocumentsCertificationsStep';
import { DoneStep } from '@/components/worker/onboarding/DoneStep';
import { YesNo } from '@/components/worker/application-requirements/FieldControls';
import { THREE_QUESTIONS, onboardingState, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { isMaskedForCapture } from './marks-helpers';

/*
 * Shared components that show a person's own words or file names: each
 * hides exactly those in a report screenshot. All values are fake.
 */

const wrap = (ui: React.ReactElement) => (
    <NextIntlClientProvider locale="en" messages={en}>
        <ToastProvider>{ui}</ToastProvider>
    </NextIntlClientProvider>
);

class NoopIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('capture marks in shared components', () => {
    it('employer view of the documents: the file names and the names the worker gave them', () => {
        const doc: WorkerDocument = {
            id: 'd1',
            doc_type: 'certification_doc',
            file_name: 'fake-certificate-file.pdf',
            cert_name: 'Fake cert label',
            file_size: 2048,
            uploaded_at: '2026-08-20T00:00:00.000Z',
            url: 'https://files.example.invalid/d1',
        } as WorkerDocument;
        render(wrap(<DocumentSlots documents={[doc]} onRequest={vi.fn()} requestDisabled={false} requesting={false} />));
        expect(isMaskedForCapture(screen.getByText('fake-certificate-file.pdf'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText('Fake cert label'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText(en.doc_types.certification_doc))).toBe(false);
    });

    it('worker vault: the file name', () => {
        const existing: WorkerVaultDoc = {
            id: 'v1',
            doc_type: 'resume',
            file_name: 'fake-resume-file.pdf',
            file_size: 1024,
            uploaded_at: '2026-08-20T00:00:00.000Z',
            url: 'https://files.example.invalid/v1',
        } as WorkerVaultDoc;
        render(wrap(<DocumentSlot token="tok" doc_type="resume" existing={existing} onChange={vi.fn()} />));
        expect(isMaskedForCapture(screen.getByText(/fake-resume-file\.pdf/))).toBe(true);
        expect(isMaskedForCapture(screen.getByText(en.worker_profile.documents.types.resume))).toBe(false);
    });

    it('application certification step: the vault file it will use', () => {
        const vaultDocs = [
            {
                id: 'v2',
                doc_type: 'certification_doc',
                cert_name: 'Fake Cert',
                file_name: 'fake-proof-file.pdf',
                file_size: 1024,
                uploaded_at: '2026-08-20T00:00:00.000Z',
                url: 'https://files.example.invalid/v2',
            },
        ] as WorkerVaultDoc[];
        render(
            wrap(
                <CertClaimRow
                    cert={{ name: 'Fake Cert', tier: 'required', proof_required: true }}
                    claim={{ has: true }}
                    onSetHas={vi.fn()}
                    vaultDocs={vaultDocs}
                    uploading={false}
                    onUpload={vi.fn()}
                    missingClaim={false}
                    missingProof={false}
                />,
            ),
        );
        expect(isMaskedForCapture(screen.getByText(/fake-proof-file\.pdf/))).toBe(true);
    });

    it('application form: a yes/no answer (work authorization and the like), which is buttons, not an input', () => {
        render(wrap(<YesNo value={true} onChange={vi.fn()} label="Fake question label" />));
        expect(isMaskedForCapture(screen.getByRole('radio', { name: en.job_requirements.apply.yes }))).toBe(true);
        expect(isMaskedForCapture(screen.getByText('Fake question label'))).toBe(false);
    });

    it('onboarding summary: the answers in the worker’s own words', () => {
        renderIntl(
            <DoneStep
                state={onboardingState({
                    trust: {
                        questions: THREE_QUESTIONS,
                        answers: [{ index: 1, text: 'Fake onboarding answer words', source: 'text' }],
                    },
                })}
                next={{ kind: 'feed' }}
                onFinish={vi.fn()}
            />,
        );
        expect(isMaskedForCapture(screen.getByText(/Fake onboarding answer words/))).toBe(true);
    });
});
