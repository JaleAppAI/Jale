'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition, type FormEvent } from 'react';
import { useIsClient } from '@/components/LocalTime';
import {
  ACCESS_HISTORY_PATH,
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
};

function codeLabel(code: string): string {
  return code.replace(/_/g, ' ');
}

/**
 * The search form. It only navigates: the search runs on the server when the
 * page loads with the new URL. Times are entered in the viewer's zone and
 * sent as instants.
 */
export function AccessHistoryFilters({ values, problems, problemsId, categories, outcomes }: AccessHistoryFiltersProps) {
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const href = accessHistorySearchHref(Object.fromEntries(new FormData(event.currentTarget)));
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <form
      aria-busy={isPending || undefined}
      aria-label="Search the access history"
      className="stack-gap"
      onSubmit={handleSubmit}
      role="search"
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="history-subject">Subject id</label>
          <input
            autoComplete="off"
            defaultValue={values.subject ?? ''}
            id="history-subject"
            {...invalid('subject')}
            name="subject"
            spellCheck={false}
            type="text"
          />
        </div>
        <div className="field">
          <label htmlFor="history-actor">Actor id</label>
          <input
            autoComplete="off"
            defaultValue={values.actor ?? ''}
            id="history-actor"
            {...invalid('actor')}
            name="actor"
            spellCheck={false}
            type="text"
          />
        </div>
        <div className="field">
          <label htmlFor="history-record">Record id</label>
          <input
            autoComplete="off"
            defaultValue={values.record ?? ''}
            id="history-record"
            {...invalid('record')}
            name="record"
            spellCheck={false}
            type="text"
          />
        </div>
        <div className="field">
          <label htmlFor="history-category">Category</label>
          <select defaultValue={values.category ?? ''} id="history-category" {...invalid('category')} name="category">
            <option value="">Any category</option>
            {categories.map((category) => (
              <option key={category} value={category}>{codeLabel(category)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="history-from">From</label>
          <input
            autoComplete="off"
            defaultValue={isClient ? isoToLocalInput(values.from) : ''}
            id="history-from"
            {...invalid('from', 'range')}
            key={`from-${zone}`}
            name="fromLocal"
            type="datetime-local"
          />
        </div>
        <div className="field">
          <label htmlFor="history-to">To</label>
          <input
            autoComplete="off"
            defaultValue={isClient ? isoToLocalInput(values.to) : ''}
            id="history-to"
            {...invalid('to', 'range')}
            key={`to-${zone}`}
            name="toLocal"
            type="datetime-local"
          />
        </div>
        <div className="field">
          <label htmlFor="history-outcome">Outcome</label>
          <select defaultValue={values.outcome ?? ''} id="history-outcome" {...invalid('outcome')} name="outcome">
            <option value="">Any outcome</option>
            {outcomes.map((outcome) => (
              <option key={outcome} value={outcome}>{codeLabel(outcome)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="history-actions">
        <button className="button" disabled={isPending} type="submit">
          {isPending ? 'Searching…' : 'Search'}
        </button>
        <Link className="button secondary" href={ACCESS_HISTORY_PATH} prefetch={false}>Clear filters</Link>
      </div>
    </form>
  );
}
