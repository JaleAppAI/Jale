// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TrustExtraction } from '@/lib/api/employer';
import { AnswerHighlights } from '../AnswerHighlights';

const wrap = (ui: React.ReactElement, locale: 'en' | 'es' = 'en') => (
  <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : es}>
    {ui}
  </NextIntlClientProvider>
);

const item = (label_en: string, label_es: string) => ({ label_en, label_es, source: [0] });

const completed: TrustExtraction = {
  status: 'completed',
  extracted: {
    skills: [item('Conduit bending', 'Doblado de tuberia')],
    tools: [item('Hydraulic bender', 'Dobladora hidraulica')],
    experience_signals: [item('Ten years residential', 'Diez anos residencial')],
    safety: [item('Lockout/tagout', 'Bloqueo y etiquetado')],
    notable: [item('Owns own truck', 'Tiene su propia camioneta')],
  },
  summary_en: 'Ten years of residential rewires, comfortable bending conduit.',
  summary_es: 'Diez anos de recableado residencial, comodo doblando tuberia.',
  extractor_version: 'trust-extractor-1',
};

describe('AnswerHighlights', () => {
  it('renders nothing at all when there is no extraction', () => {
    const { container } = render(wrap(<AnswerHighlights extraction={null} />));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a chip per extracted item plus the summary, under the eyebrow', () => {
    render(wrap(<AnswerHighlights extraction={completed} />));
    expect(screen.getByText(en.employer_worker_profile.extraction_title)).toBeInTheDocument();
    for (const label of [
      'Conduit bending',
      'Hydraulic bender',
      'Ten years residential',
      'Lockout/tagout',
      'Owns own truck',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(completed.summary_en!)).toBeInTheDocument();
  });

  it('never claims anything is verified', () => {
    // These are a model's read of a worker's own words. The panel may show
    // what was said; it may not endorse it.
    const { container } = render(wrap(<AnswerHighlights extraction={completed} />));
    expect(container.textContent?.toLowerCase()).not.toContain('verified');
    expect(container.textContent?.toLowerCase()).not.toContain('verificad');
  });

  it('shows the Spanish label and summary on the Spanish locale', () => {
    render(wrap(<AnswerHighlights extraction={completed} />, 'es'));
    expect(screen.getByText('Doblado de tuberia')).toBeInTheDocument();
    expect(screen.getByText(completed.summary_es!)).toBeInTheDocument();
    expect(screen.queryByText('Conduit bending')).not.toBeInTheDocument();
  });

  it('shows the summary alone when every extracted array is empty', () => {
    // The extractor writes a "not enough detail" summary rather than failing,
    // so a completed-but-empty row is a legitimate terminal state, not a bug.
    render(
      wrap(
        <AnswerHighlights
          extraction={{
            ...completed,
            extracted: { skills: [], tools: [], experience_signals: [], safety: [], notable: [] },
          }}
        />,
      ),
    );
    expect(screen.getByText(en.employer_worker_profile.extraction_title)).toBeInTheDocument();
    expect(screen.getByText(completed.summary_en!)).toBeInTheDocument();
    expect(screen.queryByText('Conduit bending')).not.toBeInTheDocument();
  });

  it('shows a quiet "still reading" line for a non-completed extraction, and no content', () => {
    for (const status of ['pending', 'extracting', 'failed'] as const) {
      const { unmount } = render(
        wrap(<AnswerHighlights extraction={{ ...completed, status }} />),
      );
      expect(screen.getByText(en.employer_worker_profile.extraction_pending)).toBeInTheDocument();
      expect(screen.queryByText('Conduit bending')).not.toBeInTheDocument();
      expect(screen.queryByText(completed.summary_en!)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('renders nothing when a completed extraction has neither chips nor a summary', () => {
    const { container } = render(
      wrap(
        <AnswerHighlights
          extraction={{ ...completed, extracted: {}, summary_en: null, summary_es: null }}
        />,
      ),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one chip for a label the extractor placed in two categories', () => {
    render(
      wrap(
        <AnswerHighlights
          extraction={{
            ...completed,
            extracted: {
              skills: [item('Lockout/tagout', 'Bloqueo y etiquetado')],
              safety: [item('Lockout/tagout', 'Bloqueo y etiquetado')],
            },
          }}
        />,
      ),
    );
    expect(screen.getAllByText('Lockout/tagout')).toHaveLength(1);
  });
});
