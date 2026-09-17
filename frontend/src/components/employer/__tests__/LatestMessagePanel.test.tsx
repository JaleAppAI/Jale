// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

/*
 * The dashboard's WhatsApp panel.
 *
 * It printed one fixed paragraph under the most recent job's title -- true,
 * and identical on the day a worker replied and the day nobody did. The
 * dashboard is where employers spend their time, so that panel was the largest
 * place in the product where a waiting message was invisible.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

let unreadState: {
    items: import('@/lib/api/employer').InboxItem[];
    unreadCount: number;
    loading: boolean;
    errorKind?: 'offline' | 'server' | null;
};
vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        unreadByConversation: {},
        errorKind: null,
        ...unreadState,
        retry: vi.fn(),
        refresh: vi.fn(),
        markRead: vi.fn(),
    }),
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { LatestMessagePanel } from '@/components/employer/LatestMessagePanel';
import type { InboxItem } from '@/lib/api/employer';

const NOW = new Date('2026-09-16T12:00:00Z');

function inboxItem(overrides: Partial<InboxItem> & { application_id: string }): InboxItem {
    return {
        worker_id: 'w-1',
        worker_name: 'Maria Garcia',
        job_id: 'job-1',
        job_title: 'Line Cook',
        job_city: 'Austin',
        job_state_region: 'TX',
        job_status: 'active',
        application_status: 'contacted',
        applied_at: '2026-09-10T00:00:00Z',
        conversation_id: null,
        conversation_status: null,
        last_message_at: null,
        last_worker_message_at: null,
        last_message_preview: null,
        tab: 'active',
        unread: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    unreadState = { items: [], unreadCount: 0, loading: false };
});

afterEach(() => {
    vi.useRealTimers();
});

describe('LatestMessagePanel', () => {
    it('shows the newest message: who, which job, what they said, and when', () => {
        unreadState = {
            loading: false,
            unreadCount: 2,
            items: [
                inboxItem({
                    application_id: 'app-old',
                    worker_name: 'Jose Ruiz',
                    conversation_id: 'conv-2',
                    conversation_status: 'open',
                    last_message_at: '2026-09-14T12:00:00Z',
                    last_message_preview: 'Older note',
                }),
                inboxItem({
                    application_id: 'app-new',
                    conversation_id: 'conv-1',
                    conversation_status: 'open',
                    last_message_at: '2026-09-16T10:00:00Z',
                    last_message_preview: 'I can start Monday',
                    unread: true,
                }),
            ],
        };

        renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        expect(screen.getByText('Maria Garcia')).toBeInTheDocument();
        expect(screen.getByText('Line Cook · Austin')).toBeInTheDocument();
        expect(screen.getByText('I can start Monday')).toBeInTheDocument();
        // Newest, not first in the array.
        expect(screen.queryByText('Older note')).not.toBeInTheDocument();
        // Two hours before the fixed "now" above.
        expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
        // The static paragraph is gone while there is something real to say.
        expect(screen.queryByText(message('employer_dashboard.panels.whatsapp_body'))).not.toBeInTheDocument();
    });

    it('catches up with a message that arrives after it mounted', async () => {
        // Nothing yet, so the panel mounts on its empty state with "now" = NOW.
        const { rerender } = renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        // 30s later the inbox poll lands a reply. A `useNow()` frozen at mount
        // would compare it against a moment BEFORE it existed and print "in 30
        // seconds" -- a message from the future, on the panel whose one job is
        // to say a worker has written.
        vi.setSystemTime(new Date(NOW.getTime() + 30_000));
        unreadState = {
            loading: false,
            unreadCount: 1,
            items: [
                inboxItem({
                    application_id: 'app-new',
                    conversation_id: 'conv-1',
                    conversation_status: 'open',
                    last_message_at: new Date(NOW.getTime() + 20_000).toISOString(),
                    last_message_preview: 'Just replied',
                    unread: true,
                }),
            ],
        };
        await act(async () => {
            // Past the panel's own refresh interval, so "now" moves with the
            // clock instead of staying where the mount left it.
            await vi.advanceTimersByTimeAsync(61_000);
        });
        rerender(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        expect(screen.getByText('Just replied')).toBeInTheDocument();
        expect(screen.queryByText(/^in /)).not.toBeInTheDocument();
        expect(screen.getByText(/ago$/)).toBeInTheDocument();
    });

    it('puts the unread count in the panel header', () => {
        unreadState = {
            loading: false,
            unreadCount: 2,
            items: [
                inboxItem({
                    application_id: 'app-new',
                    conversation_id: 'conv-1',
                    conversation_status: 'open',
                    last_message_at: '2026-09-16T10:00:00Z',
                    last_message_preview: 'I can start Monday',
                    unread: true,
                }),
            ],
        };

        renderIntl(<LatestMessagePanel fallbackJobTitle={null} />);

        expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('ignores a thread that exists but has no message in it yet', () => {
        unreadState = {
            loading: false,
            unreadCount: 0,
            items: [
                inboxItem({
                    application_id: 'app-1',
                    conversation_id: 'conv-1',
                    conversation_status: 'open',
                }),
            ],
        };

        renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        expect(screen.getByText(message('employer_dashboard.panels.whatsapp_body'))).toBeInTheDocument();
    });

    it('keeps the old copy, and the recent job title, as its empty state', () => {
        renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        expect(screen.getByText('Drywall Finisher')).toBeInTheDocument();
        expect(screen.getByText(message('employer_dashboard.panels.whatsapp_body'))).toBeInTheDocument();
        // No badge over an empty inbox.
        expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('says there is no recent job when there is not one either', () => {
        renderIntl(<LatestMessagePanel fallbackJobTitle={null} />);

        expect(screen.getByText(message('employer_dashboard.panels.no_recent_job'))).toBeInTheDocument();
    });

    it('says the inbox could not be read rather than that it is empty', () => {
        unreadState = { items: [], unreadCount: 0, loading: false, errorKind: 'offline' };

        renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        // "We could not read your inbox" and "nothing is waiting for you" are
        // opposite claims, and only one of them is safe to guess at.
        expect(screen.queryByText(message('employer_dashboard.panels.whatsapp_body'))).not.toBeInTheDocument();
        expect(screen.getByText(message('common.error_state.offline_title'))).toBeInTheDocument();
    });

    it('shows placeholders rather than an empty state while the inbox loads', () => {
        unreadState = { items: [], unreadCount: 0, loading: true };

        renderIntl(<LatestMessagePanel fallbackJobTitle="Drywall Finisher" />);

        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.queryByText(message('employer_dashboard.panels.whatsapp_body'))).not.toBeInTheDocument();
    });
});
