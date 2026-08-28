// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { WorkerDocument } from '@/lib/api/employer';
import { DocumentSlots } from '../DocumentSlots';

const wrap = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>
);

const doc = (over: Partial<WorkerDocument> & Pick<WorkerDocument, 'id' | 'doc_type'>): WorkerDocument => ({
  file_name: `${over.doc_type}.pdf`,
  file_size: 2048,
  uploaded_at: '2026-08-20T00:00:00.000Z',
  url: `https://s3.example.com/${over.id}`,
  ...over,
});

function renderSlots(documents: WorkerDocument[]) {
  return render(
    wrap(
      <DocumentSlots
        documents={documents}
        onRequest={vi.fn()}
        requestDisabled={false}
        requesting={false}
      />,
    ),
  );
}

describe('DocumentSlots', () => {
  it('offers the four live slots and never the retired ssn one', () => {
    renderSlots([]);
    expect(screen.getByText(en.doc_types.resume)).toBeInTheDocument();
    expect(screen.getByText(en.doc_types.driver_license)).toBeInTheDocument();
    expect(screen.getByText(en.doc_types.work_auth_doc)).toBeInTheDocument();
    expect(screen.getByText(en.doc_types.certification_doc)).toBeInTheDocument();
    expect(screen.queryByText(en.doc_types.ssn)).not.toBeInTheDocument();
    // Four empty slots, each with its own request affordance.
    expect(screen.getAllByText(en.employer_worker_profile.not_uploaded)).toHaveLength(4);
  });

  it('hides an ssn document a legacy row still holds', () => {
    // No surface offers `ssn` as an upload any more, and the slot is gone; a
    // stray legacy row must not resurrect it as a visible document.
    renderSlots([doc({ id: 'd0', doc_type: 'ssn', file_name: 'ssn-card.pdf' })]);
    expect(screen.queryByText('ssn-card.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText(en.doc_types.ssn)).not.toBeInTheDocument();
  });

  it('shows the certification and work-authorization documents an employer can now see', () => {
    renderSlots([
      doc({ id: 'd1', doc_type: 'work_auth_doc', file_name: 'ead.pdf' }),
      doc({ id: 'd2', doc_type: 'certification_doc', file_name: 'osha30.pdf', cert_name: 'OSHA 30' }),
    ]);
    expect(screen.getByText('ead.pdf')).toBeInTheDocument();
    expect(screen.getByText('osha30.pdf')).toBeInTheDocument();
  });

  it('renders every certification file in the slot, each named by its cert_name', () => {
    // The slot holds up to 20 rows of one doc_type (migrations 075/078). A
    // `documents.find(...)` over the type showed exactly one and silently
    // dropped the rest.
    renderSlots([
      doc({ id: 'd1', doc_type: 'certification_doc', file_name: 'osha30.pdf', cert_name: 'OSHA 30' }),
      doc({ id: 'd2', doc_type: 'certification_doc', file_name: 'forklift.pdf', cert_name: 'Forklift' }),
      doc({ id: 'd3', doc_type: 'certification_doc', file_name: 'unlabeled.pdf', cert_name: null }),
    ]);
    expect(screen.getByText('OSHA 30')).toBeInTheDocument();
    expect(screen.getByText('Forklift')).toBeInTheDocument();
    expect(screen.getByText('osha30.pdf')).toBeInTheDocument();
    expect(screen.getByText('forklift.pdf')).toBeInTheDocument();
    expect(screen.getByText('unlabeled.pdf')).toBeInTheDocument();
    // Three files, three view links -- the slot label itself is not repeated.
    expect(screen.getAllByText(en.employer_worker_profile.view)).toHaveLength(3);
    expect(screen.getAllByText(en.doc_types.certification_doc)).toHaveLength(1);
  });

  it('links view and download at the server-minted presigned URL', () => {
    renderSlots([doc({ id: 'd1', doc_type: 'resume', file_name: 'resume.pdf' })]);
    const view = screen.getByText(en.employer_worker_profile.view).closest('a');
    const download = screen.getByText(en.employer_worker_profile.download).closest('a');
    expect(view).toHaveAttribute('href', 'https://s3.example.com/d1');
    expect(download).toHaveAttribute('href', 'https://s3.example.com/d1');
    expect(download).toHaveAttribute('download', 'resume.pdf');
  });

  it('offers Request on an empty slot only', () => {
    renderSlots([doc({ id: 'd1', doc_type: 'resume' })]);
    // resume is filled; the other three slots still ask.
    expect(screen.getAllByText(en.employer_worker_profile.request)).toHaveLength(3);
  });
});
