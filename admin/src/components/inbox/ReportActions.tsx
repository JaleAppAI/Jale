'use client';

import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { adminFetchJson } from '@/lib/admin-fetch';
import {
  REPORT_NOTE_MAX_LENGTH,
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  REVEAL_REASON_MAX_LENGTH,
  REVEAL_REASON_MIN_LENGTH,
  SIGNED_OUT_DAILY_CAP_MAX,
  type ReportActionId,
  type ReportStatus,
} from '@/lib/report-policy';
import { DANGER_TEXT, LABEL, MUTED, TEXT_LINK } from './styles';

// The Reports action controls. <ReportActionsPanel> owns the request state;
// the controls inside it are explicit pieces the server page composes from
// the policy, so a role that may not act never receives a control.
//
// A revealed contact and a screenshot link live in component state only:
// never stored, never logged, and gone when the admin leaves the page.

type RevealedContact = { kind: 'account' | 'typed'; contact: string };

type ReportActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  revealed?: RevealedContact;
  url?: string;
  expiresAt?: string;
};

type Feedback = { actionId: ReportActionId; tone: 'ok' | 'error'; message: string };

type ReportActionsContextValue = {
  state: { pendingActionId: ReportActionId | undefined; feedback: Feedback | undefined };
  actions: { run: (actionId: ReportActionId, payload: Record<string, unknown>) => Promise<ReportActionResult | undefined> };
};

const ReportActionsContext = createContext<ReportActionsContextValue | null>(null);

function useReportActions(): ReportActionsContextValue {
  const context = use(ReportActionsContext);
  if (!context) {
    throw new Error('Report action controls must be placed inside <ReportActionsPanel>.');
  }
  return context;
}

// The actions after which the page re-reads the report.
const REFRESHING_ACTIONS: ReadonlySet<ReportActionId> = new Set(['set_status', 'set_note', 'update_settings']);
const FAILED_MESSAGE = 'The action could not be completed.';
const CONNECTION_MESSAGE = 'The action could not be completed. Check your connection and try again.';
const FIELD = 'flex flex-col gap-1.5';

async function postReportAction(actionId: ReportActionId, payload: Record<string, unknown>): Promise<ReportActionResult | 'redirecting'> {
  // A plain call from a client event handler, which keeps the per-action
  // pendingActionId. adminFetchJson adds the x-amz-content-sha256 payload hash
  // the signed admin origin requires and sends an expired session to sign-in.
  // Moving these panels to useActionState is follow-up F34.
  const outcome = await adminFetchJson<ReportActionResult>('/api/report-actions', {
    method: 'POST',
    body: { action: actionId, ...payload },
  });
  if (outcome.kind === 'redirecting') return 'redirecting';
  if (outcome.kind === 'network') return { ok: false, message: CONNECTION_MESSAGE };
  return outcome.data ?? { ok: false, message: FAILED_MESSAGE };
}

export function ReportActionsPanel({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pendingActionId, setPendingActionId] = useState<ReportActionId>();
  const [feedback, setFeedback] = useState<Feedback>();
  const inFlight = useRef(false);

  async function run(actionId: ReportActionId, payload: Record<string, unknown>): Promise<ReportActionResult | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPendingActionId(actionId);
    setFeedback(undefined);
    try {
      const result = await postReportAction(actionId, payload);
      if (result === 'redirecting') return undefined;
      if (!result.ok) {
        setFeedback({ actionId, tone: 'error', message: result.message ?? FAILED_MESSAGE });
        return result;
      }
      if (result.message) {
        setFeedback({ actionId, tone: 'ok', message: result.message });
      }
      if (REFRESHING_ACTIONS.has(actionId)) {
        router.refresh();
      }
      return result;
    } catch {
      setFeedback({ actionId, tone: 'error', message: CONNECTION_MESSAGE });
      return undefined;
    } finally {
      inFlight.current = false;
      setPendingActionId(undefined);
    }
  }

  return (
    <ReportActionsContext value={{ state: { pendingActionId, feedback }, actions: { run } }}>
      {children}
    </ReportActionsContext>
  );
}

function ActionFeedback({ actionId }: { actionId: ReportActionId }) {
  const { state: { feedback } } = useReportActions();
  if (!feedback || feedback.actionId !== actionId) {
    return null;
  }
  return feedback.tone === 'error'
    ? <p className={DANGER_TEXT} role="alert">{feedback.message}</p>
    : <p className={MUTED} role="status">{feedback.message}</p>;
}

export function ReportStatusControl({ reportId, status }: { reportId: string; status: ReportStatus }) {
  const { state: { pendingActionId }, actions: { run } } = useReportActions();
  const [requested, setRequested] = useState<ReportStatus>();
  const busy = pendingActionId !== undefined;

  async function choose(next: ReportStatus) {
    if (next === status || busy) return;
    setRequested(next);
    await run('set_status', { reportId, status: next });
    setRequested(undefined);
  }

  return (
    <div className="flex flex-col gap-2">
      <div aria-label="Report status" className="flex flex-wrap gap-2" role="group">
        {REPORT_STATUSES.map((value) => (
          <Button
            aria-busy={(pendingActionId === 'set_status' && requested === value) || undefined}
            aria-pressed={value === status}
            disabled={busy && value !== status}
            key={value}
            onClick={() => { void choose(value); }}
            size="sm"
            type="button"
            variant={value === status ? 'primary' : 'outline'}
          >
            {pendingActionId === 'set_status' && requested === value ? 'Saving…' : REPORT_STATUS_LABELS[value]}
          </Button>
        ))}
      </div>
      <ActionFeedback actionId="set_status" />
    </div>
  );
}

