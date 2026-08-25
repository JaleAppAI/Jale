'use client';

import * as React from 'react';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { JobStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import type { PlanLimitCta, PlanLimitModel } from '@/lib/plan-limit';

/**
 * The three faces of a reached plan limit.
 *
 * `lib/plan-limit` decides WHAT to say (which sentence, which jobs are holding
 * the slots, which ways out exist); all this file does is look those keys up
 * and lay them out. Nothing here inspects an error or a plan code.
 *
 * Three exports because the same model has to render in two very different
 * places, and one of them may NOT be a dialog:
 *
 *  - `PlanLimitDialog` — the standalone case. The employer pressed something on
 *    a normal page (Resume job) and the plan said no.
 *  - `PlanLimitNotice` — the same content INSIDE a modal that is already open
 *    (PostJobModal, TemplateEditModal). A nested `Modal` would break both of
 *    them: `ui/modal.tsx` installs a document-level CAPTURE keydown listener,
 *    so two open modals would both claim Escape and both try to contain Tab.
 *  - `PlanLimitBody` — the shared middle, so the two never drift apart.
 *
 * Unlike `CloseJobDialog`, this dialog performs no mutation. There is nothing
 * in flight to protect, so every dismissal route stays live at all times:
 * Escape, the backdrop, the header X and "Not now" all just close it.
 */

/**
 * Anchors styled as buttons, because `Button` renders a `<button>` and an `<a>`
 * may not contain interactive content. Same recipe as `ui/empty-state.tsx`'s
 * `StateAction`, at the `sm` size so the row matches the footer's "Not now".
 */
const ctaPillBase = [
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold',
  'cursor-pointer select-none whitespace-nowrap leading-none',
  'transition-all duration-150',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
  'active:scale-[0.98]',
  'h-9 px-4 text-xs',
].join(' ');

const ctaPillTones = {
  primary: 'bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]',
  outline: 'border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
} as const;

/** The in-modal CTA look: an underlined link, not a pill. */
const ctaLinkClass = 'inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2';

/** Upgrade is the paid way out, so it gets the filled pill; the rest are outline. */
function ctaTone(cta: PlanLimitCta): 'primary' | 'outline' {
  return cta.kind === 'upgrade' ? 'primary' : 'outline';
}

/**
 * The body of a limit message: the sentence, the jobs holding the slots, and
 * the one-line hint about how to free one.
 *
 * `onNavigate` lets the surrounding surface tear itself down when a link is
 * followed — a dialog closes, a wizard resets — which the links themselves
 * cannot know to do.
 */
export function PlanLimitBody({
  model,
  loadingJobs = false,
  onNavigate,
  showSentence = true,
}: {
  model: PlanLimitModel;
  loadingJobs?: boolean;
  onNavigate?: () => void;
  /**
   * False when the surrounding surface has already said it in its own words.
   * `PlanLimitNotice`'s `title` override is the only case: "Your template won't
   * be saved — your plan allows 3 template(s)" and `body_templates` are the
   * same sentence twice, in both locales.
   */
  showSentence?: boolean;
}) {
  const tBilling = useTranslations('billing');
  // `jobs.status.*` is the employer-wide job-status vocabulary, read-only here:
  // the badge beside a blocking job must read exactly as it does on the
  // dashboard card for that same job.
  const tShared = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');

  return (
    <div className="flex flex-col gap-3">
      {showSentence ? (
        <p className="text-sm leading-6 text-[var(--jale-ink-2)]">
          {/* The plan name is a NOUN rendered beside the sentence, never spliced
              into it: `plan_name.employer_free` is "Free"/"Gratis", and the two
              languages do not agree on where a plan name goes in a sentence. */}
          {model.planNameKey ? (
            <>
              <strong className="font-bold text-[var(--jale-ink)]">{tBilling(model.planNameKey)}</strong>
              {' · '}
            </>
          ) : null}
          {tBilling(model.bodyKey, model.bodyParams)}
        </p>
      ) : null}

      {model.blockingJobs.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {tBilling('limit_dialog.blocking_heading')}
          </p>
          <ul className="flex flex-col gap-1.5">
            {model.blockingJobs.map((blocking) => (
              <li
                key={blocking.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] px-3.5 py-2.5"
              >
                <Link
                  href={`/employer/jobs/${blocking.id}`}
                  onClick={onNavigate}
                  className="min-w-0 truncate text-sm font-bold text-[var(--jale-ink)] hover:underline"
                >
                  {blocking.title}
                </Link>
                <JobStatusBadge status="active">{tShared('jobs.status.active')}</JobStatusBadge>
              </li>
            ))}
          </ul>
          {/* Inside the list branch on purpose: "and 3 more" with no list above
              it reads as a rendering fault, and the count is nonzero exactly
              when the jobs fetch never landed. */}
          {model.overflowCount > 0 ? (
            <p className="text-xs text-[var(--jale-ink-2)]">
              {tBilling('limit_dialog.and_more', { count: model.overflowCount })}
            </p>
          ) : null}
        </div>
      ) : loadingJobs ? (
        // Sole indication that something is happening, so the spinner announces
        // itself rather than spinning silently.
        <div className="flex items-center gap-2 text-[var(--jale-ink-2)]">
          <Spinner size="sm" label={tCommon('loading')} />
        </div>
      ) : null}

      <p className="text-xs text-[var(--jale-ink-2)]">{tBilling(model.hintKey)}</p>
    </div>
  );
}

