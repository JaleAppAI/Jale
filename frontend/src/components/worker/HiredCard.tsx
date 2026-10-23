'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Textarea } from '@/components/ui/textarea';
import { accountKeyFromIdToken } from '@/lib/account-key';
import { ApiError } from '@/lib/api/errors';
import {
  remindEmployer,
  sendApplicationMessage,
  type ApplicationHire,
  type ApplicationRequirementsState,
} from '@/lib/api/worker';
import { formatStartDateWeekday, formatTimeOfDay } from '@/lib/date';
import {
  REMIND_COOLDOWN_MS,
  WORKER_MESSAGE_MAX,
  checkWorkerMessage,
  hasHireDetails,
  readRemindedAt,
  remindBlockFrom,
  telHref,
  wholeHours,
  wholeMinutes,
  writeRemindedAt,
  type RemindBlock,
} from '@/lib/hire-details';

type SentMessage = { id: string; body: string; sentAt: string };

/** The last 20 messages the worker sent from the web, as the state document carries them. */
export type PersistedSentMessages = ApplicationRequirementsState['sent_messages'];

/**
 * The hired worker's card on `/worker/applications/[id]` (F19, contract K4).
 *
 * A hire used to end in "the employer will send more details; if nothing
 * arrives, reach out to them" -- with no way to reach out and nowhere for the
 * details to arrive. Now the employer's start details show here when they
 * exist; while they do not, the worker can ask Jale to remind the employer;
 * and either way the worker can write to the employer, who reads it in their
 * Jale inbox and answers on WhatsApp.
 */
