'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { TrustExtraction } from '@/lib/api/employer';

/**
 * What the AI read out of the worker's own trust answers (migration 086).
 *
 * Sits directly ABOVE the raw question-and-answer list on the applicant page,
 * and that order is the point: the chips are a fast way in, the answers
 * underneath are the evidence. An employer who distrusts the summary is one
 * scroll from the sentences it was drawn from.
 *
 * The copy never says "verified" and never will. Every label here comes from
 * a model reading what one person typed or said about themselves; nothing was
 * checked against a licence, an employer or a certificate. "From their
 * answers" is the strongest claim this panel is entitled to make.
 *
 * `score_rationale` is a separate matter and is not merely unrendered here --
 * the API does not select it at all.
 */

/** Rendered in this order, which reads as: what they can do, what with, and how safely. */
const EXTRACTION_GROUPS = [
  'skills',
  'tools',
  'experience_signals',
  'safety',
  'notable',
] as const;

export function AnswerHighlights({ extraction }: { extraction: TrustExtraction | null }) {
  const t = useTranslations('employer_worker_profile');
  const locale = useLocale();

  // No assessment, or none extracted yet: the panel below still shows the
  // score and the answers, and an empty eyebrow over nothing would read as a
  // section that failed to load.
  if (!extraction) return null;

  const eyebrow = (
    <p className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
      {t('extraction_title')}
    </p>
  );

  // `failed` deliberately lands here with `pending`/`extracting`. The failure
  // string is an internal model/runtime detail the API does not even select,
  // so there is nothing truthful to say beyond "not ready" -- and a red error
  // would read as a judgement of the WORKER rather than of our pipeline.
  if (extraction.status !== 'completed') {
    return (
      <div className="mt-4">
        {eyebrow}
        <p className="mt-1 text-sm text-[var(--jale-ink-2)]">{t('extraction_pending')}</p>
      </div>
    );
  }

  // Deduped by the displayed label: the same phrase can legitimately appear in
  // two groups (lockout/tagout is both a skill and a safety signal) and two
  // identical chips side by side read as a rendering bug.
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const group of EXTRACTION_GROUPS) {
    for (const item of extraction.extracted[group] ?? []) {
      const label = (locale === 'es' ? item.label_es : item.label_en)?.trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
  }

  const summary = (locale === 'es' ? extraction.summary_es : extraction.summary_en)?.trim() || null;

  // A completed row with nothing in it is possible (a worker who answered in
  // three words). Better to say nothing than to head an empty box.
  if (labels.length === 0 && !summary) return null;

  return (
    <div className="mt-4">
      {eyebrow}

      {labels.length > 0 ? (
        // `neutral`, where the worker's own declared skills panel uses `info`:
        // the two lists sit on the same page and an employer should be able to
        // tell "what they told us they do" from "what we read into it".
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
          {labels.map((label) => (
            <Badge key={label} tone="neutral">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}

      {summary ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--jale-ink-2)]">{summary}</p>
      ) : null}
    </div>
  );
}
