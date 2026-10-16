import { requireAdminSession } from '@/lib/server/session';
import {
  getBillingInbox,
  getBillingInboxNow,
  getCaseAging,
  getCaseResolution,
  getDlqDepth,
  getMessageBacklog,
  getMessageFailures,
  getRankingFreshness,
  getResetReasons,
  getTrustExtraction,
  getVoiceExtraction,
  parseFunnelWeeks,
} from '@/lib/server/admin-analytics';
import {
  billingStuck,
  billingStuckNote,
  billingTile,
  failureRateNote,
  formatFailureRate,
  messagesStuckNote,
  opsHref,
  queueTile,
  rankingTile,
  splitBillingInbox,
  splitMessageFailures,
  splitTrustExtraction,
  splitVoiceExtraction,
  stuckMessages,
  voiceSuccess,
  voiceSuccessNote,
} from '@/lib/ops-health';
import { formatCount } from '@/lib/analytics-format';
import { StatTile } from '@/components/ui/stat-tile';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { BillingInbox } from '@/components/analytics/BillingInbox';
import { MessageBacklog } from '@/components/analytics/MessageBacklog';
import { MessageFailures } from '@/components/analytics/MessageFailures';
import { PipelinesStrip } from '@/components/analytics/PipelinesStrip';
import { TrustExtraction } from '@/components/analytics/TrustExtraction';
import { VoiceExtraction } from '@/components/analytics/VoiceExtraction';
import { CaseAgingPanel, CaseResolutionPanel, ExtractionPanel, ResetReasonsPanel } from '@/components/analytics/panels/ops';

export const dynamic = 'force-dynamic';

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[] }>;
}) {
  await requireAdminSession();
  const { weeks: weeksParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const now = new Date();

  // Four waves of at most three, each after the one before: db.ts caps the
  // shared pool at max: 5. getDlqDepth reads SQS, not the pool, and is
  // still counted in a wave. A failing queue never fails the page.
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
  const [caseAges, caseResolution, resetReasons] = await Promise.all([
    getCaseAging(),
    getCaseResolution(weeks),
    getResetReasons(30),
  ]);
  const [dlq, rankings] = await Promise.all([getDlqDepth(), getRankingFreshness()]);

  const failures = splitMessageFailures(failureRows);
  const voice = splitVoiceExtraction(voiceRows);
  const trust = splitTrustExtraction(trustRows);
  const billing = splitBillingInbox(billingRows);
  const billingNow = billingTile(inboxNow);
  const queues = queueTile(backlog, dlq);
  const ranking = rankingTile(rankings);

  return (
    <div className="flex flex-col gap-6">
      <AnalyticsHeader
        active="ops"
        weeks={weeks}
        rangeHref={opsHref}
        note="The range changes the weekly sections and the two rate tiles; stuck counts and the pipelines are always live."
      />

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Messages stuck now" value={formatCount(stuckMessages(backlog))} hint={messagesStuckNote(backlog, now)} />
        <StatTile label="Billing events stuck" value={formatCount(billingStuck(inboxNow))} hint={billingStuckNote(inboxNow, now)} />
        <StatTile label="Message failure rate" value={formatFailureRate(failures.window)} hint={failureRateNote(failures.window)} />
        <StatTile label="Voice extraction success" value={voiceSuccess(voice.window)} hint={voiceSuccessNote(voice.window)} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <CaseAgingPanel tag="#6" buckets={caseAges} />
        </div>
        <div className="min-w-0">
          <ResetReasonsPanel tag="#5" linkTag="#7" rows={resetReasons} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <CaseResolutionPanel tag="#6" weeks={caseResolution} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <ExtractionPanel tag="#10" voice={voice} now={now} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <PipelinesStrip
            items={[
              { tag: '#9', label: 'Billing webhooks failed, last 24 hours', value: billingNow.value, hint: billingNow.hint },
              { tag: '#11', label: 'Messages queued · dead-lettered', value: queues.value, hint: queues.hint },
              { tag: '#19', label: 'Candidate rankings older than 24h', value: ranking.value, hint: ranking.hint },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <MessageBacklog lanes={backlog} />
          <MessageFailures failures={failures} now={now} />
          <VoiceExtraction voice={voice} now={now} />
          <TrustExtraction trust={trust} now={now} />
          <BillingInbox billing={billing} inbox={inboxNow} now={now} />
        </div>
      </div>
    </div>
  );
}