export function HiredCard({
  applicationId,
  jobTitle,
  companyName,
  hire,
  sentMessages,
}: {
  applicationId: string;
  jobTitle: string | null;
  /** Already through `realCompanyName`: null for the "Empleador" placeholder. */
  companyName: string | null;
  hire: ApplicationHire;
  /** Persisted history, oldest first (K4.3); this visit's sends follow it. */
  sentMessages: PersistedSentMessages;
}) {
  const t = useTranslations('worker_application_details.hired_card');
  const tPage = useTranslations('worker_application_details');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const account = accountKeyFromIdToken(idToken);
  const returnUrl = `/worker/applications/${applicationId}`;

  const messageId = useId();
  const hintId = useId();
  const counterId = useId();
  const remindReasonId = useId();

  const details = hasHireDetails(hire.details) ? hire.details : null;
  const startDate = formatStartDateWeekday(details?.start_date ?? hire.start_date, locale);
  const phoneHref = telHref(details?.contact_phone);

  // Seeded from the later of the server's last reminder (any device) and this
  // device's marker. Safe in the initializer: the card only renders inside the
  // page's client-only `ready` branch.
  const [remindBlock, setRemindBlock] = useState<RemindBlock | null>(() => {
    const server = hire.employer_reminded_at ? Date.parse(hire.employer_reminded_at) : Number.NaN;
    const local = readRemindedAt(applicationId, account);
    const latest = Math.max(Number.isFinite(server) ? server : 0, local ?? 0);
    return remindBlockFrom(latest > 0 ? latest : null, Date.now());
  });
  const [reminding, setReminding] = useState(false);
  const [remindError, setRemindError] = useState<string | null>(null);
  const remindingRef = useRef(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const sendingRef = useRef(false);

  // Persisted history first, then this visit's sends; an id seen twice shows once.
  const history = useMemo<SentMessage[]>(() => {
    const seen = new Set<string>();
    const rows: SentMessage[] = [];
    const add = (entry: SentMessage) => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      rows.push(entry);
    };
    for (const m of sentMessages) add({ id: m.message_id, body: m.body, sentAt: m.sent_at });
    for (const m of sent) add(m);
    return rows;
  }, [sentMessages, sent]);

  /** The legal wall is a redirect, not a message. True when it took over. */
  function routedToLegalWall(err: unknown): boolean {
    try {
      handleLegalWall(err, returnUrl);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRemind() {
    // A ref, not the state: two clicks in one frame both read `reminding === false`.
    if (!idToken || remindingRef.current || remindBlock) return;
    remindingRef.current = true;
    setReminding(true);
    setRemindError(null);
    try {
      await remindEmployer(idToken, applicationId);
      writeRemindedAt(applicationId, account, Date.now());
      setRemindBlock({ reason: 'sent', hours: wholeHours(REMIND_COOLDOWN_MS) });
    } catch (err) {
      if (routedToLegalWall(err)) return;
      if (err instanceof ApiError && err.code === 'rate_limited') {
        const seconds = err.payload.retry_after_seconds;
        setRemindBlock({
          reason: 'recent',
          hours: wholeHours(typeof seconds === 'number' ? seconds * 1000 : REMIND_COOLDOWN_MS),
        });
      } else {
        setRemindError(errorMessage(err));
      }
    } finally {
      remindingRef.current = false;
      setReminding(false);
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!idToken || sendingRef.current) return;
    const check = checkWorkerMessage(draft);
    if (!check.ok) {
      setMessageError(t(check.reason === 'empty' ? 'message_empty' : 'message_too_long'));
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setMessageError(null);
    try {
      const result = await sendApplicationMessage(idToken, applicationId, { body: check.body });
      setSent((prev) => [...prev, { id: result.message_id, body: check.body, sentAt: result.sent_at }]);
      setDraft('');
    } catch (err) {
      if (routedToLegalWall(err)) return;
      if (err instanceof ApiError && err.code === 'rate_limited') {
        setMessageError(t('message_rate_limited', { minutes: wholeMinutes(err.payload.retry_after_seconds ?? 3600) }));
      } else if (err instanceof ApiError && err.code === 'not_hired') {
        setMessageError(t('not_hired'));
      } else if (err instanceof ApiError && err.code === 'invalid_message') {
        setMessageError(t('message_invalid'));
      } else {
        setMessageError(errorMessage(err));
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <DashboardPanel>
      <div className="space-y-5 p-5 md:p-6">
        <Link
          href="/worker/applications"
          className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {tPage('back')}
        </Link>

        <div className="grid gap-2">
          <InlineFeedback tone="success">{tPage('terminal.hired')}</InlineFeedback>
          {jobTitle ? (
            <p className="text-sm font-semibold text-[var(--jale-ink)] [overflow-wrap:anywhere]">{jobTitle}</p>
          ) : null}
          <p className="text-sm text-[var(--jale-ink-2)]">
            {details
              ? (companyName ? t('details_intro', { company: companyName }) : t('details_intro_no_company'))
              : (companyName ? tPage('terminal.hired_body', { company: companyName }) : tPage('terminal.hired_body_no_company'))}
          </p>
        </div>

        {details ? (
          <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <Fact label={t('start_date')}>{startDate ?? t('start_date_tbc')}</Fact>
            {details.report_location ? <Fact label={t('report_location')}>{details.report_location}</Fact> : null}
            {details.contact_name || details.contact_phone ? (
              <Fact label={t('contact')}>
                {details.contact_name ? <span className="block">{details.contact_name}</span> : null}
                {details.contact_phone ? (
                  phoneHref ? (
                    <a
                      href={phoneHref}
                      className="inline-flex min-h-11 items-center font-semibold text-[var(--jale-blue-500)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                      {details.contact_phone}
                    </a>
                  ) : (
                    <span className="block">{details.contact_phone}</span>
                  )
                ) : null}
              </Fact>
            ) : null}
            {details.notes ? (
              <Fact label={t('notes')} className="sm:col-span-2">
                <span className="whitespace-pre-line">{details.notes}</span>
              </Fact>
            ) : null}
          </dl>
        ) : (
          <div className="grid gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleRemind()}
              loading={reminding}
              loadingLabel={tCommon('loading')}
              disabled={remindBlock !== null}
              aria-describedby={remindBlock ? remindReasonId : undefined}
              className="w-full sm:w-auto sm:justify-self-start"
            >
              {t('remind')}
            </Button>
            {remindBlock ? (
              <p id={remindReasonId} role="status" className="text-xs text-[var(--jale-ink-2)]">
                {remindBlock.reason === 'sent' ? t('remind_sent') : t('remind_recent')}{' '}
                {t('remind_wait', { hours: remindBlock.hours })}
              </p>
            ) : null}
            {remindError ? (
              <p role="alert" className="text-xs font-medium text-[var(--jale-danger-text)]">{remindError}</p>
            ) : null}
          </div>
        )}

        <form onSubmit={(event) => void handleSend(event)} noValidate className="grid gap-2 border-t border-[var(--jale-divider)] pt-5">
          {/* Where the answer arrives, said BEFORE the box as its own note, so
              a worker learns the reply comes on WhatsApp before typing rather
              than while waiting on this page. Still the box's description. */}
          <p className="mb-1 flex items-start gap-2 rounded-[var(--radius-input)] bg-[var(--jale-blue-50)] px-3 py-2.5 text-xs leading-relaxed text-[var(--jale-blue-700)]">
            <span className="mt-px flex-none"><Icon name="message" /></span>
            <span id={hintId}>{t('message_hint')}</span>
          </p>
          <label htmlFor={messageId} className="text-sm font-bold text-[var(--jale-ink)]">{t('message_label')}</label>
          <Textarea
            id={messageId}
            name="message"
            rows={4}
            maxLength={WORKER_MESSAGE_MAX}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (messageError) setMessageError(null);
            }}
            placeholder={t('message_placeholder')}
            autoComplete="off"
            aria-describedby={`${hintId} ${counterId}`}
            aria-invalid={messageError ? true : undefined}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id={counterId} className="text-xs tabular-nums text-[var(--jale-ink-2)]">
              {t('message_count', { count: draft.length, max: WORKER_MESSAGE_MAX })}
            </span>
            <Button type="submit" loading={sending} loadingLabel={tCommon('loading')}>
              {t('message_send')}
            </Button>
          </div>
          {messageError ? (
            <p role="alert" className="text-xs font-medium text-[var(--jale-danger-text)]">{messageError}</p>
          ) : null}
          <ul aria-live="polite" className="grid gap-2">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-[var(--radius-input)] bg-[var(--jale-paper-2)] px-3 py-2 text-sm">
                <span className="block text-xs font-semibold text-[var(--jale-success-text)]">
                  {t('message_sent_at', { time: formatTimeOfDay(entry.sentAt, locale) ?? '' })}
                </span>
                <span className="block whitespace-pre-line text-[var(--jale-ink)] [overflow-wrap:anywhere]">{entry.body}</span>
              </li>
            ))}
          </ul>
        </form>
      </div>
    </DashboardPanel>
  );
}

/** One labelled fact, as a `dt`/`dd` pair inside the card's `dl`. */
function Fact({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`grid min-w-0 gap-0.5 ${className}`}>
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</dt>
      <dd className="text-sm font-semibold text-[var(--jale-ink)] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
