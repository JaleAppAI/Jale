// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { ScheduleFields } from '@/components/employer/ScheduleFields';
import { renderIntl, message } from './render-intl';

type Props = Parameters<typeof ScheduleFields>[0];

function renderFields(over: Partial<Props> & Record<string, unknown> = {}, locale: 'en' | 'es' = 'en') {
  const props = {
    workDays: [],
    shiftStart: '',
    shiftEnd: '',
    legacyShiftSchedule: '',
    onToggleDay: vi.fn(),
    onShiftStartChange: vi.fn(),
    onShiftEndChange: vi.fn(),
    shiftPeriods: [],
    onToggleShiftPeriod: vi.fn(),
    ...over,
  } as unknown as Props;
  return { props, ...renderIntl(<ScheduleFields {...props} />, locale) };
}

describe('ScheduleFields: shift choices', () => {
  it('offers the four shifts, each with its help line, under a Shifts group', () => {
    renderFields();
    const group = screen.getByRole('group', { name: message('employer_dashboard.modal.shifts_label') });
    for (const period of ['day', 'evening', 'night', 'overnight']) {
      const box = screen.getByRole('checkbox', { name: message(`common.shift_periods.${period}`) });
      expect(group).toContainElement(box);
      expect(box).toHaveAccessibleDescription(message(`common.shift_period_help.${period}`));
    }
    expect(screen.getByText(message('employer_dashboard.modal.shifts_hint'))).toBeInTheDocument();
  });

  it('shows the chosen shifts as checked', () => {
    renderFields({ shiftPeriods: ['night'] });
    expect(screen.getByRole('checkbox', { name: message('common.shift_periods.night') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: message('common.shift_periods.day') })).not.toBeChecked();
  });

  it('reports the shift that was tapped', () => {
    const { props } = renderFields();
    fireEvent.click(screen.getByRole('checkbox', { name: message('common.shift_periods.evening') }));
    expect((props as unknown as { onToggleShiftPeriod: ReturnType<typeof vi.fn> }).onToggleShiftPeriod)
      .toHaveBeenCalledWith('evening');
  });

  it('marks the start and end times optional, with the hint under them', () => {
    renderFields();
    expect(screen.getByText(message('employer_dashboard.modal.shift_times_label'))).toBeInTheDocument();
    expect(screen.getByText(message('employer_dashboard.modal.shift_times_hint'))).toBeInTheDocument();
  });

  it('hides the old free-text note once a shift is chosen', () => {
    renderFields({ legacyShiftSchedule: 'Mon-Fri mornings', shiftPeriods: ['day'] });
    expect(screen.queryByText(/Mon-Fri mornings/)).not.toBeInTheDocument();
  });

  it('renders the Spanish labels', () => {
    renderFields({}, 'es');
    expect(screen.getByRole('checkbox', { name: message('common.shift_periods.overnight', 'es') })).toBeInTheDocument();
  });
});

/*
 * K2 (2026-10-22): the server refuses an unknown shift value with 400
 * `invalid_shift_periods`. The form marks the shift choices themselves.
 */
describe('ScheduleFields: refused shift choices', () => {
  const MESSAGE = 'Pick the shifts again from this list';

  it('marks every shift choice and describes it with the sentence', () => {
    renderFields({ fieldError: { field: 'shift_periods', message: MESSAGE } });

    for (const period of ['day', 'evening', 'night', 'overnight']) {
      const box = screen.getByRole('checkbox', { name: message(`common.shift_periods.${period}`) });
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(box).toHaveAccessibleDescription(expect.stringContaining(MESSAGE));
    }
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(document.querySelector('[data-field="shift_periods"]')).not.toBeNull();
  });

  it('leaves the times unmarked', () => {
    renderFields({ fieldError: { field: 'shift_periods', message: MESSAGE } });

    for (const input of Array.from(document.querySelectorAll('input[type="time"]'))) {
      expect(input).not.toHaveAttribute('aria-invalid');
    }
  });
});
