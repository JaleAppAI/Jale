// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { RequirementsPicker } from '@/components/employer/RequirementsPicker';
import { initialRequirements, setRequirementState, type RequirementsMap } from '@/lib/job-requirements';
import { message, renderIntl } from './render-intl';

const dobLabel = () => message('job_requirements.fields.date_of_birth');

function renderPicker(requirements: RequirementsMap, extra: { locked?: boolean; onChange?: (next: RequirementsMap) => void } = {}, locale: 'en' | 'es' = 'en') {
  return renderIntl(
    <RequirementsPicker requirements={requirements} onChange={extra.onChange ?? vi.fn()} locked={extra.locked} />,
    locale,
  );
}

// Step 3 is two labelled parts (sprint 29). Part 2 waits until the employer
// requests details. Copy from the approved applicant-questions board.
describe('RequirementsPicker — Part 2 heading and note', () => {
  it('labels itself as the before-you-hire part, with the timing note and the lock', () => {
    renderPicker(initialRequirements());
    expect(screen.getByText('Part 2 · Before you hire')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Questions for applicants' })).toBeInTheDocument();
    const note = screen.getByRole('note');
    expect(within(note).getByText('These are for the people who apply, not for you.')).toBeInTheDocument();
    expect(
      within(note).getByText(
        'Applicants answer them only after you request details from someone you want to hire. Until then you see their trade, experience and answers about their work.',
      ),
    ).toBeInTheDocument();
    expect(within(note).getByText('Once someone applies, neither part can change.')).toBeInTheDocument();
  });

  it('says the same in Spanish', () => {
    renderPicker(initialRequirements(), {}, 'es');
    expect(screen.getByText('Parte 2 · Antes de contratar')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preguntas para postulantes' })).toBeInTheDocument();
    expect(screen.getByText('Cuando alguien se postula, ninguna de las dos partes se puede cambiar.')).toBeInTheDocument();
  });
});

describe('RequirementsPicker — date of birth', () => {
  it('does not offer it on a new job', () => {
    renderPicker(initialRequirements());
    expect(screen.queryByRole('radiogroup', { name: dobLabel() })).not.toBeInTheDocument();
  });

  it('still shows it, with its state, on an existing job that asks for it', () => {
    renderPicker(setRequirementState(initialRequirements(), 'date_of_birth', 'required'));
    const row = screen.getByRole('radiogroup', { name: dobLabel() });
    expect(within(row).getByRole('radio', { name: message('job_requirements.states.required') }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('No longer offered on new jobs.')).toBeInTheDocument();
  });

  it('shows it read-only on a locked job', () => {
    renderPicker(setRequirementState(initialRequirements(), 'date_of_birth', 'optional'), { locked: true });
    const row = screen.getByRole('radiogroup', { name: dobLabel() });
    for (const radio of within(row).getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('keeps the row on screen after it is switched off, so the change can be undone', () => {
    let current = setRequirementState(initialRequirements(), 'date_of_birth', 'required');
    const onChange = vi.fn((next: RequirementsMap) => { current = next; });
    const { rerender } = renderPicker(current, { onChange });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: dobLabel() }))
      .getByRole('radio', { name: message('job_requirements.states.off') }));
    expect(current.date_of_birth).toBe('off');
    rerender(<RequirementsPicker requirements={current} onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: dobLabel() })).toBeInTheDocument();
  });
});
