import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/CopyButton';
import {
  ReportActionsPanel,
  ReportNoteForm,
  ReportStatusControl,
  RevealContactForm,
  ViewScreenshotButton,
} from '@/components/ReportActionsPanel';
import { canReport, type ReportStatus } from '@/lib/report-policy';
import {
  buildReportSummary,
  formatRelativeTime,
  formatUtcTime,
  getProblemReport,
  reportSummaryInput,
  requestOutcome,
  requestStatusText,
  type ProblemReportDetail,
  type ReportContextView,
  type ReportErrorView,
  type ReportRequestView,
  type RequestOutcome,
} from '@/lib/server/admin-reports';
import { requireAdminSession } from '@/lib/server/session';

// Existing badge and pill colours from globals.css.
const STATUS_BADGES: Record<ReportStatus, string> = {
  new: 'open',
  looking: 'verification',
  fixed: 'resolved',
  wont_fix: 'dismissed',
};

// Status 0 means no response was observed. It is not a server failure, so it
// gets the neutral treatment.
const OUTCOME_PILLS: Record<RequestOutcome, string> = {
  ok: 'pill success',
  client_error: 'pill warning',
  server_error: 'pill danger',
  no_response: 'pill',
  unknown: 'pill',
};

const OUTCOME_WORDS: Record<RequestOutcome, string> = {
  ok: 'OK',
  client_error: 'Refused',
  server_error: 'Server error',
  no_response: 'No response',
  unknown: 'Status unknown',
};

const ERROR_KIND_LABELS: Record<NonNullable<ReportErrorView['kind']>, string> = {
  error: 'Script error',
  rejection: 'Unhandled rejection',
  api: 'Request error',
};

const CAPTURE_LABELS: Record<NonNullable<ReportContextView['capture']>['outcome'], string> = {
  ok: 'Captured',
  timeout: 'Timed out',
  failed: 'Failed',
  removed: 'Removed by the reporter',
  attached: 'A photo was attached instead',
  none: 'Not taken',
};

const LOCALE_LABELS = { es: 'Spanish', en: 'English' } as const;

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function requestStatusLabel(request: ReportRequestView): string {
  const outcome = requestOutcome(request.status);
  return outcome === 'no_response' || outcome === 'unknown'
    ? OUTCOME_WORDS[outcome]
    : `${requestStatusText(request.status)} · ${OUTCOME_WORDS[outcome]}`;
}

function RequestRow({ request }: { request: ReportRequestView }) {
  const outcome = requestOutcome(request.status);
  return (
    <li className="report-request">
      <div className="stack">
        <code className="report-code">
          <span className="report-method">{request.method ?? '?'}</span> {request.pattern ?? 'unknown path'}
        </code>
        <span className="meta">
          <span className={OUTCOME_PILLS[outcome]}>{requestStatusLabel(request)}</span>
          {request.ms !== null ? <span>{formatDuration(request.ms)}</span> : null}
          {request.requestId ? (
            <span>Request id <code className="report-code" translate="no">{request.requestId}</code></span>
          ) : null}
        </span>
      </div>
      {request.requestId ? (
        <CopyButton accessibleLabel={`Copy request id ${request.requestId}`} label="Copy id" value={request.requestId} />
      ) : null}
    </li>
  );
}