export function RevealContactForm({ reportId }: { reportId: string }) {
  const { state: { pendingActionId }, actions: { run } } = useReportActions();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<RevealedContact>();
  const fieldId = `reveal-reason-${reportId}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = String(new FormData(form).get('reason') ?? '').trim();
    const result = await run('reveal_contact', { reportId, reason });
    if (result?.ok && result.revealed) {
      setRevealed(result.revealed);
      form.reset();
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button disabled={pendingActionId !== undefined} onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
        Reveal contact (logged)
      </Button>
      {revealed ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper)] p-3" role="status">
          <Badge tone="danger">Contact revealed</Badge>
          <strong className="font-mono text-sm text-[var(--jale-ink)] [overflow-wrap:anywhere]" translate="no">{revealed.contact}</strong>
          <span className={MUTED}>
            {revealed.kind === 'account' ? 'Verified account' : 'Given by the reporter, not verified'}. This reveal
            is recorded. The contact is masked again when you leave this page.
          </span>
        </div>
      ) : null}
      <Modal onClose={() => setOpen(false)} open={open} size="sm" title="Reveal the contact">
        <form aria-busy={pendingActionId === 'reveal_contact' || undefined} className="flex flex-col gap-2" onSubmit={(event) => { void onSubmit(event); }}>
          <label className={LABEL} htmlFor={fieldId}>Reason for revealing the contact</label>
          <Textarea
            aria-describedby={`${fieldId}-hint`}
            autoComplete="off"
            id={fieldId}
            maxLength={REVEAL_REASON_MAX_LENGTH}
            minLength={REVEAL_REASON_MIN_LENGTH}
            name="reason"
            required
            rows={3}
          />
          <p className={MUTED} id={`${fieldId}-hint`}>
            At least {REVEAL_REASON_MIN_LENGTH} characters. The reason is recorded with your account, so do not include
            personal details in it.
          </p>
          <Button disabled={pendingActionId !== undefined} loading={pendingActionId === 'reveal_contact'} loadingLabel="Revealing…" type="submit" variant="error">
            Reveal contact
          </Button>
          <ActionFeedback actionId="reveal_contact" />
        </form>
      </Modal>
    </div>
  );
}

type ScreenshotLink = { url: string; expiresAt: string };

export function ViewScreenshotButton({ reportId }: { reportId: string }) {
  const { state: { pendingActionId }, actions: { run } } = useReportActions();
  const [link, setLink] = useState<ScreenshotLink>();

  // The link is dropped when it expires.
  useEffect(() => {
    if (!link) return undefined;
    const timer = window.setTimeout(() => setLink(undefined), Math.max(0, Date.parse(link.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [link]);

  async function open() {
    const result = await run('view_screenshot', { reportId });
    if (result?.ok && result.url && result.expiresAt) {
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setLink({ url: result.url, expiresAt: result.expiresAt });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        aria-busy={pendingActionId === 'view_screenshot' || undefined}
        disabled={pendingActionId !== undefined}
        onClick={() => { void open(); }}
        type="button"
        variant="outline"
      >
        {pendingActionId === 'view_screenshot' ? 'Opening…' : 'View screenshot (logged)'}
      </Button>
      <ActionFeedback actionId="view_screenshot" />
      {link ? (
        <p className={MUTED}>
          If no new tab opened,{' '}
          <a className={TEXT_LINK} href={link.url} rel="noopener noreferrer" target="_blank">open the screenshot</a>.
          The link stops working after 5 minutes.
        </p>
      ) : null}
    </div>
  );
}

export function ReportNoteForm({ reportId, note }: { reportId: string; note: string | null }) {
  const { state: { pendingActionId }, actions: { run } } = useReportActions();
  const fieldId = `report-note-${reportId}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('note') ?? '');
    await run('set_note', { reportId, note: value });
  }

  return (
    <form aria-busy={pendingActionId === 'set_note' || undefined} className="flex flex-col gap-2" onSubmit={(event) => { void onSubmit(event); }}>
      <label className={LABEL} htmlFor={fieldId}>Internal note (admins only)</label>
      <Textarea
        aria-describedby={`${fieldId}-hint`}
        autoComplete="off"
        defaultValue={note ?? ''}
        id={fieldId}
        maxLength={REPORT_NOTE_MAX_LENGTH}
        name="note"
        placeholder="What you found, what you changed"
        rows={4}
      />
      <p className={MUTED} id={`${fieldId}-hint`}>
        One note per report, replaced when you save. Leave it empty to clear it. The reporter never sees it.
      </p>
      <div>
        <Button disabled={pendingActionId !== undefined} loading={pendingActionId === 'set_note'} loadingLabel="Saving…" type="submit">
          Save note
        </Button>
      </div>
      <ActionFeedback actionId="set_note" />
    </form>
  );
}

