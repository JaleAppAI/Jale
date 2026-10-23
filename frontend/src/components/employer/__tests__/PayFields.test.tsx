// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { PayFields } from '@/components/employer/PayFields';
import { message, renderIntl } from './render-intl';

function renderPay(locale: 'en' | 'es' = 'en') {
  return renderIntl(
    <PayFields
      payMin=""
      payMax=""
      payInterval="hourly"
      onPayMinChange={vi.fn()}
      onPayMaxChange={vi.fn()}
      onPayIntervalChange={vi.fn()}
    />,
    locale,
  );
}

// Employers asked whether pay can be negotiable. The max is already optional;
// the hint under it says so. Copy from the approved job-form board.
describe('PayFields max hint', () => {
  it('tells the employer the max can stay blank when pay is negotiable (en)', () => {
    renderPay();
    const max = screen.getByLabelText(message('employer_dashboard.modal.pay_max'));
    expect(max).toHaveAccessibleDescription('Max is optional. Leave it blank if pay is negotiable.');
    expect(max).toHaveAttribute('placeholder', 'Optional');
  });

  it('says the same in Spanish (es)', () => {
    renderPay('es');
    const max = screen.getByLabelText(message('employer_dashboard.modal.pay_max', 'es'));
    expect(max).toHaveAccessibleDescription('El máximo es opcional. Déjelo en blanco si el pago es negociable.');
    expect(max).toHaveAttribute('placeholder', 'Opcional');
  });

  it('names the min field too', () => {
    renderPay();
    expect(screen.getByLabelText(message('employer_dashboard.modal.pay_min'))).toHaveAttribute('type', 'number');
  });
});
