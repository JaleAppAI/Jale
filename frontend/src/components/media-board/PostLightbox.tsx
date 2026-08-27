'use client';
import * as React from 'react';
import { useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';
import type { WorkerPost } from '@/lib/api/worker';

export function PostLightbox({
  post,
  editable,
  onClose,
  onDelete,
}: {
  post: WorkerPost;
  editable: boolean;
  onClose: () => void;
  onDelete?: (postId: string) => Promise<void>;
}) {
  const t = useTranslations('media_board');
  const format = useFormatter();
  const [index, setIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const media = post.media;
  const current = media[index];

  async function handleDelete() {
    if (!onDelete || !window.confirm(t('delete_confirm'))) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(post.id);
    } catch {
      setDeleteError(t('delete_error'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md">
      {/* Negative margins cancel Modal's own content padding so the image
          bleeds to the panel's edges (and rounded corners) exactly as this
          dialog did before it moved onto Modal; only this block opts out —
          the caption/meta section below keeps Modal's standard padding. */}
      <div className="-mx-5 -mt-4">
        <div className="relative aspect-square bg-black">
          {current && (
            <img src={current.url} alt={post.caption ?? ''} className="h-full w-full object-contain" />
          )}
          {media.length > 1 && (
            <>
              <button
                type="button"
                aria-label={t('prev')}
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white disabled:opacity-30"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label={t('next')}
                disabled={index === media.length - 1}
                onClick={() => setIndex((i) => Math.min(media.length - 1, i + 1))}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white disabled:opacity-30"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
                {media.map((m, i) => (
                  <span
                    key={m.id}
                    className={`h-1.5 w-1.5 rounded-full ${i === index ? 'bg-white' : 'bg-white/40'}`}
                  />
                ))}
              </div>
            </>
          )}
          {editable && current?.moderation_status === 'flagged' && (
            <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs font-semibold text-white">
              {t('hidden_badge')}
            </span>
          )}
          <button
            type="button"
            aria-label={t('close')}
            onClick={onClose}
            className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="space-y-2 pt-3">
        {post.caption && <p className="text-sm text-[var(--jale-ink)]">{post.caption}</p>}
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--jale-ink-2)]">
            {format.dateTime(new Date(post.created_at), { dateStyle: 'medium' })}
          </span>
          {editable && onDelete && (
            <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleting}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {t('delete')}
            </Button>
          )}
        </div>
        {deleteError && <InlineFeedback tone="danger">{deleteError}</InlineFeedback>}
      </div>
    </Modal>
  );
}
