import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MediaBoardGrid } from '../MediaBoardGrid';
import en from '@/messages/en.json';
import type { WorkerPost } from '@/lib/api/worker';

const post = (id: string, media: Partial<WorkerPost['media'][number]>[]): WorkerPost => ({
  id, caption: null, source: 'web', created_at: '2026-08-22T00:00:00Z',
  media: media.map((m, i) => ({ id: `${id}-m${i}`, url: `https://img/${id}/${i}`, sort_order: i, moderation_status: 'approved', ...m })),
});

const wrap = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>
);

describe('MediaBoardGrid', () => {
  it('renders the empty state when there are no posts', () => {
    render(wrap(<MediaBoardGrid posts={[]} editable onSelect={vi.fn()} />));
    expect(screen.getByText(en.media_board.empty)).toBeInTheDocument();
  });

  it('renders one tile per post using the first image', () => {
    render(wrap(<MediaBoardGrid posts={[post('a', [{}]), post('b', [{}, {}])]} editable onSelect={vi.fn()} />));
    expect(screen.getAllByRole('button', { name: en.media_board.open_post })).toHaveLength(2);
  });

  it('calls onSelect with the clicked post', () => {
    const onSelect = vi.fn();
    const p = post('a', [{}]);
    render(wrap(<MediaBoardGrid posts={[p]} editable onSelect={onSelect} />));
    fireEvent.click(screen.getByRole('button', { name: en.media_board.open_post }));
    expect(onSelect).toHaveBeenCalledWith(p);
  });

  it('shows the hidden badge on flagged tiles only when editable', () => {
    const flagged = [post('a', [{ moderation_status: 'flagged' }])];
    const { rerender } = render(wrap(<MediaBoardGrid posts={flagged} editable onSelect={vi.fn()} />));
    expect(screen.getByText(en.media_board.hidden_badge)).toBeInTheDocument();
    rerender(wrap(<MediaBoardGrid posts={flagged} editable={false} onSelect={vi.fn()} />));
    expect(screen.queryByText(en.media_board.hidden_badge)).not.toBeInTheDocument();
  });
});
