// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

/** A JWT-shaped token whose payload names an account (`sub`) -- all the remind marker reads. */
const TOKEN = `header.${btoa(JSON.stringify({ sub: 'acct-worker' })).replace(/=+$/, '')}.signature`;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: TOKEN }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({ handleLegalWall: (err: unknown) => { throw err; } }),
}));

const sendApplicationMessage = vi.fn();
const remindEmployer = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  sendApplicationMessage: (...args: unknown[]) => sendApplicationMessage(...args),
  remindEmployer: (...args: unknown[]) => remindEmployer(...args),
}));

import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { ApiError } from '@/lib/api/errors';
import { formatStartDateWeekday } from '@/lib/date';
import type { ApplicationHire, ApplicationRequirementsState } from '@/lib/api/worker';
import { HiredCard } from '../HiredCard';

type SentMessageRecord = ApplicationRequirementsState['sent_messages'][number];

const APP = 'app-hired-1';
const PHONE = '+1 (000) 000-0000';

function hire(over: Partial<ApplicationHire> = {}): ApplicationHire {
  return {
    hired_at: '2026-10-10T15:00:00.000Z',
    seen_at: '2026-10-10T15:05:00.000Z',
    acknowledged_at: null,
    start_date: null,
    location: 'Austin, TX',
    shift_schedule: null,
    pay: null,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    details: null,
    employer_reminded_at: null,
    ...over,
  };
}

const DETAILS = {
  start_date: '2026-10-20',
  report_location: 'North gate, Building 3',
  contact_name: 'Site lead',
  contact_phone: PHONE,
  notes: 'Bring steel-toe boots.',
  updated_at: '2026-10-12T15:00:00.000Z',
};

/** An ICU plural message with `#`, spelled out for one count. */
function plural(path: string, count: number): string {
  const raw = message(path);
  const form = count === 1 ? /one \{([^}]*)\}/ : /other \{([^}]*)\}/;
  return interpolate((raw.match(form)?.[1] ?? '').replace(/#/g, '{n}'), { n: count });
}

const reachOut = () => interpolate(message('worker_application_details.terminal.hired_body'), { company: 'Bravo Co' });
const remindButton = () => screen.getByRole('button', { name: message('worker_application_details.hired_card.remind') });
const sendButton = () => screen.getByRole('button', { name: message('worker_application_details.hired_card.message_send') });
const messageBox = () => screen.getByLabelText(message('worker_application_details.hired_card.message_label'));

function renderCard(h: ApplicationHire = hire(), sentMessages: SentMessageRecord[] = []) {
  return renderIntl(
    <HiredCard applicationId={APP} jobTitle="Welder" companyName="Bravo Co" hire={h} sentMessages={sentMessages} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('HiredCard — start details', () => {
  it('shows the start details and drops the reach-out copy (T-a)', () => {
    renderCard(hire({ details: DETAILS }));

    expect(screen.getByText(formatStartDateWeekday('2026-10-20', 'en') as string)).toBeInTheDocument();
    expect(screen.getByText('North gate, Building 3')).toBeInTheDocument();
    expect(screen.getByText('Site lead')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: PHONE })).toHaveAttribute('href', 'tel:+10000000000');
    expect(screen.getByText('Bring steel-toe boots.')).toBeInTheDocument();
    expect(screen.queryByText(reachOut())).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message('worker_application_details.hired_card.remind') })).not.toBeInTheDocument();
  });

  it('keeps the reach-out copy and offers Remind while there are no details', () => {
    renderCard();
    expect(screen.getByText(reachOut())).toBeInTheDocument();
    expect(remindButton()).toBeEnabled();
  });

  it('treats an all-blank save as no details', () => {
    renderCard(hire({ details: { ...DETAILS, start_date: null, report_location: null, contact_name: null, contact_phone: null, notes: '  ' } }));
    expect(screen.getByText(reachOut())).toBeInTheDocument();
  });
});