/**
 * The standalone dialog. The PARENT owns `open` and mounts this unconditionally
 * — see the comment beside `DeleteJobDialog` on the employer dashboard: a
 * dialog keyed by record id mounts already-open and never receives focus.
 */
export function PlanLimitDialog({
  open,
  model,
  loadingJobs = false,
  onClose,
}: {
  open: boolean;
  model: PlanLimitModel | null;
  loadingJobs?: boolean;
  onClose: () => void;
}) {
  const tBilling = useTranslations('billing');
  // Open on the dismiss, not on a CTA: the safe action is staying put, and
  // without this `Modal` lands focus on the header's X.
  const notNowRef = useRef<HTMLButtonElement>(null);

  if (!model) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tBilling('limit_dialog.title')}
      size="sm"
      initialFocusRef={notNowRef}
      footer={
        <>
          <Button ref={notNowRef} variant="ghost" size="sm" onClick={onClose}>
            {tBilling('limit_dialog.dismiss')}
          </Button>
          {model.ctas.map((cta) => (
            <Link
              key={cta.kind}
              href={cta.href}
              // The dialog is leaving the screen either way; closing it here
              // keeps it from being restored over the route we just opened.
              onClick={onClose}
              className={`${ctaPillBase} ${ctaPillTones[ctaTone(cta)]}`}
            >
              {cta.kind === 'upgrade' ? <Icon name="spark" /> : null}
              {tBilling(cta.labelKey)}
            </Link>
          ))}
        </>
      }
    >
      <PlanLimitBody model={model} loadingJobs={loadingJobs} onNavigate={onClose} />
    </Modal>
  );
}

/**
 * The in-modal form of the same message.
 *
 * `title` overrides the "Plan limit reached" heading for the one case that is
 * not a hard stop: PostJobModal's pre-check, where the job still posts and only
 * the template is dropped. `actions` is that case's escape hatch ("Post without
 * saving template"), rendered before the CTAs because it is what most employers
 * will actually want.
 */
export function PlanLimitNotice({
  model,
  className = '',
  actions,
  title,
  onNavigate,
}: {
  model: PlanLimitModel | null;
  className?: string;
  actions?: React.ReactNode;
  title?: React.ReactNode;
  onNavigate?: () => void;
}) {
  const tBilling = useTranslations('billing');

  if (!model) return null;

  return (
    // No `onDismiss`: the limit is still true after you wave it away, and this
    // is the only thing on screen explaining why the save did not happen.
    <InlineFeedback tone="danger" className={className}>
      <span className="flex flex-col gap-2">
        <span className="font-bold">{title ?? tBilling('limit_dialog.title')}</span>

        {/* A caller that brought its own title line has already stated the cap;
            the model's sentence would only say it a second time. */}
        <PlanLimitBody model={model} onNavigate={onNavigate} showSentence={title === undefined} />

        <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {actions}
          {model.ctas.map((cta) => (
            <Link key={cta.kind} href={cta.href} onClick={onNavigate} className={ctaLinkClass}>
              {cta.kind === 'upgrade' ? <Icon name="spark" /> : null}
              {tBilling(cta.labelKey)}
            </Link>
          ))}
        </span>
      </span>
    </InlineFeedback>
  );
}
