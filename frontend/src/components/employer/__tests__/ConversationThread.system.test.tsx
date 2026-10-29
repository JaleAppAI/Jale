// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { message, renderIntl } from './render-intl';
import { formatTimeOfDay } from '@/lib/date';

// Same `Link` mock as `ConversationThread.test.tsx`: the real one reaches
// `next/navigation`, which has no resolvable entry under vitest.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { ConversationThread } from '../ConversationThread';
import type {
  EmployerConversationDetail,
  EmployerConversationMessage,
} from '@/lib/api/employer';

const conversation: EmployerConversationDetail = {
  id: 'c-1',
  job_id: 'j-1',
  job_title: 'Line Cook',
  job_city: 'Austin',
  job_state_region: 'TX',
  application_id: 'app-1',
  worker_id: 'w-1',
  worker_name: 'Maria Garcia',
  status: 'open',
  last_message_at: null,
  last_worker_message_at: null,
  last_message_preview: null,
  updated_at: '2026-09-01T00:00:00Z',
};

const CREATED_AT = '2026-09-01T15:30:00Z';

const rows: Record<'employer' | 'worker' | 'system', EmployerConversationMessage> = {
  employer: {
    id: 'm-employer',
    sender_type: 'employer',
    direction: 'outbound',
    body: 'Can you start Monday?',
    status: 'delivered',
    created_at: CREATED_AT,
    sent_at: CREATED_AT,
  },
  worker: {
    id: 'm-worker',
    sender_type: 'worker',
    direction: 'inbound',
    body: 'Yes, I can.',
    status: 'received',
    created_at: CREATED_AT,
    sent_at: null,
  },
  system: {
    id: 'm-system',
    sender_type: 'system',
    // System rows are written outbound (migration 138, closeWorkerConversation).
    direction: 'outbound',
    body: 'Conversación transferida a Pedro / Conversation moved to Pedro',
    status: 'received',
    created_at: CREATED_AT,
    sent_at: null,
  },
};

const time = formatTimeOfDay(CREATED_AT, 'en') ?? '';
const fromWorker = message('employer_messages.from_worker');

describe('ConversationThread system rows', () => {
  it('renders a system row as a note with its body and time, and no worker label', () => {
    renderIntl(
      <ConversationThread conversation={conversation} messages={[rows.system]} onSend={vi.fn()} />,
    );

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(rows.system.body);
    expect(time).not.toBe('');
    expect(note).toHaveTextContent(time);
    expect(within(note).queryByText(new RegExp(fromWorker))).toBeNull();
    expect(screen.queryByText(new RegExp(`^${fromWorker}`))).toBeNull();
  });

  it('has no avatar or status ticks, and marks the time as a time element', () => {
    renderIntl(
      <ConversationThread conversation={conversation} messages={[rows.system]} onSend={vi.fn()} />,
    );

    const note = screen.getByRole('note');
    expect(note.querySelector('.avatar-initials')).toBeNull();
    expect(note).not.toHaveTextContent(message('employer_messages.message_status.delivered'));
    expect(note).not.toHaveTextContent(message('employer_messages.message_status.received'));
    expect(note.querySelector('time')).toHaveAttribute('datetime', CREATED_AT);
  });

  it('keeps the line breaks of a multi-line body', () => {
    const multiline = { ...rows.system, id: 'm-multi', body: 'Conversación transferida a Pedro\nConversation moved to Pedro' };
    renderIntl(
      <ConversationThread conversation={conversation} messages={[multiline]} onSend={vi.fn()} />,
    );

    const body = within(screen.getByRole('note')).getByText(
      (_, el) => el?.tagName === 'P' && el.textContent === multiline.body,
    );
    expect(body.textContent).toContain('\n');
    // `whitespace-pre-wrap` is what makes the newline visible in the browser.
    expect(body.className).toContain('whitespace-pre-wrap');
  });

  it('renders a long unbroken body inside the note and lets it wrap', () => {
    const long = { ...rows.system, id: 'm-long', body: `Conversación transferida a ${'P'.repeat(300)}` };
    renderIntl(
      <ConversationThread conversation={conversation} messages={[long]} onSend={vi.fn()} />,
    );

    const note = screen.getByRole('note');
    const body = within(note).getByText(long.body);
    expect(note).toContainElement(body);
    expect(body.className).toContain('break-words');
  });

  it('renders the note in compact mode too', () => {
    renderIntl(
      <ConversationThread
        conversation={conversation}
        messages={[rows.system]}
        onSend={vi.fn()}
        compact
      />,
    );

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(rows.system.body);
    expect(note).toHaveTextContent(time);
  });

  it('renders the worker-ended-the-conversation row the same way', () => {
    const ended: EmployerConversationMessage = {
      ...rows.system,
      id: 'm-ended',
      body: 'El trabajador terminó la conversación / The worker ended the conversation',
    };
    renderIntl(
      <ConversationThread conversation={conversation} messages={[ended]} onSend={vi.fn()} />,
    );
    expect(screen.getByRole('note')).toHaveTextContent(ended.body);
  });

  it('keeps employer and worker rows as labelled bubbles, next to a notice', () => {
    renderIntl(
      <ConversationThread
        conversation={conversation}
        messages={[rows.employer, rows.system, rows.worker]}
        onSend={vi.fn()}
      />,
    );

    // Exactly one note: the two bubbles are not notes.
    expect(screen.getAllByRole('note')).toHaveLength(1);

    const employerBody = screen.getByText(rows.employer.body);
    expect(employerBody.parentElement?.className).toContain('--primary');
    expect(
      screen.getByText(new RegExp(message('employer_messages.message_status.delivered'))),
    ).toBeInTheDocument();

    const workerBody = screen.getByText(rows.worker.body);
    expect(workerBody.parentElement?.className).toContain('--jale-card');
    expect(screen.getByText(new RegExp(`^${fromWorker} - `))).toBeInTheDocument();
    // Header avatar plus the one beside the worker's bubble.
    expect(screen.getAllByText('MG', { selector: '.avatar-initials' })).toHaveLength(2);
  });
});