describe('HiredCard — Remind my employer (K4.4)', () => {
  it('sends one reminder, then disables the button and says why (T-a)', async () => {
    remindEmployer.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderCard();

    await user.dblClick(remindButton());

    await waitFor(() => expect(remindButton()).toBeDisabled());
    expect(remindEmployer).toHaveBeenCalledTimes(1);
    expect(remindEmployer).toHaveBeenCalledWith(TOKEN, APP);
    expect(screen.getByText(new RegExp(message('worker_application_details.hired_card.remind_sent')))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(plural('worker_application_details.hired_card.remind_wait', 24)))).toBeInTheDocument();
    expect(remindButton()).toHaveAttribute('aria-describedby');
  });

  it('is disabled on arrival when this account reminded within the last 24 hours', () => {
    localStorage.setItem(`jale.hire-remind.${APP}.acct-worker`, String(Date.now() - 60 * 60 * 1000));
    renderCard();
    expect(remindButton()).toBeDisabled();
    expect(screen.getByText(new RegExp(message('worker_application_details.hired_card.remind_recent')))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(plural('worker_application_details.hired_card.remind_wait', 23)))).toBeInTheDocument();
  });

  it('is disabled on arrival when the server says the employer was reminded two hours ago, with no marker on this device', () => {
    renderCard(hire({ employer_reminded_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
    expect(remindButton()).toBeDisabled();
    expect(screen.getByText(new RegExp(message('worker_application_details.hired_card.remind_recent')))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(plural('worker_application_details.hired_card.remind_wait', 22)))).toBeInTheDocument();
  });

  it('offers Remind again when the server\'s last reminder is over 24 hours old', () => {
    renderCard(hire({ employer_reminded_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
    expect(remindButton()).toBeEnabled();
  });

  it('uses the later of the server reminder and this device\'s marker', () => {
    localStorage.setItem(`jale.hire-remind.${APP}.acct-worker`, String(Date.now() - 60 * 60 * 1000));
    renderCard(hire({ employer_reminded_at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString() }));
    expect(remindButton()).toBeDisabled();
    expect(screen.getByText(new RegExp(plural('worker_application_details.hired_card.remind_wait', 23)))).toBeInTheDocument();
  });

  it('turns a 429 into a disabled button with the wait the server names', async () => {
    remindEmployer.mockRejectedValue(new ApiError(429, 'rate_limited', { retry_after_seconds: 7200 }));
    const user = userEvent.setup();
    renderCard();

    await user.click(remindButton());

    await waitFor(() => expect(remindButton()).toBeDisabled());
    expect(screen.getByText(new RegExp(plural('worker_application_details.hired_card.remind_wait', 2)))).toBeInTheDocument();
  });
});

describe('HiredCard — message box (K4.3)', () => {
  it('sends the trimmed message once, clears the box and lists it as sent', async () => {
    sendApplicationMessage.mockResolvedValue({ conversation_id: 'c1', message_id: 'm1', sent_at: '2026-10-14T15:42:00Z' });
    const user = userEvent.setup();
    renderCard();

    await user.type(messageBox(), '  On my way  ');
    await user.dblClick(sendButton());

    await waitFor(() => expect(screen.getByText('On my way')).toBeInTheDocument());
    expect(sendApplicationMessage).toHaveBeenCalledTimes(1);
    expect(sendApplicationMessage).toHaveBeenCalledWith(TOKEN, APP, { body: 'On my way' });
    expect(messageBox()).toHaveValue('');
    expect(screen.getByText(/Message sent ·/)).toBeInTheDocument();
  });

  it('says how long to wait on a 429 (T-a)', async () => {
    sendApplicationMessage.mockRejectedValue(new ApiError(429, 'rate_limited', { retry_after_seconds: 1800 }));
    const user = userEvent.setup();
    renderCard();

    await user.type(messageBox(), 'Hello');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(plural('worker_application_details.hired_card.message_rate_limited', 30));
    // The draft survives a refusal.
    expect(messageBox()).toHaveValue('Hello');
  });

  it('refuses an empty message without a request', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.type(messageBox(), '   ');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(message('worker_application_details.hired_card.message_empty'));
    expect(sendApplicationMessage).not.toHaveBeenCalled();
  });

  it('caps the box at 2,000 characters', () => {
    renderCard();
    expect(messageBox()).toHaveAttribute('maxLength', '2000');
  });

  it('says so when the application is no longer hired', async () => {
    sendApplicationMessage.mockRejectedValue(new ApiError(409, 'not_hired'));
    const user = userEvent.setup();
    renderCard();
    await user.type(messageBox(), 'Hello');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(message('worker_application_details.hired_card.not_hired'));
  });
});

describe('HiredCard — sent message history (K4.3)', () => {
  const EARLIER: SentMessageRecord[] = [
    { message_id: 'm-old-1', body: 'First note from before', sent_at: '2026-10-13T15:00:00Z' },
    { message_id: 'm-old-2', body: 'Second note from before', sent_at: '2026-10-13T16:00:00Z' },
  ];

  it('lists the messages the state already carries, oldest first', () => {
    renderCard(hire(), EARLIER);

    const first = screen.getByText('First note from before');
    const second = screen.getByText('Second note from before');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts this visit\'s sends after the persisted ones', async () => {
    sendApplicationMessage.mockResolvedValue({ conversation_id: 'c1', message_id: 'm-new', sent_at: '2026-10-14T15:42:00Z' });
    const user = userEvent.setup();
    renderCard(hire(), EARLIER);

    await user.type(messageBox(), 'Fresh note');
    await user.click(sendButton());

    const fresh = await screen.findByText('Fresh note');
    const last = screen.getByText('Second note from before');
    expect(last.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not show a send twice when its id is already in the state', async () => {
    sendApplicationMessage.mockResolvedValue({ conversation_id: 'c1', message_id: 'm-old-2', sent_at: '2026-10-13T16:00:00Z' });
    const user = userEvent.setup();
    renderCard(hire(), EARLIER);

    await user.type(messageBox(), 'Second note from before');
    await user.click(sendButton());

    await waitFor(() => expect(messageBox()).toHaveValue(''));
    expect(screen.getAllByText('Second note from before')).toHaveLength(1);
  });
});
