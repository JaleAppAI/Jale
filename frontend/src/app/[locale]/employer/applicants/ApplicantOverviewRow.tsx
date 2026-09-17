'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useConversationDrawer } from '@/contexts/ConversationDrawerContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { ApplicationStatusBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MatchScoreBadge } from '@/components/ui/match-signals';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { initialsFor } from '@/components/employer/ConversationThread';
import { TrustScorePill } from '@/app/[locale]/employer/jobs/[id]/TrustScorePill';
import { statusSelectOptions } from '@/lib/hire-gate';
import { ApiError } from '@/lib/api/errors';
import { updateApplicantStatus } from '@/lib/api/employer';
import type { ApplicantOverviewItem } from '@/lib/api/employer';
import type { ApplicationStatus } from '@/lib/status';

const MAX_SKILL_BADGES = 4;

/**
 * Availability values the API returns, mapped onto `filters.availability_*`.
 *
 * Duplicated from the module-private `AVAILABILITY_KEYS`/
 * `normalizeAvailabilityKey` in `employer/jobs/[id]/page.tsx:1001-1015` and
 * kept identical, so the same worker's availability reads the same on the
 * per-job list and on this cross-job one. Copied rather than imported because
 * a `page.tsx` is not a module other routes should reach into, and hoisting it
 * would mean editing that page for no behavioural reason.
 *
 * FOLLOW-UP: lift this pair into `@/lib/` (alongside the other display
 * normalizers) the next time either surface is touched, and delete both
 * copies.
 */
const AVAILABILITY_KEYS = new Set([
  'immediate',
  '2weeks',
  '1month',
  'full_time',
  'part_time',
  'weekends',
  'flexible',
]);

function normalizeAvailabilityKey(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/-/g, '_');
  const collapsed = key === '2_weeks' ? '2weeks' : key === '1_month' ? '1month' : key;
  return AVAILABILITY_KEYS.has(collapsed) ? collapsed : null;
}

/**
 * One row of the cross-job applicants dashboard: identity, which job (title ·
 * city — the disambiguator when the same title is posted in several cities),
 * status, the cached match score, and the worker's qualifications.
 *
 * Sprint 24 (B8): the qualifications are the point of the row. The endpoint
 * had been returning availability, years of experience and the trust score all
 * along while this row rendered only a name and four skills, so triaging the
 * cross-job list meant opening every profile. The badges are the same ones the
 * per-job list uses — same component for the trust pill, same label
 * catalogues — so the two surfaces cannot describe a worker differently.
 * Everything deeper still lives on the profile page this row links to.
 */
