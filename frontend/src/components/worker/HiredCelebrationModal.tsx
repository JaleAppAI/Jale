'use client';
import type { CSSProperties, ReactNode } from 'react';
import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Modal } from '@/components/ui/modal';
import { ConfettiBurst } from '@/components/worker/ConfettiBurst';
import { formatStartDateWeekday } from '@/lib/date';
import { hireTradePhrase, type Translator } from '@/lib/job-detail-display';
import { formatPay } from '@/lib/pay';
import type { ApplicationHire } from '@/lib/api/worker';

/**
 * The one moment the worker app celebrates: the first visit after an employer
 * marked this worker `hired`.
 *
 * It opens ONCE — `hire.seen_at` is written server-side as it closes, so the
 * next visit gets the standing `HiredBanner` instead. Nothing here is
 * dismissible-to-nowhere: every exit route (the CTA, the ×, Escape, the
 * backdrop) runs the same `onClose`, and the page turns that into the receipt.
 *
 * WHY IT DOES NOT USE `Modal`'s `title`
 * -------------------------------------
 * The header is a `--jale-success-bg` block with confetti flying behind the
 * words, which `Modal`'s bordered header row cannot be. So this passes
 * `labelledById` and renders its own heading inside `children` — and that
 * costs the close button `Modal` only draws alongside a `title`, which is why
 * there is a × of our own up there. On a phone, Escape and a backdrop tap are
 * not a way out that anyone finds.
 *
 * The hero's negative margins undo `Modal`'s content padding so the tint
 * bleeds to the panel edge; the panel's own `overflow-hidden` rounds the top
 * corners, and the hero's clips the confetti to the header.
 */

/**
 * Widens a next-intl translator to `job-detail-display`'s structural
 * `Translator`.
 *
 * next-intl's client translator is generic over ITS OWN namespace's message
 * keys, which is narrower than `(key: string, values?) => string` for the
 * `values` parameter, so passing one straight in fails `tsc` (verified). Not a
 * behaviour change -- the call is identical -- just the same thin adapter the
 * worker and employer job-detail pages apply at the same boundary.
 */
function widen(t: unknown): Translator {
  return (key, values) => (t as (k: string, v?: Record<string, unknown>) => string)(key, values);
}

/** One labelled fact. Rendered only when there is something to say. */
function Fact({
  label,
  children,
  muted = false,
}: {
  label: string;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}
      </span>
      <span
        className={[
          'text-sm [overflow-wrap:anywhere]',
          muted
            ? 'font-medium text-[var(--jale-ink-2)]'
            : 'font-semibold text-[var(--jale-ink)]',
        ].join(' ')}
      >
        {children}
      </span>
    </div>
  );
}

