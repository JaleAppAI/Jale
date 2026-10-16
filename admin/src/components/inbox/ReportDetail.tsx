import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { LocalTime } from '@/components/LocalTime';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { canReport, type ReportStatus } from '@/lib/report-policy';
import {
  requestOutcome,
  requestStatusText,
  type ProblemReportDetail,
  type ReportContextView,
  type ReportErrorView,
  type ReportRequestView,
  type RequestOutcome,
} from '@/lib/server/admin-reports';
import type { AdminRole } from '@/lib/types';
import { ReportActionsPanel, ReportNoteForm, ReportStatusControl, RevealContactForm, ViewScreenshotButton } from './ReportActions';
import { BACK_LINK, CODE, MUTED, PAGE_TITLE, PANEL_TITLE } from './styles';

const STATUS_TONES: Record<ReportStatus, BadgeTone> = { new: 'info', looking: 'warning', fixed: 'success', wont_fix: 'neutral' };
// Status 0 means no response was observed. It is not a server failure, so it gets the neutral tone.
const OUTCOME_TONES: Record<RequestOutcome, BadgeTone> = { ok: 'success', client_error: 'warning', server_error: 'danger', no_response: 'neutral', unknown: 'neutral' };
const OUTCOME_WORDS: Record<RequestOutcome, string> = { ok: 'OK', client_error: 'Refused', server_error: 'Server error', no_response: 'No response', unknown: 'Status unknown' };
const ERROR_KIND_LABELS: Record<NonNullable<ReportErrorView['kind']>, string> = { error: 'Script error', rejection: 'Unhandled rejection', api: 'Request error' };
const CAPTURE_LABELS: Record<NonNullable<ReportContextView['capture']>['outcome'], string> = {
  ok: 'Captured', timeout: 'Timed out', failed: 'Failed', removed: 'Removed by the reporter', attached: 'A photo was attached instead', none: 'Not taken',
};
const LOCALE_LABELS = { es: 'Spanish', en: 'English' } as const;
const WORDS = 'whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-[var(--jale-ink)] [overflow-wrap:anywhere]';

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function requestStatusLabel(request: ReportRequestView): string {
  const outcome = requestOutcome(request.status);
  return outcome === 'no_response' || outcome === 'unknown'
    ? OUTCOME_WORDS[outcome]
    : `${requestStatusText(request.status)} · ${OUTCOME_WORDS[outcome]}`;
}

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <DashboardPanel as="div" className="flex flex-col gap-3 p-5">
        <h2 className={PANEL_TITLE} id={id}>{title}</h2>
        {children}
      </DashboardPanel>
    </section>
  );
}

function RequestRow({ request }: { request: ReportRequestView }) {
  const outcome = requestOutcome(request.status);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <code className={CODE}><span className="font-bold">{request.method ?? '?'}</span> {request.pattern ?? 'unknown path'}</code>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--jale-ink-2)]">
          <Badge tone={OUTCOME_TONES[outcome]}>{requestStatusLabel(request)}</Badge>
          {request.ms !== null ? <span>{formatDuration(request.ms)}</span> : null}
          {request.requestId ? <span>Request id <code className={CODE} translate="no">{request.requestId}</code></span> : null}
        </span>
      </div>
      {request.requestId ? <CopyButton accessibleLabel={`Copy request id ${request.requestId}`} label="Copy id" value={request.requestId} /> : null}
    </li>
  );
}

function deviceText(context: ReportContextView): string {
  return [context.device.kind, context.device.browser, context.device.os].filter(Boolean).join(' · ');
}

function ScreenAndDevice({ context, includeTechnical }: { context: ReportContextView; includeTechnical: boolean }) {
  const { screen, screens, app, device, capture } = context;
  const items: KVItem[] = [
    ...(screen.refs.length > 0 ? [{ label: 'References', value: <span className="flex flex-col items-end gap-1">{screen.refs.map((ref) => <span key={ref.name}>{ref.name} <code className={CODE} translate="no">{ref.id}</code></span>)}</span> }] : []),
    ...(screens.length > 0 ? [{ label: 'Recent screens', value: <span className="flex flex-col items-end gap-1">{screens.map((pattern, index) => <code className={CODE} key={`${index}-${pattern}`}>{pattern}</code>)}</span> }] : []),
    { label: 'Build', value: <code className={CODE} translate="no">{app.build ?? 'Not recorded'}</code> },
    ...(app.locale ? [{ label: 'App language', value: LOCALE_LABELS[app.locale] }] : []),
    ...(device.viewport ? [{ label: 'Viewport', value: <span className="tabular-nums">{device.viewport[0]} × {device.viewport[1]}</span> }] : []),
    ...(device.online === null ? [] : [{ label: 'Connection', value: device.online ? 'Online' : 'Offline' }]),
    ...(device.tz ? [{ label: 'Time zone', value: device.tz }] : []),
    ...(device.localTime ? [{ label: 'Their local time', value: device.localTime }] : []),
    ...(capture ? [{ label: 'Screen capture', value: `${CAPTURE_LABELS[capture.outcome]}${capture.ms === null ? '' : ` · ${formatDuration(capture.ms)}`}` }] : []),
  ];
  return (
    <Panel id="report-screen-heading" title="Screen and device">
      {includeTechnical ? null : <p className={MUTED}>The reporter turned off technical details: only the screen, the build and the language were sent.</p>}
      <KVList items={items} />
    </Panel>
  );
}

