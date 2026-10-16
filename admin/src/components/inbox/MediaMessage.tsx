'use client';

import { useEffect, useId, useState } from 'react';
import { FileText, Image as ImageIcon, Mic } from 'lucide-react';
import type { ConversationMessage } from '@/lib/server/support-conversation';
import { useInboxActions } from './inbox-actions-context';
import { inboxActionMessage, mediaLabel, mediaLinkLifetimeText } from './inbox-view';
import { DANGER_TEXT, FOCUS_RING, MUTED, TEXT_LINK } from './styles';

type MediaItem = Extract<ConversationMessage, { kind: 'media' }>;
const ICONS = { image: ImageIcon, audio: Mic, document: FileText } as const;

/**
 * A worker photo, voice note or document. The admin CSP blocks remote images,
 * and the file is personal, so it is never embedded. A button asks the server
 * for a short-lived link (recorded) and opens it in a new tab with no opener.
 */
export function MediaMessage({ caseId, message }: { caseId: string; message: MediaItem }) {
  const { pending, run } = useInboxActions();
  const [expired, setExpired] = useState(message.expired);
  const [link, setLink] = useState<{ url: string; expiresAt: string; lifetime: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();
  const label = mediaLabel(message.mediaType);
  const MediaIcon = ICONS[message.mediaType];

  // The link stops working when the presign expires, so it is dropped then.
  useEffect(() => {
    if (!link) return undefined;
    const timer = window.setTimeout(() => setLink(null), Math.max(0, Date.parse(link.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [link]);

  async function open() {
    setProblem(null);
    const result = await run({ action: 'open_media', caseId, mediaId: message.mediaId });
    if (result.ok && result.kind === 'media') {
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setLink({ url: result.url, expiresAt: result.expiresAt, lifetime: mediaLinkLifetimeText(result.expiresAt, Date.now()) });
      return;
    }
    if (!result.ok && result.error === 'media_expired') setExpired(true);
    setProblem(inboxActionMessage('open_media', result)?.text ?? null);
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {expired ? (
        <p className="inline-flex items-center gap-2 text-sm text-[var(--jale-ink-2)]">
          <MediaIcon aria-hidden="true" className="size-4 shrink-0" />
          {label} · Removed after 90 days
        </p>
      ) : (
        <>
          <button
            aria-describedby={hintId}
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--jale-paper-2)] px-3.5 text-left text-sm font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper)] disabled:opacity-50 ${FOCUS_RING}`}
            disabled={pending !== null}
            onClick={() => { void open(); }}
            type="button"
          >
            <MediaIcon aria-hidden="true" className="size-4 shrink-0" />
            {label} · open privately
          </button>
          <span className="sr-only" id={hintId}>Opens in a new tab. Opening it is recorded.</span>
        </>
      )}
      {message.caption ? <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{message.caption}</p> : null}
      {link ? (
        <p className={MUTED}>
          If no new tab opened, <a className={TEXT_LINK} href={link.url} rel="noopener noreferrer" target="_blank">open the file</a>. {link.lifetime}
        </p>
      ) : null}
      {problem ? <p className={DANGER_TEXT} role="alert">{problem}</p> : null}
    </div>
  );
}
