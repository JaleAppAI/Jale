import { templatePreviewParts } from './inbox-view';
import { PANEL_TITLE } from './styles';

/**
 * What the worker sees when the reply rides the approved template (K2.4
 * templatePreview). The template's own quote marks are in before/after.
 */
export function TemplatePreview({ preview, text }: { preview: { before: string; after: string }; text: string }) {
  const parts = templatePreviewParts(preview, text);
  return (
    <div className="rounded-[var(--radius-input)] border border-dashed border-[var(--jale-divider)] px-3.5 py-3 text-sm leading-relaxed text-[var(--jale-ink-2)]">
      <p className={PANEL_TITLE}>Worker will see</p>
      <p className="mt-1 [overflow-wrap:anywhere]">{parts.before}<em className="text-[var(--jale-ink)]">{parts.reply ?? 'your reply'}</em>{parts.after}</p>
    </div>
  );
}