export function ApplicantOverviewRow({ item }: { item: ApplicantOverviewItem }) {
  const t = useTranslations('employer_applicants');
  const tShared = useTranslations('employer_dashboard');
  const tListing = useTranslations('employer_job_listing');
  const tMatch = useTranslations('match');
  const format = useFormatter();
  const { idToken } = useAuth();
  const { openConversation } = useConversationDrawer();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  /**
   * The status this row has WRITTEN, while the list it came from still holds
   * the old one. `null` means "whatever the item says", so a refreshed list
   * simply takes over.
   */
  const [savedStatus, setSavedStatus] = useState<ApplicationStatus | null>(null);
  const [saving, setSaving] = useState(false);
  /*
   * ...and this is what makes "a refreshed list simply takes over" true.
   *
   * The local write outlives the response that committed it -- the parent
   * list still holds the old value until it refetches -- so it has to be
   * dropped the moment the LIST changes its mind. Without this, a row whose
   * status was moved from anywhere else (the worker detail page, another
   * device, a dismissal on the messages board) kept showing whatever this
   * component last wrote, for as long as it stayed mounted.
   *
   * The render-phase reset rather than an effect: this is React's documented
   * "adjusting state when a prop changes" pattern, and an effect would render
   * the stale status once before correcting it -- a visible flicker of a
   * status the server has already disagreed with.
   */
  const [listStatus, setListStatus] = useState<ApplicationStatus>(item.application_status);
  if (listStatus !== item.application_status) {
    setListStatus(item.application_status);
    setSavedStatus(null);
  }
  const status = savedStatus ?? item.application_status;

  async function handleStatusChange(next: ApplicationStatus) {
    /*
     * The guard that keeps `details_requested` out of this control.
     *
     * `statusSelectOptions` prepends the CURRENT status when it is not one an
     * employer may pick -- which today means exactly `details_requested` --
     * because a <select> whose value matches no option renders the first one's
     * label instead, mislabelling the row. On the worker detail page, Save is
     * disabled while the draft equals the saved status, and that is what
     * enforces lib/hire-gate's ruling: the dropdown must never MOVE an
     * application into `details_requested`, because that transition also
     * notifies the worker and belongs to the "Request details" button. This
     * row has no Save button, so this is the whole of that enforcement.
     */
    if (!idToken || saving || next === status) return;

    const previous = status;
    setSavedStatus(next);
    setSaving(true);
    try {
      const updated = await updateApplicantStatus(idToken, item.job_id, item.worker_id, next);
      // The API is the authority on what was committed.
      setSavedStatus(updated.status ?? next);
    } catch (err) {
      setSavedStatus(previous === item.application_status ? null : previous);
      /*
       * The database's own hire gate (migration 091), surfaced. This row
       * carries no `details_status`, so -- exactly like `hireBlockReason` on
       * an API that publishes no stage vocabulary -- `hired` is OFFERED and
       * the 409 is the authority. The remedy (request details) lives on the
       * profile, so the sentence sends them there rather than listing fields
       * this row cannot act on.
       */
      toast.error(
        err instanceof ApiError && err.code === 'details_incomplete'
          ? t('hire_blocked')
          : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  const name = item.worker_name ?? t('unknown_worker');
  const jobLine = item.job_city ? `${item.job_title} · ${item.job_city}` : item.job_title;
  const appliedDate = new Date(item.applied_at);
  const applied = Number.isFinite(appliedDate.getTime())
    ? t('applied_on', { date: format.dateTime(appliedDate, { month: 'short', day: 'numeric' }) })
    : null;
  const availabilityKey = item.availability ? normalizeAvailabilityKey(item.availability) : null;
  // Expanded shows the whole list; collapsed caps it. `hiddenSkills` is the
  // count the toggle names, so it is measured against the CAP either way.
  const hiddenSkills = Math.max(item.skills.length - MAX_SKILL_BADGES, 0);
  const shownSkills = skillsExpanded ? item.skills : item.skills.slice(0, MAX_SKILL_BADGES);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="avatar-initials h-9 w-9 shrink-0 text-[11px]">{initialsFor(name)}</span>

      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-bold text-[var(--jale-ink)]">{name}</p>
        <p className="truncate text-xs text-[var(--jale-ink-2)]">{jobLine}</p>
        {applied ? (
          <p className="mt-0.5 text-[11px] tabular-nums text-[var(--jale-ink-2)]">{applied}</p>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ApplicationStatusBadge status={status}>
          {tShared(`applicants.status.${status}`)}
        </ApplicationStatusBadge>
        {item.match_score !== null && item.score_band !== null ? (
          <MatchScoreBadge
            score={item.match_score}
            band={item.score_band}
            label={tMatch(`score_bands.${item.score_band}`)}
          />
        ) : (
          <span className="text-[11px] font-medium text-[var(--jale-ink-2)]">{t('not_scored')}</span>
        )}
        {/* Beside the match badge, not instead of it: they answer two
            different questions -- how well this worker fits THAT job, and how
            they came across when asked about their trade. Renders nothing for
            a null/absent score, so a worker who never took the assessment is
            never labelled "Trust 0". */}
        <TrustScorePill score={item.trust_score ?? null} />
        {availabilityKey ? (
          <Badge tone="neutral">{tListing(`filters.availability_${availabilityKey}`)}</Badge>
        ) : null}
        {item.years_experience !== null ? (
          <Badge tone="neutral">
            <span className="tabular-nums">
              {tShared('worker_profile.years_experience', { years: item.years_experience })}
            </span>
          </Badge>
        ) : null}
        {shownSkills.map((skill) => (
          <Badge key={skill} tone="info">{skill}</Badge>
        ))}
        {/* A real button, not a decorative badge: the old `+1` looked
            interactive, did nothing, and gave no way to see the rest without
            leaving the list. Expands INLINE -- the row is the triage surface,
            and a navigation to read two more words is the thing B8 removes. */}
        {hiddenSkills > 0 ? (
          <button
            type="button"
            aria-expanded={skillsExpanded}
            onClick={() => setSkillsExpanded((open) => !open)}
            className="rounded-full border border-[var(--jale-divider)] px-2 py-0.5 text-[11px] font-semibold text-[var(--jale-ink-2)] transition-colors duration-150 hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {skillsExpanded
              ? t('skills_show_fewer')
              : t('skills_show_all', { count: item.skills.length })}
          </button>
        ) : null}
      </div>

      {/* The row's actions. Sprint 26 (B4): triaging this list used to mean
          opening every applicant -- two clicks and a page load to move
          somebody to "talking", and no way at all to write to them from here.
          The two things an employer does after reading a row now happen in
          it; everything deeper still lives on the profile. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="w-40">
          {/* The label is the accessible name, not a visible one: the row is a
              scan surface and a "Status" caption over every select would
              triple the vertical space it costs.

              No size override: the primitive's 44px minimum is the touch
              target this control needs on the phone where this list is read,
              and `Select` joins class strings rather than merging them -- a
              competing `min-h` would be settled by stylesheet order, not by
              this call site. */}
          <Select
            aria-label={t('status_label')}
            value={status}
            disabled={saving || !idToken}
            onChange={(event) => void handleStatusChange(event.target.value as ApplicationStatus)}
          >
            {statusSelectOptions(status).map((option) => (
              <option key={option} value={option}>
                {tShared(`applicants.status.${option}`)}
              </option>
            ))}
          </Select>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          /* The ids say WHO, and the four display fields say who they are.
             This board has no job-status filter, so it lists applicants of
             paused, filled and closed jobs; the drawer resolves an application
             against the employer inbox, which lists a never-messaged applicant
             only while their job is active. Without these fields such a row
             opened on "This candidate is no longer available" -- for a worker
             the messaging API would have accepted. */
          onClick={() =>
            openConversation({
              application_id: item.application_id,
              worker_id: item.worker_id,
              job_id: item.job_id,
              worker_name: item.worker_name,
              job_title: item.job_title,
              job_city: item.job_city,
              applied_at: item.applied_at,
            })
          }
        >
          {t('message_action')}
        </Button>

        <Link
          href={`/employer/workers/${item.worker_id}?job_id=${item.job_id}`}
          className="text-xs font-bold text-[var(--primary)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {tShared('applicants.view_profile')}
        </Link>
      </div>
    </div>
  );
}