export type ReportSettingsFormValues = {
  reportingEnabled: boolean;
  signedOutEnabled: boolean;
  screenshotsEnabled: boolean;
  teamEmailEnabled: boolean;
  signedOutDailyCap: number;
  teamRecipientDomain: string | null;
  adminBaseUrl: string | null;
};

type SwitchName = 'reportingEnabled' | 'signedOutEnabled' | 'screenshotsEnabled' | 'teamEmailEnabled';

const SWITCHES: { name: SwitchName; label: string; hint: string }[] = [
  { name: 'reportingEnabled', label: 'Problem reports', hint: 'The whole feature. Off hides every way to send a report.' },
  { name: 'signedOutEnabled', label: 'Signed-out reports', hint: 'Reports from people who are not signed in.' },
  { name: 'screenshotsEnabled', label: 'Screenshots', hint: 'Screen captures and attached photos.' },
  { name: 'teamEmailEnabled', label: 'Team email', hint: 'One email to the team mailbox for each new report.' },
];

export function ReportSettingsForm({ settings, defaultBaseUrl }: { settings: ReportSettingsFormValues; defaultBaseUrl: string }) {
  const { state: { pendingActionId }, actions: { run } } = useReportActions();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await run('update_settings', {
      settings: {
        reportingEnabled: data.get('reportingEnabled') === 'on',
        signedOutEnabled: data.get('signedOutEnabled') === 'on',
        screenshotsEnabled: data.get('screenshotsEnabled') === 'on',
        teamEmailEnabled: data.get('teamEmailEnabled') === 'on',
        signedOutDailyCap: Number(data.get('signedOutDailyCap')),
        teamRecipient: String(data.get('teamRecipient') ?? ''),
        adminBaseUrl: String(data.get('adminBaseUrl') ?? ''),
      },
    });
    if (result?.ok) {
      // Once saved, the page shows the mailbox by its domain only.
      const recipient = form.elements.namedItem('teamRecipient');
      if (recipient instanceof HTMLInputElement) recipient.value = '';
    }
  }

  return (
    <form aria-busy={pendingActionId === 'update_settings' || undefined} className="flex flex-col gap-5" onSubmit={(event) => { void onSubmit(event); }}>
      <fieldset className="flex flex-col gap-1">
        <legend className={`mb-1 ${LABEL}`}>Switches</legend>
        {SWITCHES.map(({ name, label, hint }) => (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5" key={name}>
            <input className="mt-1 size-4 accent-[var(--jale-blue-500)]" defaultChecked={settings[name]} name={name} type="checkbox" />
            <span className="flex flex-col">
              <strong className="text-sm text-[var(--jale-ink)]">{label}</strong>
              <span className={MUTED}>{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className={FIELD}>
        <label className={LABEL} htmlFor="settings-daily-cap">Signed-out reports per day</label>
        <Input
          aria-describedby="settings-daily-cap-hint"
          autoComplete="off"
          defaultValue={settings.signedOutDailyCap}
          id="settings-daily-cap"
          inputMode="numeric"
          max={SIGNED_OUT_DAILY_CAP_MAX}
          min={0}
          name="signedOutDailyCap"
          required
          step={1}
          type="number"
        />
        <p className={MUTED} id="settings-daily-cap-hint">
          All signed-out reports together, per day, from 0 to {SIGNED_OUT_DAILY_CAP_MAX.toLocaleString('en-US')}.
        </p>
      </div>

      <div className={FIELD}>
        <label className={LABEL} htmlFor="settings-team-mailbox">Team mailbox</label>
        <Input
          aria-describedby="settings-team-mailbox-hint"
          autoComplete="off"
          id="settings-team-mailbox"
          name="teamRecipient"
          spellCheck={false}
          type="email"
        />
        <p className={MUTED} id="settings-team-mailbox-hint">
          {settings.teamRecipientDomain
            ? `Report emails go to an address at ${settings.teamRecipientDomain}.`
            : 'Not set: report emails are not sent until a mailbox is saved.'}{' '}
          Leave this empty to keep the current mailbox.
        </p>
      </div>

      <div className={FIELD}>
        <label className={LABEL} htmlFor="settings-base-url">Dashboard address</label>
        <Input
          aria-describedby="settings-base-url-hint"
          autoComplete="off"
          defaultValue={settings.adminBaseUrl ?? defaultBaseUrl}
          id="settings-base-url"
          name="adminBaseUrl"
          spellCheck={false}
          type="url"
        />
        <p className={MUTED} id="settings-base-url-hint">
          The address each report email links to: https:// and a host name, with no path.
          {settings.adminBaseUrl ? '' : ' Not saved yet; this dashboard\'s own address is filled in.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div>
          <Button disabled={pendingActionId !== undefined} loading={pendingActionId === 'update_settings'} loadingLabel="Saving…" type="submit">
            Save settings
          </Button>
        </div>
        <ActionFeedback actionId="update_settings" />
      </div>
    </form>
  );
}