export function HiredCelebrationModal({
  open,
  applicationId,
  jobTitle,
  companyName,
  hire,
  onClose,
}: {
  open: boolean;
  applicationId: string;
  jobTitle: string;
  companyName: string;
  hire: ApplicationHire;
  onClose: () => void;
}) {
  const t = useTranslations('worker_applications.hired_celebration');
  const tCommon = useTranslations('common');
  const tPay = useTranslations('pay');
  /*
   * The job trade-category catalogue. `employer_dashboard.modal.trade.*` is
   * the one carrying all eight of migration 023's tokens (`common.trades.*`
   * is missing `drywall` and `general_labor` and would print a raw key path
   * for those two hires), and reading it from a worker surface is established
   * precedent -- `worker/jobs/[id]` and `PayReferenceHint` both do, for
   * exactly this reason, and `hireTradePhrase`'s own doc comment names it.
   */
  const tTrade = useTranslations('employer_dashboard.modal.trade');
  const locale = useLocale();
  const titleId = useId();

  // Date-only value (`YYYY-MM-DD`), so the UTC-pinned formatter -- an instant
  // formatter would tell a worker in Mexico their first day is the day before.
  const startDate = formatStartDateWeekday(hire.start_date, locale);
  // Localized from the structured columns, NOT `hire.pay` verbatim: that one
  // is English free text and may be the "Pay not specified" sentinel. Null
  // means there is genuinely no rate to state, and the fact is dropped.
  const pay = formatPay(hire, tPay);

  /*
   * THE HEADLINE (option A1, owner ruling 2026-09-08).
   *
   * This used to be `t('modal.title', { company: companyName })` over
   * `jobTitle`, and production rendered "Empleador te contrató para welder
   * needed in metta dara enter" -- two separate faults in one sentence:
   *
   *  - `companyName` is the list row's `company_name`, which is
   *    `employer_display_name()` and falls back to the "Empleador"
   *    placeholder (migration 031). Inside a sentence that reads as a company
   *    literally named that. `hire.company` reports the case as `null`
   *    instead, so the copy can choose a company-less wording.
   *  - the job title is FREE TEXT the employer typed. It is still worth
   *    showing (it is the only thing that is always known), but as its own
   *    quiet line -- not as the subject of the celebration.
   *
   * `undefined` and `null` are different answers on `hire.company`: an old
   * backend that never sent the field says nothing about the company, so the
   * legacy prop is still the best available -- sentinel and all. Only an
   * explicit `null` means "there ISN'T one".
   */
  const company = (hire.company === undefined ? companyName : hire.company)?.trim() || null;
  // The trade, folded for the middle of a sentence ("...te contrató como
  // electricista"). Null when the hire names no trade, or names only the
  // empty 'other' escape hatch -- "como Otro" says nothing.
  const trade = hireTradePhrase(hire, locale, widen(tTrade));
  const headline = company
    ? (trade
      ? t('modal.title_trade', { company, trade })
      : t('modal.title', { company }))
    : (trade
      ? t('modal.title_no_company_trade', { trade })
      : t('modal.title_no_company'));

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledById={titleId}
      size="sm"
      footer={
        <>
          {/* `mr-auto` against Modal's `justify-end` footer: the secondary way
              out sits left, the primary right. */}
          <Link
            href={`/worker/applications/${applicationId}`}
            className="mr-auto text-sm font-semibold text-[var(--jale-blue-500)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {t('modal.link')}
          </Link>
          <Button onClick={onClose}>{t('modal.cta')}</Button>
        </>
      }
    >
      <div className="relative -mx-5 -mt-4 mb-4 overflow-hidden bg-[var(--jale-success-bg)] px-6 pb-5 pt-6">
        <ConfettiBurst />

        {/* Above the confetti layer (`z-0`) so a piece can never sit on top of
            the only control in the header. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={tCommon('feedback.dismiss')}
          className="absolute right-2.5 top-2.5 z-10 cursor-pointer rounded p-1.5 leading-none text-[var(--jale-success-text)] transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          <Icon name="x" />
        </button>

        {/* `hire-hero-text` is the halo that keeps these words readable while
            confetti crosses them; the rise delays are the 80ms stagger. */}
        <div className="relative z-[1] grid gap-1.5 pr-8">
          <span className="anim-hire-rise hire-hero-text text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-success-text)]">
            {t('modal.eyebrow')}
          </span>
          <h2
            id={titleId}
            className="anim-hire-rise hire-hero-text text-[22px] font-extrabold leading-tight tracking-tight text-[var(--jale-ink)]"
            style={{ '--hire-rise-delay': '80ms' } as CSSProperties}
          >
            {headline}
          </h2>
          <span
            className="anim-hire-rise hire-hero-text text-sm font-medium text-[var(--jale-ink)]"
            style={{ '--hire-rise-delay': '160ms' } as CSSProperties}
          >
            {/* BARE, with no "Puesto:" label: the headline above already
                says what happened, and this line is the employer's own words
                for the job -- a label in front of them adds nothing. */}
            {jobTitle}
          </span>
        </div>
      </div>

      <div className="grid gap-3.5">
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5">
          {/* The start date ALWAYS shows. "Nothing here" and "the employer has
              not set one" are different facts, and only one of them is true. */}
          <Fact label={t('modal.start_date')} muted={startDate === null}>
            {startDate ?? t('modal.start_date_tbc')}
          </Fact>
          {hire.location ? <Fact label={t('modal.location')}>{hire.location}</Fact> : null}
          {pay ? <Fact label={t('modal.pay')}>{pay}</Fact> : null}
          {hire.shift_schedule ? (
            <Fact label={t('modal.schedule')}>{hire.shift_schedule}</Fact>
          ) : null}
        </div>

        {/* Says what happens next AND what to do if it does not, because the
            most common failure of a hire is silence afterwards. */}
        <p className="text-[13px] text-[var(--jale-ink)]">{t('modal.body')}</p>

        {/* Eight characters, not the whole uuid: enough for a worker to quote
            it over WhatsApp, short enough to read aloud. */}
        <p className="text-xs tabular-nums text-[var(--jale-ink-2)]">
          {t('modal.reference', { ref: `app-${applicationId.slice(0, 8)}` })}
        </p>
      </div>
    </Modal>
  );
}