function ScreenAndDevice({ context, includeTechnical }: { context: ReportContextView; includeTechnical: boolean }) {
  const { screen, screens, app, device, capture } = context;
  const deviceText = [device.kind, device.browser, device.os].filter(Boolean).join(' · ');
  return (
    <article aria-labelledby="report-screen-heading" className="card stack-gap">
      <h2 id="report-screen-heading">Screen and device</h2>
      {includeTechnical ? null : (
        <p className="muted">The reporter turned off technical details: only the screen, the build and the language were sent.</p>
      )}
      <dl className="report-facts">
        <div>
          <dt>Screen</dt>
          <dd><code className="report-code">{screen.pattern ?? 'Not recorded'}</code></dd>
        </div>
        {screen.refs.length > 0 ? (
          <div>
            <dt>References</dt>
            <dd className="stack">
              {screen.refs.map((ref) => (
                <span key={ref.name}>{ref.name} <code className="report-code" translate="no">{ref.id}</code></span>
              ))}
            </dd>
          </div>
        ) : null}
        {screens.length > 0 ? (
          <div>
            <dt>Recent screens</dt>
            <dd className="stack">
              {screens.map((pattern, index) => (
                <code className="report-code" key={`${index}-${pattern}`}>{pattern}</code>
              ))}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Build</dt>
          <dd><code className="report-code" translate="no">{app.build ?? 'Not recorded'}</code></dd>
        </div>
        {app.locale ? (
          <div>
            <dt>App language</dt>
            <dd>{LOCALE_LABELS[app.locale]}</dd>
          </div>
        ) : null}
        {deviceText ? (
          <div>
            <dt>Device</dt>
            <dd>{deviceText}</dd>
          </div>
        ) : null}
        {device.viewport ? (
          <div>
            <dt>Viewport</dt>
            <dd className="report-number">{device.viewport[0]} × {device.viewport[1]}</dd>
          </div>
        ) : null}
        {device.online === null ? null : (
          <div>
            <dt>Connection</dt>
            <dd>{device.online ? 'Online' : 'Offline'}</dd>
          </div>
        )}
        {device.tz ? (
          <div>
            <dt>Time zone</dt>
            <dd>{device.tz}</dd>
          </div>
        ) : null}
        {device.localTime ? (
          <div>
            <dt>Their local time</dt>
            <dd>{device.localTime}</dd>
          </div>
        ) : null}
        {capture ? (
          <div>
            <dt>Screen capture</dt>
            <dd>{CAPTURE_LABELS[capture.outcome]}{capture.ms === null ? '' : ` · ${formatDuration(capture.ms)}`}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

function RequestsCard({ requests }: { requests: ReportRequestView[] }) {
  return (
    <article aria-labelledby="report-requests-heading" className="card stack-gap">
      <h2 id="report-requests-heading">Recent requests</h2>
      {requests.length === 0 ? (
        <p className="muted">No requests were recorded.</p>
      ) : (
        <ul className="report-requests" role="list">
          {requests.map((request, index) => (
            <RequestRow key={`${index}-${request.requestId ?? ''}`} request={request} />
          ))}
        </ul>
      )}
    </article>
  );
}

function ErrorsCard({ errors }: { errors: ReportErrorView[] }) {
  return (
    <article aria-labelledby="report-errors-heading" className="card stack-gap">
      <h2 id="report-errors-heading">Errors in the app</h2>
      {errors.length === 0 ? (
        <p className="muted">No errors were recorded.</p>
      ) : (
        <ul className="report-errors" role="list">
          {errors.map((error, index) => (
            <li className="report-error" key={`${index}-${error.at ?? ''}`}>
              <span className="meta">
                <span className="pill">{ERROR_KIND_LABELS[error.kind ?? 'error']}</span>
                {error.at ? <time dateTime={error.at}>{formatUtcTime(error.at)}</time> : null}
              </span>
              <span className="report-words">{error.message || 'No message'}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ContactSummary({ report }: { report: ProblemReportDetail }) {
  if (report.contentErased) {
    return <p className="muted">Erased with the report&apos;s personal content.</p>;
  }
  return (
    <div className="stack">
      {report.contactKind === 'none' ? (
        <p className="muted">{report.verified ? 'No contact is on the account.' : 'The reporter left no contact.'}</p>
      ) : (
        <>
          <span className={report.contactKind === 'account' ? 'pill success' : 'pill warning'}>
            {report.contactKind === 'account' ? 'Verified account' : 'Given by the reporter, not verified'}
          </span>
          <strong className="revealed-value" translate="no">{report.contactMasked ?? 'Masked'}</strong>
        </>
      )}
      {report.accountUserId ? (
        <span className="muted">Account <code className="report-code" translate="no">{report.accountUserId}</code></span>
      ) : null}
      {report.verified && !report.accountExists ? (
        <span className="muted">The sign-in had no account yet when the report was sent.</span>
      ) : null}
    </div>
  );
}

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  const { id } = await params;
  const report = await getProblemReport(session, id);

  if (!report) {
    notFound();
  }

  const role = session.role;
  const summary = buildReportSummary(reportSummaryInput(report));
  const now = Date.now();

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className={`badge ${STATUS_BADGES[report.status]}`}>{report.statusLabel}</span>
          <span className={report.verified ? 'pill success' : 'pill warning'}>{report.verified ? 'Verified' : 'Unverified'}</span>
          {report.stopsWork ? <span className="pill danger">Stops work</span> : null}
          {report.stopsWork === false ? <span className="pill">Does not stop work</span> : null}
          {report.contentErased ? <span className="pill">Erased</span> : null}
        </div>
        <h1>{report.numberLabel} · {report.categoryLabel}</h1>
        <p className="muted">
          {report.roleLabel} · received{' '}
          <time dateTime={report.createdAt} title={formatUtcTime(report.createdAt)}>{formatRelativeTime(report.createdAt, now)}</time>
          {report.locale ? ` · ${LOCALE_LABELS[report.locale]}` : ''}
        </p>
        <p className="muted">Every view of this report is recorded. Screenshot links last five minutes.</p>
      </section>

      <section className="grid two">
        <div className="stack-gap">
          <article aria-labelledby="report-words-heading" className="card stack-gap">
            <h2 id="report-words-heading">What happened</h2>
            {report.contentErased ? (
              <p className="muted">
                This report&apos;s personal content was erased after 12 months: the words, the contact, the details
                and the note. The number, category, role, status and dates remain.
              </p>
            ) : report.description === null ? (
              <p className="muted">No words were sent.</p>
            ) : (
              <div className="report-words">{report.description}</div>
            )}
          </article>

          {report.context ? (
            <>
              <ScreenAndDevice context={report.context} includeTechnical={report.includeTechnical} />
              <RequestsCard requests={report.context.requests} />
              <ErrorsCard errors={report.context.errors} />
            </>
          ) : report.contentErased ? null : (
            <article className="card">
              <p className="muted">No technical details were sent with this report.</p>
            </article>
          )}
        </div>

        <aside aria-label="Report actions" className="stack-gap">
          <ReportActionsPanel>
            <article aria-labelledby="report-status-heading" className="card stack-gap">
              <h2 id="report-status-heading">Status</h2>
              {canReport(role, 'set_status') ? (
                <ReportStatusControl reportId={report.id} status={report.status} />
              ) : (
                <span className={`badge ${STATUS_BADGES[report.status]}`}>{report.statusLabel}</span>
              )}
              {report.statusChangedAt ? (
                <p className="muted">
                  Changed <time dateTime={report.statusChangedAt} title={formatUtcTime(report.statusChangedAt)}>{formatRelativeTime(report.statusChangedAt, now)}</time>
                </p>
              ) : null}
            </article>

            <article aria-labelledby="report-contact-heading" className="card stack-gap">
              <h2 id="report-contact-heading">Reporter</h2>
              <ContactSummary report={report} />
              {canReport(role, 'reveal_contact') && report.contactKind !== 'none' ? (
                <RevealContactForm reportId={report.id} />
              ) : null}
            </article>

            <article aria-labelledby="report-tools-heading" className="card stack-gap">
              <h2 id="report-tools-heading">Screenshot and summary</h2>
              {!report.hasImage ? (
                <p className="muted">No screenshot was sent.</p>
              ) : !report.imageAvailable ? (
                <p className="muted">The screenshot has expired. Screenshots are kept for 90 days.</p>
              ) : canReport(role, 'view_screenshot') ? (
                <ViewScreenshotButton reportId={report.id} />
              ) : (
                <p className="muted">Screenshots open for team members who may change reports.</p>
              )}
              <div className="stack">
                <CopyButton label="Copy summary" value={summary} />
                <details className="report-summary">
                  <summary>Show the summary</summary>
                  <pre className="report-summary-text">{summary}</pre>
                </details>
                <p className="muted">The summary has no personal details: no words, contact or note.</p>
              </div>
            </article>

            <article aria-labelledby="report-note-heading" className="card stack-gap">
              <h2 id="report-note-heading">Internal note</h2>
              {report.contentErased ? (
                <p className="muted">Erased with the report&apos;s personal content.</p>
              ) : canReport(role, 'set_note') ? (
                <ReportNoteForm note={report.internalNote} reportId={report.id} />
              ) : report.internalNote ? (
                <div className="report-words">{report.internalNote}</div>
              ) : (
                <p className="muted">No note yet.</p>
              )}
            </article>
          </ReportActionsPanel>

          <Link className="button secondary" href="/reports" prefetch={false}>Back to reports</Link>
        </aside>
      </section>
    </main>
  );
}
