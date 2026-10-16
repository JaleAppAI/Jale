'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useTransition, type FormEvent } from 'react';
import { useIsClient } from '@/components/LocalTime';
import { secondaryLinkClass } from '@/components/security/link-styles';
import {
  actorOptions,
  rangeSelection,
  securitySearchFields,
  type RangeOption,
  type SecurityAdminOption,
} from '@/components/security/security-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  accessHistorySearchHref,
  type AccessHistoryProblem,
  type AccessHistoryQuery,
} from '@/lib/access-history';
import { isoToLocalInput } from '@/lib/local-time';

type AccessHistoryFiltersProps = {
  values: AccessHistoryQuery['values'];
  problems: readonly AccessHistoryProblem[];
  /** The id of the element that lists the problems. */
  problemsId: string;
  categories: readonly string[];
  outcomes: readonly string[];
  /** The Admin filter's options. */
  admins: readonly SecurityAdminOption[];
  /** Last 7 and 30 days, from the server render. */
  ranges: readonly RangeOption[];
  /** "Clear filters": the current tab with nothing else. */
  clearHref: string;
};

const LABEL = 'text-sm font-semibold text-[var(--jale-ink)]';
const FIELD = 'flex min-w-0 flex-col gap-1.5';
// The filters under "More filters": a problem with one of them opens it.
const ADVANCED: readonly AccessHistoryProblem[] = ['subject', 'record', 'category', 'outcome', 'from', 'to', 'range'];

function codeLabel(code: string): string {
  return code.replace(/_/g, ' ');
}

/**
 * The search form. It only navigates: the search runs on the server when the
 * page loads with the new URL. Times are entered in the viewer's zone and
 * sent as instants. A Range is sent as its From; a From typed under "More
 * filters" wins over it, and choosing a Range clears a typed From.
 */
export function AccessHistoryFilters({
  values, problems, problemsId, categories, outcomes, admins, ranges, clearHref,
}: AccessHistoryFiltersProps) {
  const router = useRouter();
  // A refused field points at the problem list.
  const invalid = (...names: AccessHistoryProblem[]) => (
    names.some((name) => problems.includes(name))
      ? { 'aria-invalid': true, 'aria-describedby': problemsId }
      : {}
  );
  const [isPending, startTransition] = useTransition();
  // The server cannot know the viewer's zone, so the time fields fill in
  // after hydration; the key remounts them with their local values.
  const isClient = useIsClient();
  const zone = isClient ? 'local' : 'server';
  const fromField = useRef<HTMLInputElement>(null);
  const range = rangeSelection(values.from, ranges);
  const actor = actorOptions(admins, values.actor);
  const advancedOpen = Boolean(values.subject || values.record || values.category || values.outcome || values.to)
    || range === 'custom'
    || problems.some((problem) => ADVANCED.includes(problem));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = securitySearchFields(Object.fromEntries(new FormData(event.currentTarget)), ranges);
    const href = accessHistorySearchHref(fields);
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <form
      aria-busy={isPending || undefined}
      aria-label="Search the access history"
      className="flex flex-col gap-4"
      onSubmit={handleSubmit}
      role="search"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className={FIELD}>
          <label className={LABEL} htmlFor="history-actor">Admin</label>
          <Select defaultValue={actor.selected} id="history-actor" {...invalid('actor')} name="actor">
            {actor.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="history-range">Range</label>
          <Select
            defaultValue={range}
            id="history-range"
            name="range"
            onChange={(event) => {
              if (event.currentTarget.value !== 'custom' && fromField.current) fromField.current.value = '';
            }}
          >
            <option value="">Any time</option>
            {ranges.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
            {range === 'custom' ? <option value="custom">Custom range</option> : null}
          </Select>
        </div>
      </div>
      <details className="rounded-[var(--radius-card)] border border-[var(--jale-divider)] px-4 py-3" open={advancedOpen}>
        <summary className="cursor-pointer rounded-sm text-sm font-semibold text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
          More filters
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-subject">Subject id</label>
            <Input autoComplete="off" defaultValue={values.subject ?? ''} id="history-subject" {...invalid('subject')} name="subject" spellCheck={false} translate="no" type="text" />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-record">Record id</label>
            <Input autoComplete="off" defaultValue={values.record ?? ''} id="history-record" {...invalid('record')} name="record" spellCheck={false} translate="no" type="text" />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-category">Category</label>
            <Select defaultValue={values.category ?? ''} id="history-category" {...invalid('category')} name="category">
              <option value="">Any category</option>
              {categories.map((category) => (
                <option key={category} value={category}>{codeLabel(category)}</option>
              ))}
            </Select>
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-outcome">Outcome</label>
            <Select defaultValue={values.outcome ?? ''} id="history-outcome" {...invalid('outcome')} name="outcome">
              <option value="">Any outcome</option>
              {outcomes.map((outcome) => (
                <option key={outcome} value={outcome}>{codeLabel(outcome)}</option>
              ))}
            </Select>
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-from">From</label>
            <Input
              autoComplete="off"
              defaultValue={isClient && range === 'custom' ? isoToLocalInput(values.from) : ''}
              id="history-from"
              {...invalid('from', 'range')}
              key={`from-${zone}`}
              name="fromLocal"
              ref={fromField}
              type="datetime-local"
            />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="history-to">To</label>
            <Input
              autoComplete="off"
              defaultValue={isClient ? isoToLocalInput(values.to) : ''}
              id="history-to"
              {...invalid('to', 'range')}
              key={`to-${zone}`}
              name="toLocal"
              type="datetime-local"
            />
          </div>
        </div>
      </details>
      <div className="flex flex-wrap gap-2.5">
        <Button loading={isPending} loadingLabel="Searching…" type="submit">Search</Button>
        <Link className={secondaryLinkClass} href={clearHref} prefetch={false}>Clear filters</Link>
      </div>
    </form>
  );
}
