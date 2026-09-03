// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobDocType } from '@/lib/api/worker';
import { DocumentsCertificationsStep } from '../DocumentsCertificationsStep';

const wrap = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>
);

function renderStep(requirements: { required_docs?: readonly JobDocType[] }) {
  return render(
    wrap(
      <DocumentsCertificationsStep
        requirements={{
          required_docs: [],
          optional_docs: [],
          certification_requirements: [],
          ...requirements,
        }}
        certClaims={{}}
        dispatch={vi.fn()}
        token="tok"
        vaultDocs={[]}
        onVaultChanged={vi.fn()}
        onContinue={vi.fn()}
      />,
    ),
  );
}

describe('DocumentsCertificationsStep — unrenderable required docs', () => {
  it('names a legacy ssn requirement from the shared catalogue, not as a raw key', () => {
    renderStep({ required_docs: ['ssn'] as never });
    expect(screen.getByText(en.doc_types.ssn)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.worker_application_details.legacy_doc_notice))).toBeInTheDocument();
    expect(screen.queryByText('ssn')).not.toBeInTheDocument();
  });

  it('lists a duplicated requirement ONCE', () => {
    // `required_docs` comes straight off the `jobs` row and its CHECK does not
    // forbid a repeat. Printing "SSN Card / ITIN, SSN Card / ITIN" reads as two
    // separate things the worker has to produce.
    renderStep({ required_docs: ['ssn', 'ssn'] as never });
    expect(screen.getAllByText(en.doc_types.ssn)).toHaveLength(1);
  });

  it('raises a visible ERROR for a requirement this app cannot name at all', () => {
    // A key outside DOC_TYPE_KEYS has no label and no upload control. Before
    // this it was printed as the bare enum string inside the "ask the employer
    // in person" notice, which quietly told the worker a requirement they
    // cannot read is merely a legacy one.
    renderStep({ required_docs: ['passport'] as never });
    const notice = screen.getByText(new RegExp(en.worker_application_details.unknown_doc_notice));
    expect(notice).toBeInTheDocument();
    expect(screen.getByText('passport')).toBeInTheDocument();
  });

  it('separates the nameable legacy requirement from the unnameable one', () => {
    renderStep({ required_docs: ['ssn', 'passport', 'passport'] as never });
    expect(screen.getByText(new RegExp(en.worker_application_details.legacy_doc_notice))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.worker_application_details.unknown_doc_notice))).toBeInTheDocument();
    expect(screen.getAllByText('passport')).toHaveLength(1);
    expect(screen.getAllByText(en.doc_types.ssn)).toHaveLength(1);
  });

  it('shows neither notice when every requirement has an upload control', () => {
    renderStep({ required_docs: ['resume'] as never });
    expect(
      screen.queryByText(new RegExp(en.worker_application_details.legacy_doc_notice)),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(en.worker_application_details.unknown_doc_notice)),
    ).not.toBeInTheDocument();
    expect(screen.getByText(en.job_requirements.docs.resume)).toBeInTheDocument();
  });
});
