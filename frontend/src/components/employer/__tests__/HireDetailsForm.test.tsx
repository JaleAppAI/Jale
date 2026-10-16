// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({ handleLegalWall: (err: unknown) => { throw err; } }),
}));
const toastSuccess = vi.fn();
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }) }));
const updateHireDetails = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  updateHireDetails: (...args: unknown[]) => updateHireDetails(...args),
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ApiError } from '@/lib/api/errors';
import { HireDetailsForm } from '../HireDetailsForm';

const PHONE = '+1 (000) 000-0000';
const key = (k: string) => message(`employer_applicants.hire_details.${k}`);

function renderForm(over: Partial<ComponentProps<typeof HireDetailsForm>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    jobId: 'job-1',
    workerId: 'w-1',
    workerName: 'Ana Prueba',
    initial: null,
    onSaved: vi.fn(),
    ...over,
  };
  renderIntl(<HireDetailsForm {...props} />);
  return props;
}

const field = (labelKey: string) => screen.getByLabelText(key(labelKey));
const save = () => screen.getByRole('button', { name: key('save') });

beforeEach(() => vi.clearAllMocks());

describe('HireDetailsForm (K4.2, T-b)', () => {
  it('labels every field and titles the dialog with the worker', () => {
    renderForm();
    expect(screen.getByRole('dialog', { name: interpolate(key('title'), { name: 'Ana Prueba' }) })).toBeInTheDocument();
    for (const k of ['start_date', 'report_location', 'contact_name', 'contact_phone', 'notes']) {
      expect(field(k)).toBeInTheDocument();
    }
    expect(field('start_date')).toHaveAttribute('type', 'date');
    expect(field('contact_phone')).toHaveAttribute('type', 'tel');
  });

  it('sends the K4.2 payload: trimmed, blanks as null, all five keys', async () => {
    const saved = { start_date: '2026-10-20', report_location: 'Gate 3', contact_name: 'Site lead', contact_phone: PHONE, notes: null, updated_at: '2026-10-14T15:00:00Z' };
    updateHireDetails.mockResolvedValue(saved);
    const user = userEvent.setup();
    const props = renderForm();

    fireEvent.change(field('start_date'), { target: { value: '2026-10-20' } });
    await user.type(field('report_location'), '  Gate 3 ');
    await user.type(field('contact_name'), 'Site lead');
    await user.type(field('contact_phone'), PHONE);
    await user.click(save());

    await waitFor(() => expect(updateHireDetails).toHaveBeenCalledTimes(1));
    expect(updateHireDetails).toHaveBeenCalledWith('test-token', 'job-1', 'w-1', {
      start_date: '2026-10-20',
      report_location: 'Gate 3',
      contact_name: 'Site lead',
      contact_phone: PHONE,
      notes: null,
    });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(saved));
    expect(toastSuccess).toHaveBeenCalledWith(key('saved'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('reports a save that left every field empty as null', async () => {
    updateHireDetails.mockResolvedValue(null);
    const user = userEvent.setup();
    const props = renderForm({
      initial: { start_date: null, report_location: 'Gate 3', contact_name: null, contact_phone: null, notes: null, updated_at: '2026-10-14T15:00:00Z' },
    });

    await user.clear(field('report_location'));
    await user.click(save());

    await waitFor(() => expect(updateHireDetails).toHaveBeenCalledWith('test-token', 'job-1', 'w-1', {
      start_date: null, report_location: null, contact_name: null, contact_phone: null, notes: null,
    }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(null));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('refuses an invalid phone inline, focuses it, and sends nothing', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(field('contact_phone'), 'call the office');
    await user.click(save());

    expect(screen.getByText(key('error_phone'))).toBeInTheDocument();
    expect(field('contact_phone')).toHaveFocus();
    expect(field('contact_phone')).toHaveAttribute('aria-invalid', 'true');
    expect(updateHireDetails).not.toHaveBeenCalled();
  });

  it("shows the server's refused fields inline", async () => {
    updateHireDetails.mockRejectedValue(new ApiError(400, 'invalid_hire_details', { fields: ['contact_phone'] }));
    const user = userEvent.setup();
    renderForm();

    await user.type(field('contact_phone'), PHONE);
    await user.click(save());

    expect(await screen.findByText(key('error_field'))).toBeInTheDocument();
    expect(field('contact_phone')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so when the applicant is no longer hired', async () => {
    updateHireDetails.mockRejectedValue(new ApiError(409, 'not_hired'));
    const user = userEvent.setup();
    renderForm();

    await user.type(field('report_location'), 'Gate 3');
    await user.click(save());

    expect(await screen.findByRole('alert')).toHaveTextContent(key('error_not_hired'));
  });

  it('saves once on a double submit', async () => {
    updateHireDetails.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderForm();

    await user.type(field('report_location'), 'Gate 3');
    await user.dblClick(save());

    expect(updateHireDetails).toHaveBeenCalledTimes(1);
  });

  it('starts from the saved details when editing', () => {
    renderForm({
      initial: { start_date: '2026-10-20', report_location: 'Gate 3', contact_name: null, contact_phone: null, notes: 'Bring boots', updated_at: '2026-10-14T15:00:00Z' },
    });
    expect(field('start_date')).toHaveValue('2026-10-20');
    expect(field('report_location')).toHaveValue('Gate 3');
    expect(field('notes')).toHaveValue('Bring boots');
  });
});
