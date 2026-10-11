import Link from 'next/link';
import type { ReactNode } from 'react';
import { LocalTime } from '@/components/LocalTime';
import { AccessHistoryFilters } from '@/components/access-history/AccessHistoryFilters';
import {
  ACCESS_HISTORY_PROBLEMS,
  accessHistoryHref,
  type AccessHistoryFilter,
  type AccessHistoryQuery,
  type AccessHistoryResult,
} from '@/lib/access-history';
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES, isUuid } from '@/lib/server/audit/codes';
import type { AccessHistoryEntry } from '@/lib/types';

// The access history. Read-only: nothing here can change an
// entry. Rendered on the server; only the search form and the times are
// client components. Every search is recorded, so links to a search are never
// prefetched: a prefetch must not run a search the admin did not make.

const KIND_LABELS: Readonly<Record<string, string>> = {
  read: 'Viewed',
  attempt: 'Attempt',
  session: 'Session',
  action: 'Action',
};

// The change log writes operations in lower case.
const OPERATION_LABELS: Readonly<Record<string, string>> = {
  insert: 'Added to',
  update: 'Changed in',
  delete: 'Removed from',
  truncate: 'Emptied',
};

const OUTCOME_TONES: Readonly<Record<string, string>> = {
  allowed: 'success',
  done: 'success',
  signed_in: 'success',
  signed_out: 'success',
  not_found: 'warning',
  expired: 'warning',
  revoked: 'warning',
  denied: 'danger',
  failed: 'danger',
  sign_in_rejected: 'danger',
};

const SHOWN_IDS = 3;
const PROBLEMS_ID = 'history-problems';

function codeLabel(code: string): string {
  return code.replace(/_/g, ' ');
}

function HistoryHero() {
  return (
    <section className="hero">
      <div className="meta">
        <span className="badge verification">Superadmin</span>
      </div>
      <h1>Access history</h1>
      <p className="muted">
        Who viewed, changed or tried to reach personal data, newest first. Times are shown in your time
        zone. Entries cannot be edited.
      </p>
    </section>
  );
}

function IdLinks({ ids, filterKey }: { ids: readonly string[]; filterKey: 'subjectUserId' | 'recordId' }) {
  const link = (id: string) => (
    <Link className="history-id" href={accessHistoryHref({ [filterKey]: id })} key={id} prefetch={false}>
      <code translate="no">{id}</code>
    </Link>
  );
  const shown = ids.slice(0, SHOWN_IDS);
  const rest = ids.slice(SHOWN_IDS);
  return (
    <div className="history-ids">
      {shown.map(link)}
      {rest.length > 0 ? (
        <details className="history-more">
          <summary>{`${rest.length} more`}</summary>
          <div className="history-ids">{rest.map(link)}</div>
        </details>
      ) : null}
    </div>
  );
}

function EntryHeadline({ entry }: { entry: AccessHistoryEntry }) {
  if (entry.source === 'legacy') {
    return <strong>{entry.summary ?? `${entry.action ?? 'action'} on ${entry.targetType ?? 'record'}`}</strong>;
  }
  if (entry.source === 'change') {
    const operation = (entry.operation ?? '').toLowerCase();
    return (
      <span>
        <strong>{OPERATION_LABELS[operation] ?? (operation || 'Changed')}</strong>{' '}
        <code className="history-code" translate="no">{entry.tableName}</code>
      </span>
    );
  }
  return (
    <span>
      <strong>{KIND_LABELS[entry.kind ?? ''] ?? entry.kind}</strong>{' '}
      <code className="history-code" translate="no">{entry.surface}</code>
    </span>
  );
}

