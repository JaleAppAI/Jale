'use client';
import * as React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  getPostUploadUrls,
  createPost,
  uploadFileToS3,
} from '@/lib/api/worker';
import { downscaleImage } from '@/lib/image-resize';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTOS = 10;
/** Matches the DB CHECK constraint on posts.caption (migration 082). */
const MAX_CAPTION_LENGTH = 1000;

type Picked = { file: File; previewUrl: string };

export function NewPostModal({
  token,
  onClose,
  onCreated,
}: {
  token: string;
  onClose: () => void;
  onCreated: (flaggedCount: number) => void;
}) {
  const t = useTranslations('media_board');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (files.some((f) => !ALLOWED_TYPES.includes(f.type))) {
      setError(t('file_type_error'));
      return;
    }
    if (picked.length + files.length > MAX_PHOTOS) {
      setError(t('max_photos_error'));
      return;
    }
    setPicked((prev) => [
      ...prev,
      ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ]);
    e.target.value = '';
  }

  function removeAt(i: number) {
    setPicked((prev) => {
      URL.revokeObjectURL(prev[i].previewUrl);
      return prev.filter((_, j) => j !== i);
    });
  }

  async function handlePublish() {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resized = await Promise.all(picked.map((p) => downscaleImage(p.file)));
      const { post_id, uploads } = await getPostUploadUrls(
        token,
        resized.map((f) => ({ mime_type: f.type, file_size: f.size })),
      );
      await Promise.all(resized.map((f, i) => uploadFileToS3(uploads[i].url, f)));
      const { flagged_count } = await createPost(
        token,
        post_id,
        caption.trim() || null,
        uploads.map((u, i) => ({ s3_key: u.s3_key, sort_order: i })),
      );
      picked.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      onCreated(flagged_count);
    } catch {
      setError(t('upload_error'));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('new_post')}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={handlePublish} disabled={busy || picked.length === 0}>
            {busy ? t('publishing') : t('publish')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="sr-only">{t('select_photos')}</span>
          <input
            data-testid="post-file-input"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            onChange={handlePick}
            className="block w-full text-sm"
            disabled={busy}
          />
        </label>

        {picked.length > 0 && (
          <div className="grid grid-cols-5 gap-2">
            {picked.map((p, i) => (
              <div key={p.previewUrl} className="relative aspect-square overflow-hidden rounded">
                <img src={p.previewUrl} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={t('remove_photo', { n: i + 1 })}
                  onClick={() => removeAt(i)}
                  disabled={busy}
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t('caption_placeholder')}
          maxLength={MAX_CAPTION_LENGTH}
          rows={3}
          disabled={busy}
          className="w-full rounded-[var(--radius-input)] border border-[var(--jale-divider)] p-2 text-sm"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
