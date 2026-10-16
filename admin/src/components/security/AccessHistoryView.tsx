import Link from 'next/link';
import type { ReactNode } from 'react';
import { LocalTime } from '@/components/LocalTime';
import { AccessHistoryFilters } from '@/components/security/AccessHistoryFilters';
import { secondaryLinkClass } from '@/components/security/link-styles';
import { SecurityTabs } from '@/components/security/SecurityTabs';
import { rangeOptions, securityClearHref, type SecurityAdminOption } from '@/components/security/security-query';
import { SuperadminOnly } from '@/components/security/SuperadminOnly';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { TableScroll } from '@/components/ui/table-scroll';
import {
  ACCESS_HISTORY_PROBLEMS,
  accessHistoryHref,
  type AccessHistoryFilter,
  type AccessHistoryQuery,
  type AccessHistoryResult,
} from '@/lib/access-history';
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES, isUuid } from '@/lib/server/audit/codes';
import type { AccessHistoryEntry } from '@/lib/types';

// The Security page (K1.6): the access history, with tabs that preset its
// filters. Read-only: nothing here can change an entry. Rendered on the
// server; only the search form and the times are client components. Every
// search is recorded, so links to a search are never prefetched: a prefetch
// must not run a search the admin did not make.

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

const OUTCOME_TONES: Readonly<Record<string, BadgeTone>> = {
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
const MUTED = 'text-[var(--jale-ink-2)]';
const CODE = 'font-mono text-xs [overflow-wrap:anywhere]';
const ID_LINK = 'rounded-sm text-[var(--jale-blue-500)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';
const HEAD = 'px-5 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]';
const CELL = 'px-5 py-3.5 align-top';

function codeLabel(code: string): string {
  return code.replace(/_/g, ' ');
}

function SecurityHeader() {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="text-3xl font-extrabold tracking-tight text-balance text-[var(--jale-ink)]">Security</h1>
      <p className={`text-sm ${MUTED}`}>Who looked at what, who changed what, and every sign-in. Superadmins only.</p>
    </header>
  );
}

function IdLinks({ ids, filterKey }: { ids: readonly string[]; filterKey: 'subjectUserId' | 'recordId' }) {
  const link = (id: string) => (
    <Link className={ID_LINK} href={accessHistoryHref({ [filterKey]: id })} key={id} prefetch={false}>
      <code className={CODE} translate="no">{id}</code>
    </Link>
  );
  const shown = ids.slice(0, SHOWN_IDS);
  const rest = ids.slice(SHOWN_IDS);
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {shown.map(link)}
      {rest.length > 0 ? (
        <details>
          <summary className="cursor-pointer rounded-sm text-xs font-semibold focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">{`${rest.length} more`}</summary>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{rest.map(link)}</div>
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
        <code className={CODE} translate="no">{entry.tableName}</code>
      </span>
    );
  }
  return (
    <span>
      <strong>{KIND_LABELS[entry.kind ?? ''] ?? entry.kind}</strong>{' '}
      <code className={CODE} translate="no">{entry.surface}</code>
    </span>
  );
}