function EntryDetails({ entry }: { entry: AccessHistoryEntry }) {
  const details: [string, ReactNode][] = [];
  if (entry.categories.length > 0) details.push(['Categories', entry.categories.map(codeLabel).join(', ')]);
  if (entry.purposeKind) {
    details.push(['Purpose', entry.purposeId ? <>{codeLabel(entry.purposeKind)} <code translate="no">{entry.purposeId}</code></> : codeLabel(entry.purposeKind)]);
  }
  if (entry.fieldNames.length > 0) details.push(['Fields', entry.fieldNames.join(', ')]);
  if (entry.resultCount !== undefined && (entry.kind === 'read' || entry.kind === 'action')) {
    details.push(['Result count', String(entry.resultCount)]);
  }
  // Every event is part 1 of 1 unless it was split at 500 ids.
  if (entry.part !== undefined && entry.parts !== undefined && entry.parts > 1) {
    details.push(['Part', `${entry.part} of ${entry.parts}`]);
  }
  if (entry.linkExpiresAt) details.push(['Link expires', <LocalTime iso={entry.linkExpiresAt} />]);
  if (entry.changedFields.length > 0) details.push(['Changed fields', entry.changedFields.join(', ')]);
  if (entry.rowCount !== undefined) details.push(['Rows', String(entry.rowCount)]);
  if (entry.contextStatus) details.push(['Context', codeLabel(entry.contextStatus)]);
  if (entry.source === 'legacy' && entry.action) details.push(['Action', codeLabel(entry.action)]);
  if (entry.requestId) details.push(['Request', <code translate="no">{entry.requestId}</code>]);

  return (
    <>
      {details.length > 0 ? (
        <dl className="history-details">
          {details.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {entry.reason ? (
        <p className="history-reason">
          <span className="muted">Reason:</span> {entry.reason}
        </p>
      ) : null}
      {entry.source === 'legacy' ? <span className="muted">From the earlier action log.</span> : null}
    </>
  );
}

function EntryActor({ entry }: { entry: AccessHistoryEntry }) {
  const name = entry.actorEmail ?? (entry.actorKind === 'anonymous' ? 'Not signed in' : codeLabel(entry.actorKind ?? 'unknown'));
  return (
    <div className="stack">
      <span className="muted">Actor</span>
      <span className="history-name">{name}</span>
      {entry.actorRole ? <span className="muted">{codeLabel(entry.actorRole)}</span> : null}
      {entry.actorId && isUuid(entry.actorId) ? (
        <Link className="history-id" href={accessHistoryHref({ actorId: entry.actorId })} prefetch={false}>
          <code translate="no">{entry.actorId}</code>
        </Link>
      ) : null}
    </div>
  );
}

function EntryTargets({ entry }: { entry: AccessHistoryEntry }) {
  if (entry.source === 'legacy') {
    return (
      <div className="stack">
        <span className="muted">{entry.targetType ? `Target (${codeLabel(entry.targetType)})` : 'Target'}</span>
        {entry.targetId && isUuid(entry.targetId) ? (
          <IdLinks filterKey="recordId" ids={[entry.targetId]} />
        ) : (
          <code className="history-code" translate="no">{entry.targetId ?? 'none'}</code>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <span className="muted">People</span>
      {entry.subjectUserIds.length > 0 ? (
        <IdLinks filterKey="subjectUserId" ids={entry.subjectUserIds} />
      ) : (
        <span className="muted">None named</span>
      )}
      <span className="muted">{entry.recordType ? `Records (${codeLabel(entry.recordType)})` : 'Records'}</span>
      {entry.recordIds.length > 0 ? (
        <IdLinks filterKey="recordId" ids={entry.recordIds} />
      ) : (
        <span className="muted">None named</span>
      )}
    </div>
  );
}

function EntryBadges({ entry }: { entry: AccessHistoryEntry }) {
  const reveal = entry.purposeKind === 'reveal' || entry.piiReveal;
  return (
    <div className="meta history-badges">
      {entry.source === 'legacy' ? <span className="pill warning">Legacy record</span> : null}
      {entry.source === 'change' ? <span className="pill">Data change</span> : null}
      {entry.source === 'event' ? <span className="pill">Access record</span> : null}
      {entry.outcome ? (
        <span className={`pill ${OUTCOME_TONES[entry.outcome] ?? ''}`.trim()}>{codeLabel(entry.outcome)}</span>
      ) : null}
      {reveal ? <span className="pill danger">Contact reveal</span> : null}
    </div>
  );
}

function HistoryEntry({ entry }: { entry: AccessHistoryEntry }) {
  return (
    <article className="audit-row history-row">
      <div className="stack">
        <EntryHeadline entry={entry} />
        <LocalTime iso={entry.occurredAt} />
        <EntryDetails entry={entry} />
      </div>
      <EntryActor entry={entry} />
      <EntryTargets entry={entry} />
      <EntryBadges entry={entry} />
    </article>
  );
}

// What a filter leaves out, said where the admin sees the result.
function NarrowingHints({ filter }: { filter: AccessHistoryFilter }) {
  return (
    <>
      {filter.subjectUserId ? (
        <p className="muted">
          The earlier action log names records, not people, so a subject search leaves it out. Search by
          record id to include it.
        </p>
      ) : null}
      {filter.category || filter.outcome ? (
        <p className="muted">
          Only access records carry a category and an outcome, so data changes and the earlier action log
          are left out.
        </p>
      ) : null}
    </>
  );
}

function SearchCard({ query }: { query: AccessHistoryQuery }) {
  return (
    <section aria-labelledby="history-search-title" className="card stack-gap">
      <h2 id="history-search-title">Search</h2>
      {/* Moving to another search keeps this page mounted, and the form's
          fields are uncontrolled, so each search mounts its own form: it then
          shows that search's filters, never the previous one's. Paging changes
          only the cursor and keeps the form. */}
      <AccessHistoryFilters
        categories={AUDIT_CATEGORIES}
        key={JSON.stringify(query.values)}
        outcomes={AUDIT_OUTCOMES}
        problems={query.problems}
        problemsId={PROBLEMS_ID}
        values={query.values}
      />
      {query.problems.length > 0 ? (
        <div className="form-error" id={PROBLEMS_ID} role="alert">
          <ul className="history-problems">
            {query.problems.map((problem) => (
              <li key={problem}>{ACCESS_HISTORY_PROBLEMS[problem]}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function AccessHistoryView({ result }: { result: AccessHistoryResult }) {
  if (result.status === 'forbidden') {
    return (
      <main className="stack-gap">
        <section className="hero stack-gap">
          <div className="meta">
            <span className="badge dismissed">403</span>
          </div>
          <h1>Access history is for superadmins</h1>
          <p className="muted">Only superadmins can open the access history.</p>
          <div>
            <Link className="button" href="/" prefetch={false}>Back to dashboard</Link>
          </div>
        </section>
      </main>
    );
  }

  if (result.status === 'preview') {
    return (
      <main className="stack-gap">
        <HistoryHero />
        <section className="card">
          <p className="muted">
            The local preview has no signed-in admin, so it cannot search the access history. Sign in as a
            superadmin to use it.
          </p>
        </section>
      </main>
    );
  }

  if (result.status === 'invalid') {
    return (
      <main className="stack-gap">
        <HistoryHero />
        <SearchCard query={result.query} />
      </main>
    );
  }

  const { query, entries, nextBefore } = result;
  return (
    <main className="stack-gap">
      <HistoryHero />
      <SearchCard query={query} />
      <section aria-labelledby="history-entries-title" className="card stack-gap">
        <div className="section-title">
          <h2 id="history-entries-title">Entries</h2>
          <span className="muted">{`${entries.length} shown`}</span>
        </div>
        <NarrowingHints filter={query.filter} />
        {entries.length > 0 ? (
          <ol className="list history-list">
            {entries.map((entry) => (
              <li className="history-item" key={entry.key}>
                <HistoryEntry entry={entry} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No entries match this search.</p>
        )}
        {query.before || nextBefore ? (
          <nav aria-label="Pages" className="history-actions">
            {query.before ? (
              <Link className="button secondary" href={accessHistoryHref(query.filter)} prefetch={false}>
                Newest entries
              </Link>
            ) : null}
            {nextBefore ? (
              <Link className="button secondary" href={accessHistoryHref(query.filter, nextBefore)} prefetch={false}>
                Older entries
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </main>
  );
}
