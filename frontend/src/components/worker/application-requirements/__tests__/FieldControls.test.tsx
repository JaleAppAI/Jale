// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import {
  expectNoRawMessageKeys,
  message,
  renderIntl,
  type TestLocale,
} from '@/components/worker/onboarding/__tests__/render-intl';
import { emptyAnswerDraft } from '@/lib/application-answers-form';
import { QuestionFieldRow } from '../FieldControls';

/**
 * Prod report 2026-09-08: a prefilled field on the web details step showed the
 * literal `worker_job_detail.apply_flow.prefilled_hint` under its label. The
 * row asked one namespace for a key that lives in another, and next-intl's
 * fallback prints the joined path. These tests render the row against the
 * REAL catalogues (no `useTranslations` stub) so a namespace mismatch fails
 * here instead of shipping.
 */
function renderRow(prefilled: boolean, locale: TestLocale = 'es') {
  return renderIntl(
    <QuestionFieldRow
      fieldKey="work_authorization"
      required
      skipped={false}
      onSkip={vi.fn()}
      draft={emptyAnswerDraft()}
      update={vi.fn()}
      fieldId="q"
      missing={false}
      prefilled={prefilled}
    />,
    locale,
  );
}

describe('QuestionFieldRow — prefilled hint', () => {
  it.each<TestLocale>(['es', 'en'])('renders the translated hint in %s, never a raw key path', (locale) => {
    const { container } = renderRow(true, locale);
    expect(
      screen.getByText(message('worker_application_details.prefilled_hint', locale)),
    ).toBeInTheDocument();
    expectNoRawMessageKeys(container);
  });

  it('renders no hint when the value was not prefilled', () => {
    const { container } = renderRow(false, 'es');
    expect(
      screen.queryByText(message('worker_application_details.prefilled_hint', 'es')),
    ).not.toBeInTheDocument();
    expectNoRawMessageKeys(container);
  });
});