function EntryDetails({ entry }: { entry: AccessHistoryEntry }) {
  const details: [string, ReactNode][] = [];
  if (entry.categories.length > 0) details.push(['Categories', entry.categories.map(codeLabel).join(', ')]);
  if (entry.purposeKind) {
    details.push(['Purpose', entry.purposeId ? <>{codeLabel(entry.purposeKind)} <code className={CODE} translate="no">{entry.purposeId}</code></> : codeLabel(entry.purposeKind)]);
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
  if (entry.requestId) details.push(['Request', <code className={CODE} translate="no">{entry.requestId}</code>]);

  return (
    <>
      {details.length > 0 ? (
        <dl className="flex flex-col gap-1 text-xs">
          {details.map(([term, value]) => (
            <div className="flex flex-wrap gap-x-2" key={term}>
              <dt className={MUTED}>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {entry.reason ? (
        <p className="text-xs">
          <span className={MUTED}>Reason:</span> {entry.reason}
        </p>
      ) : null}
      {entry.source === 'legacy' ? <span className={`text-xs ${MUTED}`}>From the earlier action log.</span> : null}
    </>
  );
}

function EntryActor({ entry }: { entry: AccessHistoryEntry }) {
  const name = entry.actorEmail ?? (entry.actorKind === 'anonymous' ? 'Not signed in' : codeLabel(entry.actorKind ?? 'unknown'));
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-semibold [overflow-wrap:anywhere]">{name}</span>
      {entry.actorRole ? <span className={`text-xs ${MUTED}`}>{codeLabel(entry.actorRole)}</span> : null}
      {entry.actorId && isUuid(entry.actorId) ? (
        <Link className={ID_LINK} href={accessHistoryHref({ actorId: entry.actorId })} prefetch={false}>
          <code className={CODE} translate="no">{entry.actorId}</code>
        </Link>
      ) : null}
    </div>
  );
}

function EntryTargets({ entry }: { entry: AccessHistoryEntry }) {
  if (entry.source === 'legacy') {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className={MUTED}>{entry.targetType ? `Target (${codeLabel(entry.targetType)})` : 'Target'}</span>
        {entry.targetId && isUuid(entry.targetId) ? (
          <IdLinks filterKey="recordId" ids={[entry.targetId]} />
        ) : (
          <code className={CODE} translate="no">{entry.targetId ?? 'none'}</code>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className={MUTED}>People</span>
      {entry.subjectUserIds.length > 0 ? (
        <IdLinks filterKey="subjectUserId" ids={entry.subjectUserIds} />
      ) : (
        <span className={MUTED}>None named</span>
      )}
      <span className={MUTED}>{entry.recordType ? `Records (${codeLabel(entry.recordType)})` : 'Records'}</span>
      {entry.recordIds.length > 0 ? (
        <IdLinks filterKey="recordId" ids={entry.recordIds} />
      ) : (
        <span className={MUTED}>None named</span>
      )}
    </div>
  );
}

function EntryBadges({ entry }: { entry: AccessHistoryEntry }) {
  const reveal = entry.purposeKind === 'reveal' || entry.piiReveal;
  const badges: [key: string, tone: BadgeTone, text: string][] = [];
  if (entry.source === 'legacy') badges.push(['source', 'warning', 'Legacy record']);
  if (entry.source === 'change') badges.push(['source', 'neutral', 'Data change']);
  if (entry.source === 'event') badges.push(['source', 'neutral', 'Access record']);
  if (entry.outcome) badges.push(['outcome', OUTCOME_TONES[entry.outcome] ?? 'neutral', codeLabel(entry.outcome)]);
  if (reveal) badges.push(['reveal', 'danger', 'Contact reveal']);
  return (
    <ul className="m-0 flex list-none flex-col items-start gap-1.5 p-0">
      {badges.map(([key, tone, text]) => (
        <li data-tone={tone} key={key}>
          <Badge tone={tone}>{text}</Badge>
        </li>
      ))}
    </ul>
  );
}

function EntriesTable({ entries }: { entries: AccessHistoryEntry[] }) {
  return (
    <TableScroll label="Access history entries">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--jale-divider)]">
            <th className={`${HEAD} w-[170px]`} scope="col">When</th>
            <th className={HEAD} scope="col">What</th>
            <th className={`${HEAD} w-[210px]`} scope="col">Who</th>
            <th className={`${HEAD} w-[160px]`} scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr className="border-b border-[var(--jale-divider)] last:border-b-0" data-entry={entry.source} key={entry.key}>
              <td className={`${CELL} ${MUTED}`}><LocalTime iso={entry.occurredAt} /></td>
              <td className={CELL}>
                <div className="flex min-w-0 flex-col gap-2">
                  <EntryHeadline entry={entry} />
                  <EntryDetails entry={entry} />
                  <EntryTargets entry={entry} />
                </div>
              </td>
              <td className={CELL}><EntryActor entry={entry} /></td>
              <td className={CELL}><EntryBadges entry={entry} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// What a filter leaves out, said where the admin sees the result.
function NarrowingHints({ filter }: { filter: AccessHistoryFilter }) {
  return (
    <>
      {filter.subjectUserId ? (
        <p className={`text-sm ${MUTED}`}>
          The earlier action log names records, not people, so a subject search leaves it out. Search by
          record id to include it.
        </p>
      ) : null}
      {filter.category || filter.outcome ? (
        <p className={`text-sm ${MUTED}`}>
          Only access records carry a category and an outcome, so data changes and the earlier action log
          are left out.
        </p>
      ) : null}
    </>
  );
}

function SearchPanel({ query, admins, nowIso }: {
  query: AccessHistoryQuery;
  admins: readonly SecurityAdminOption[];
  nowIso: string;
}) {
  return (
    <DashboardPanel as="div" className="flex flex-col gap-4 p-5">
      {/* Moving to another search keeps this page mounted, and the form's
          fields are uncontrolled, so each search mounts its own form: it then
          shows that search's filters, never the previous one's. Paging changes
          only the cursor and keeps the form. */}
      <AccessHistoryFilters
        admins={admins}
        categories={AUDIT_CATEGORIES}
        clearHref={securityClearHref(query.filter)}
        key={JSON.stringify(query.values)}
        outcomes={AUDIT_OUTCOMES}
        problems={query.problems}
        problemsId={PROBLEMS_ID}
        ranges={rangeOptions(nowIso)}
        values={query.values}
      />
      {query.problems.length > 0 ? (
        <div id={PROBLEMS_ID}>
          <InlineFeedback tone="danger">
            <ul className="list-disc pl-5">
              {query.problems.map((problem) => (
                <li key={problem}>{ACCESS_HISTORY_PROBLEMS[problem]}</li>
              ))}
            </ul>
          </InlineFeedback>
        </div>
      ) : null}
    </DashboardPanel>
  );
}

function EntriesPanel({ query, entries, nextBefore }: {
  query: AccessHistoryQuery;
  entries: AccessHistoryEntry[];
  nextBefore?: string;
}) {
  return (
    <DashboardPanel as="section" className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-[var(--jale-ink)]">Entries</h2>
        <span className={`text-sm ${MUTED}`}>{`${entries.length} shown`}</span>
      </div>
      <NarrowingHints filter={query.filter} />
      {entries.length > 0 ? (
        <EntriesTable entries={entries} />
      ) : (
        <p className={`text-sm ${MUTED}`}>No entries match this search.</p>
      )}
      {query.before || nextBefore ? (
        <nav aria-label="Pages" className="flex flex-wrap gap-2.5">
          {query.before ? (
            <Link className={secondaryLinkClass} href={accessHistoryHref(query.filter)} prefetch={false}>
              Newest entries
            </Link>
          ) : null}
          {nextBefore ? (
            <Link className={secondaryLinkClass} href={accessHistoryHref(query.filter, nextBefore)} prefetch={false}>
              Older entries
            </Link>
          ) : null}
        </nav>
      ) : null}
    </DashboardPanel>
  );
}

export type AccessHistoryViewProps = {
  result: AccessHistoryResult;
  /** The Admin filter's options (from loadAdmins). */
  admins: readonly SecurityAdminOption[];
  /** The server render's time: the Range presets count back from it. */
  nowIso: string;
};

export function AccessHistoryView({ result, admins, nowIso }: AccessHistoryViewProps) {
  if (result.status === 'forbidden') {
    return <SuperadminOnly body="Only superadmins can open Security." title="Security is for superadmins" />;
  }

  if (result.status === 'preview') {
    return (
      <div className="flex flex-col gap-6">
        <SecurityHeader />
        <DashboardPanel className="p-5">
          <p className={`text-sm ${MUTED}`}>
            The local preview has no signed-in admin, so it cannot search the access history. Sign in as a
            superadmin to use it.
          </p>
        </DashboardPanel>
      </div>
    );
  }

  const { query } = result;
  return (
    <div className="flex flex-col gap-6">
      <SecurityHeader />
      <SecurityTabs filter={query.filter} />
      <SearchPanel admins={admins} nowIso={nowIso} query={query} />
      {result.status === 'ok' ? (
        <EntriesPanel entries={result.entries} nextBefore={result.nextBefore} query={query} />
      ) : null}
    </div>
  );
}
