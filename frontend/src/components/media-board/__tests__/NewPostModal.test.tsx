import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { NewPostModal } from '../NewPostModal';
import en from '@/messages/en.json';
import * as workerApi from '@/lib/api/worker';
import * as resize from '@/lib/image-resize';

vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof workerApi>()),
  getPostUploadUrls: vi.fn(),
  createPost: vi.fn(),
  uploadFileToS3: vi.fn(),
}));
vi.mock('@/lib/image-resize', () => ({ downscaleImage: vi.fn(async (f: File) => f) }));
const wrap = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>
);

const jpeg = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

describe('NewPostModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workerApi.getPostUploadUrls as ReturnType<typeof vi.fn>).mockResolvedValue({
      post_id: 'p1',
      uploads: [{ url: 'https://s3/put1', s3_key: 'w/posts/p1/a.jpg' }],
    });
    (workerApi.createPost as ReturnType<typeof vi.fn>).mockResolvedValue({ flagged_count: 0 });
    (workerApi.uploadFileToS3 as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('renders a visible, labeled upload control (not a bare file input)', () => {
    render(wrap(<NewPostModal token="t" onClose={vi.fn()} onCreated={vi.fn()} />));
    // The button-like label and its format hint are visible text now — the
    // old markup hid 'Select photos' behind sr-only next to a naked input.
    expect(screen.getByText('Select photos')).toBeInTheDocument();
    expect(screen.getByText('JPG, PNG or WebP · up to 10 photos')).toBeInTheDocument();
    // The input itself is still present for keyboard/tests but visually hidden.
    expect(screen.getByTestId('post-file-input')).toHaveClass('sr-only');
  });

  it('rejects a non-image file with an error message', async () => {
    render(wrap(<NewPostModal token="t" onClose={vi.fn()} onCreated={vi.fn()} />));
    const input = screen.getByTestId('post-file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(en.media_board.file_type_error)).toBeInTheDocument();
  });

  it('rejects an 11th photo', async () => {
    render(wrap(<NewPostModal token="t" onClose={vi.fn()} onCreated={vi.fn()} />));
    const input = screen.getByTestId('post-file-input');
    const files = Array.from({ length: 11 }, (_, i) => jpeg(`f${i}.jpg`));
    fireEvent.change(input, { target: { files } });
    expect(await screen.findByText(en.media_board.max_photos_error)).toBeInTheDocument();
  });

  it('runs downscale → presign → PUT → create and reports success', async () => {
    const onCreated = vi.fn();
    render(wrap(<NewPostModal token="t" onClose={vi.fn()} onCreated={onCreated} />));
    fireEvent.change(screen.getByTestId('post-file-input'), { target: { files: [jpeg('a.jpg')] } });
    fireEvent.change(screen.getByPlaceholderText(en.media_board.caption_placeholder), {
      target: { value: 'tile work' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.media_board.publish }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(0));
    expect(resize.downscaleImage).toHaveBeenCalledTimes(1);
    expect(workerApi.getPostUploadUrls).toHaveBeenCalledWith('t', [{ mime_type: 'image/jpeg', file_size: 1 }]);
    expect(workerApi.uploadFileToS3).toHaveBeenCalledWith('https://s3/put1', expect.any(File));
    expect(workerApi.createPost).toHaveBeenCalledWith('t', 'p1', 'tile work', [
      { s3_key: 'w/posts/p1/a.jpg', sort_order: 0 },
    ]);
  });

  it('shows upload_error and resets busy when the S3 PUT fails', async () => {
    (workerApi.uploadFileToS3 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net'));
    render(wrap(<NewPostModal token="t" onClose={vi.fn()} onCreated={vi.fn()} />));
    fireEvent.change(screen.getByTestId('post-file-input'), { target: { files: [jpeg('a.jpg')] } });
    fireEvent.click(screen.getByRole('button', { name: en.media_board.publish }));
    expect(await screen.findByText(en.media_board.upload_error)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.media_board.publish })).toBeEnabled();
  });
});