function RequestsCard({ requests }: { requests: ReportRequestView[] }) {
  return (
    <Panel id="report-requests-heading" title="Recent requests">
      {requests.length === 0 ? <p className={MUTED}>No requests were recorded.</p> : (
        <ul className="divide-y divide-[var(--jale-divider)]">
          {requests.map((request, index) => <RequestRow key={`${index}-${request.requestId ?? ''}`} request={request} />)}
        </ul>
      )}
    </Panel>
  );
}

function ErrorsCard({ errors }: { errors: ReportErrorView[] }) {
  return (
    <Panel id="report-errors-heading" title="Errors in the app">
      {errors.length === 0 ? <p className={MUTED}>No errors were recorded.</p> : (
        <ul className="flex flex-col divide-y divide-[var(--jale-divider)]">
          {errors.map((error, index) => (
            <li className="flex flex-col gap-1.5 py-3" key={`${index}-${error.at ?? ''}`}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--jale-ink-2)]">
                <Badge tone="neutral">{ERROR_KIND_LABELS[error.kind ?? 'error']}</Badge>
                {error.at ? <LocalTime iso={error.at} /> : null}
              </span>
              <span className={WORDS}>{error.message || 'No message'}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ContactSummary({ report }: { report: ProblemReportDetail }) {
  if (report.contentErased) {
    return <p className={MUTED}>Erased with the report&apos;s personal content.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {report.contactKind === 'none' ? (
        <p className={MUTED}>{report.verified ? 'No contact is on the account.' : 'The reporter left no contact.'}</p>
      ) : (
        <>
          <Badge tone={report.contactKind === 'account' ? 'success' : 'warning'}>
            {report.contactKind === 'account' ? 'Verified account' : 'Given by the reporter, not verified'}
          </Badge>
          <strong className="font-mono text-sm text-[var(--jale-ink)] [overflow-wrap:anywhere]" translate="no">{report.contactMasked ?? 'Masked'}</strong>
        </>
      )}
      {report.accountUserId ? <span className={MUTED}>Account <code className={CODE} translate="no">{report.accountUserId}</code></span> : null}
      {report.verified && !report.accountExists ? <span className={MUTED}>The sign-in had no account yet when the report was sent.</span> : null}
    </div>
  );
}

/** One problem report (K2.5: loader, policy and route unchanged). Every view of it is recorded by the loader. */
export function ReportDetail({ report, role, summary, nowIso }: { report: ProblemReportDetail; role: AdminRole; summary: string; nowIso: string }) {
  const details: KVItem[] = [
    { label: 'From', value: report.roleLabel },
    { label: 'Area', value: report.categoryLabel },
    { label: 'Page', value: report.context?.screen.pattern ? <code className={CODE}>{report.context.screen.pattern}</code> : 'Not recorded' },
    { label: 'Device', value: (report.context && deviceText(report.context)) || 'Not recorded' },
  ];
  return (
    <ReportActionsPanel>
      <div className="mx-auto flex w-full max-w-[74rem] flex-col gap-5">
        <header className="flex flex-col gap-2">
          <Link className={BACK_LINK} href="/inbox?tab=reports" prefetch={false}><span aria-hidden="true">←</span> Inbox</Link>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={STATUS_TONES[report.status]}>{report.statusLabel}</Badge>
            <Badge tone={report.verified ? 'success' : 'warning'}>{report.verified ? 'Verified' : 'Unverified'}</Badge>
            {report.stopsWork ? <Badge tone="danger">Stops work</Badge> : null}
            {report.stopsWork === false ? <Badge tone="neutral">Does not stop work</Badge> : null}
            {report.contentErased ? <Badge tone="neutral">Erased</Badge> : null}
          </div>
          <h1 className={PAGE_TITLE}><span translate="no">{report.numberLabel}</span> · {report.categoryLabel}</h1>
          <p className={MUTED}>
            Problem report from the web app · {report.roleLabel} · received <LocalTime format="relative" iso={report.createdAt} nowIso={nowIso} />
            {report.locale ? ` · ${LOCALE_LABELS[report.locale]}` : ''}
          </p>
          <p className={MUTED}>Every view of this report is recorded. Screenshot links last five minutes.</p>
        </header>

        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-4">
            <Panel id="report-words-heading" title="What they wrote">
              {report.contentErased ? (
                <p className={MUTED}>
                  This report&apos;s personal content was erased after 12 months: the words, the contact, the details
                  and the note. The number, category, role, status and dates remain.
                </p>
              ) : report.description === null ? (
                <p className={MUTED}>No words were sent.</p>
              ) : (
                <div className={WORDS}>{report.description}</div>
              )}
              {!report.hasImage ? (
                <p className={MUTED}>No screenshot was sent.</p>
              ) : !report.imageAvailable ? (
                <p className={MUTED}>The screenshot has expired. Screenshots are kept for 90 days.</p>
              ) : canReport(role, 'view_screenshot') ? (
                <ViewScreenshotButton reportId={report.id} />
              ) : (
                <p className={MUTED}>Screenshots open for team members who may change reports.</p>
              )}
            </Panel>

            <Panel id="report-status-heading" title="Status">
              {canReport(role, 'set_status') ? (
                <ReportStatusControl reportId={report.id} status={report.status} />
              ) : (
                <div><Badge tone={STATUS_TONES[report.status]}>{report.statusLabel}</Badge></div>
              )}
              {report.statusChangedAt ? (
                <p className={MUTED}>Changed <LocalTime format="relative" iso={report.statusChangedAt} nowIso={nowIso} /></p>
              ) : null}
              {report.contentErased ? (
                <p className={MUTED}>Erased with the report&apos;s personal content.</p>
              ) : canReport(role, 'set_note') ? (
                <ReportNoteForm note={report.internalNote} reportId={report.id} />
              ) : report.internalNote ? (
                <div className={WORDS}>{report.internalNote}</div>
              ) : (
                <p className={MUTED}>No note yet.</p>
              )}
            </Panel>

            {report.context ? (
              <>
                <ScreenAndDevice context={report.context} includeTechnical={report.includeTechnical} />
                <RequestsCard requests={report.context.requests} />
                <ErrorsCard errors={report.context.errors} />
              </>
            ) : report.contentErased ? null : (
              <DashboardPanel as="div" className="p-5"><p className={MUTED}>No technical details were sent with this report.</p></DashboardPanel>
            )}
          </div>

          <aside aria-label="Report details" className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
            <Panel id="report-details-heading" title="Details">
              <KVList items={details} />
              <h3 className={PANEL_TITLE}>Contact</h3>
              <ContactSummary report={report} />
              {canReport(role, 'reveal_contact') && report.contactKind !== 'none' ? <RevealContactForm reportId={report.id} /> : null}
            </Panel>
            <Panel id="report-summary-heading" title="Summary">
              <div><CopyButton label="Copy summary" value={summary} /></div>
              <details className="text-sm">
                <summary className="cursor-pointer font-semibold text-[var(--jale-ink)]">Show the summary</summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-input)] bg-[var(--jale-paper)] p-3 font-mono text-xs [overflow-wrap:anywhere]">{summary}</pre>
              </details>
              <p className={MUTED}>The summary has no personal details: no words, contact or note.</p>
            </Panel>
            <Panel id="report-history-heading" title="History">
              <ol className="flex flex-col gap-2.5 text-sm">
                <li><strong>Report received</strong><span className="block text-xs text-[var(--jale-ink-2)]"><LocalTime format="relative" iso={report.createdAt} nowIso={nowIso} /></span></li>
                {report.statusChangedAt ? (
                  <li><strong>Status set to {report.statusLabel}</strong><span className="block text-xs text-[var(--jale-ink-2)]"><LocalTime format="relative" iso={report.statusChangedAt} nowIso={nowIso} /></span></li>
                ) : null}
                {report.updatedAt !== report.createdAt ? (
                  <li><strong>Last updated</strong><span className="block text-xs text-[var(--jale-ink-2)]"><LocalTime format="relative" iso={report.updatedAt} nowIso={nowIso} /></span></li>
                ) : null}
              </ol>
            </Panel>
          </aside>
        </div>
      </div>
    </ReportActionsPanel>
  );
}
