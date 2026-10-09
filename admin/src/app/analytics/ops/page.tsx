import Link from 'next/link';
import { requireAdminSession } from '@/lib/server/session';
import {
  getBillingInbox,
  getBillingInboxNow,
  getMessageBacklog,
  getMessageFailures,
  getTrustExtraction,
  getVoiceExtraction,
  parseFunnelWeeks,
} from '@/lib/server/admin-analytics';
import {
  billingStuck,
  billingStuckNote,
  failureRateNote,
  formatFailureRate,
  messagesStuckNote,
  opsHref,
  splitBillingInbox,
  splitMessageFailures,
  splitTrustExtraction,
  splitVoiceExtraction,
  stuckMessages,
  voiceSuccess,
  voiceSuccessNote,
} from '@/lib/ops-health';
import type { FunnelWeeks } from '@/lib/types';
import { AnalyticsTabs } from '@/components/analytics/AnalyticsTabs';
import { BillingInbox } from '@/components/analytics/BillingInbox';
import { KpiTile } from '@/components/analytics/KpiTile';
import { MessageBacklog } from '@/components/analytics/MessageBacklog';
import { MessageFailures } from '@/components/analytics/MessageFailures';
import { TrustExtraction } from '@/components/analytics/TrustExtraction';
import { VoiceExtraction } from '@/components/analytics/VoiceExtraction';

export const dynamic = 'force-dynamic';

const WEEK_OPTIONS: FunnelWeeks[] = [4, 8, 12];

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[] }>;
}) {
  await requireAdminSession();
  const { weeks: weeksParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const now = new Date();

  // Six queries in two waves of three: db.ts caps the shared pool at max: 5,
  // so one wave of six would hold the whole pool (as /analytics).
  const [backlog, failureRows, inboxNow] = await Promise.all([
    getMessageBacklog(),
    getMessageFailures(weeks),
    getBillingInboxNow(),
  ]);
  const [voiceRows, trustRows, billingRows] = await Promise.all([
    getVoiceExtraction(weeks),
    getTrustExtraction(weeks),
    getBillingInbox(weeks),
  ]);

  const failures = splitMessageFailures(failureRows);
  const voice = splitVoiceExtraction(voiceRows);
  const trust = splitTrustExtraction(trustRows);
  const billing = splitBillingInbox(billingRows);

  return (
    <main className="stack-gap">
      <section className="hero analytics-hero">
        <div>
          <AnalyticsTabs active="ops" />
          <h1>Ops health</h1>
          <p className="muted">What is stuck right now, then how messaging, AI extraction and billing held up week by week · computed live</p>
        </div>
        <div className="ops-picker">
          <nav className="range-picker" aria-label="Weeks">
            {WEEK_OPTIONS.map((value) => (
              <Link
                key={value}
                className="button"
                href={opsHref(value)}
                aria-current={value === weeks ? 'page' : undefined}
              >
                {value} weeks
              </Link>
            ))}
          </nav>
          <p className="muted">Weeks change the weekly sections and the two rate tiles; stuck counts are always live.</p>
        </div>
      </section>

      <section className="kpi-strip funnel-kpis" aria-label="Key figures">
        <KpiTile label="Messages stuck now" value={stuckMessages(backlog)} note={messagesStuckNote(backlog, now)} />
        <KpiTile label="Billing events stuck" value={billingStuck(inboxNow)} note={billingStuckNote(inboxNow, now)} />
        <KpiTile label="Message failure rate" value={formatFailureRate(failures.window)} note={failureRateNote(failures.window)} />
        <KpiTile label="Voice extraction success" value={voiceSuccess(voice.window)} note={voiceSuccessNote(voice.window)} />
      </section>

      <MessageBacklog lanes={backlog} />
      <MessageFailures failures={failures} now={now} />
      <VoiceExtraction voice={voice} now={now} />
      <TrustExtraction trust={trust} now={now} />
      <BillingInbox billing={billing} inbox={inboxNow} now={now} />

      <p className="muted" style={{ fontSize: '0.78rem' }}>
        Retry windows (a message is stuck when it is still open this long after it was created): WhatsApp replies 30
        min, Admin replies 10 min, Worker notifications 24 h, Employer invites and Employer free-text messages 30 min,
        Job alerts (old lane) 30 min. Open means created in the last 48 hours and not sent yet: waiting, retrying, or
        in flight. WhatsApp replies are retried only while their incoming message is redelivered (about 30 minutes);
        after that they are stranded. Worker notifications can legitimately wait up to 48 hours for a message template
        to be approved; the 24-hour mark matches the existing backlog alarm. After 48 hours nothing retries a message,
        so anything still unsent counts as gave up. Gave up also covers the last of 5 attempts failing, a send that
        ended with an unknown result, and any failed worker notification (an expired template wait fails it after
        fewer attempts). A delivery failure was sent, but Twilio reported it failed or undelivered. Failure rate =
        (gave up + delivery failures) ÷ messages created, by the week a message was created. Free-text employer
        messages record delivery failures on the conversation, not in this lane; the message delivery panel on the
        Growth tab counts them. Deleting a job deletes its employer-message history. Job alerts now go out as worker
        notifications; only the old job-alert lane is dormant, and it shows only when it has messages. Voice figures
        count only voice notes that produced a row, as attempts: a note processed twice counts twice, and a pipeline
        crash or timeout leaves no row, so that note is not counted. Failure causes are recorded only since migration
        115 was applied; failed rows from before then show as Cause not recorded. Pipeline error also includes AI
        calls that timed out after 60 seconds and, occasionally, an extra row written after a successful save. Field
        completeness counts a field as found when it has a value with confidence 0.75 or higher, the threshold
        onboarding uses. Test profiles are left out of the voice figures. Trust extraction: not enough detail means
        the answers had too little in them to send to the AI; average sections counts how many of the five (skills,
        tools, experience, safety, notable) came back non-empty. Billing stuck means received but never claimed, or
        the 5-minute processing claim expired. Billing events are retried for about 20 minutes; any still stuck or
        failed after an hour have been dead-lettered and can be redriven from the queue for 14 days. Older ones have
        left the queue and must be resent from Stripe. Weeks marked so far are still in progress, and messages that
        are still open can still add failures to their week.
      </p>
    </main>
  );
}
