'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Layers } from 'lucide-react';
import type { WorkerPost } from '@/lib/api/worker';

/**
 * Instagram-style square grid. Tiles show the post's first image; multi-image
 * posts get a stack icon; flagged images get a "hidden from employers" badge
 * on the worker's own (editable) board only — employers never receive
 * flagged media from the API at all.
 */
export function MediaBoardGrid({
  posts,
  editable,
  onSelect,
}: {
  posts: WorkerPost[];
  editable: boolean;
  onSelect: (post: WorkerPost) => void;
}) {
  const t = useTranslations('media_board');

  if (posts.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-[var(--jale-ink-2)]">{t('empty')}</p>;
  }

  return (
    <div className="grid grid-cols-3 gap-1 sm:gap-2">
      {posts.map((post) => {
        const cover = post.media[0];
        if (!cover) return null;
        return (
          <button
            key={post.id}
            type="button"
            aria-label={post.caption ? `${t('open_post')}: ${post.caption}` : t('open_post')}
            onClick={() => onSelect(post)}
            className="group relative aspect-square overflow-hidden rounded-[var(--radius-input)] bg-[var(--jale-divider)] focus:outline-none focus-visible:ring-2"
          >
            {/* next/image is configured unoptimized; plain img matches presigned URLs */}
            <img
              src={cover.url}
              alt={post.caption ?? ''}
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
            />
            {post.media.length > 1 && (
              <Layers aria-hidden className="absolute right-1.5 top-1.5 h-4 w-4 text-white drop-shadow" />
            )}
            {editable && cover.moderation_status === 'flagged' && (
              <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[10px] font-semibold text-white">
                {t('hidden_badge')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
