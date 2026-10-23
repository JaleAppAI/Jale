// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { CertificationsPicker } from '@/components/employer/CertificationsPicker';
import { renderIntl } from './render-intl';

// The hint answers the two questions employers asked out loud: can I pick
// several, and can I add one that is not on the list. Copy from the approved
// job-form board.
describe('CertificationsPicker hint', () => {
  it('says several are allowed, from the list or in their own words (en)', () => {
    renderIntl(<CertificationsPicker certificationRequirements={[]} legacyCertifications="" onChange={vi.fn()} />);
    expect(screen.getByText('Add several, from the list or in your own words.')).toBeInTheDocument();
  });

  it('says the same in Spanish (es)', () => {
    renderIntl(
      <CertificationsPicker certificationRequirements={[]} legacyCertifications="" onChange={vi.fn()} />,
      'es',
    );
    expect(screen.getByText('Agregue varias, de la lista o con sus propias palabras.')).toBeInTheDocument();
  });
});
