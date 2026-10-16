import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { InboxQuery } from '@/lib/server/admin-inbox';
import { ReportFilterFields } from './ReportFilterFields';
import { INBOX_STATUS_OPTIONS, inboxListHref, reportFiltersSet } from './inbox-view';
import { LABEL, TEXT_LINK } from './styles';

// A plain GET form: the filters live in the URL, so a filtered view can be
// shared and the form needs no client code. On the Reports tab the report
// filters (K2.3 report slot) join the same form, so one Apply sends them all.
export function InboxFilters({ query }: { query: Pick<InboxQuery, 'tab' | 'status' | 'q' | 'report'> }) {
  const onReports = query.tab === 'reports';
  const narrowed = query.status !== 'waiting' || (query.q ?? '').trim() !== '' || (onReports && reportFiltersSet(query.report));
  return (
    <form action="/inbox" aria-label="Filter the Inbox" className="flex flex-wrap items-end gap-3" method="get" role="search">
      {query.tab === 'all' ? null : <input name="tab" type="hidden" value={query.tab} />}
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1.5">
        <label className="sr-only" htmlFor="inbox-search">Search by reference</label>
        <Input
          autoComplete="off"
          defaultValue={query.q ?? ''}
          id="inbox-search"
          maxLength={40}
          name="q"
          placeholder="Search by reference, e.g. S-124"
          spellCheck={false}
          type="search"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className={LABEL} htmlFor="inbox-status">Status</label>
        <Select defaultValue={query.status} id="inbox-status" name="status">
          {INBOX_STATUS_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </Select>
      </div>
      {onReports ? <ReportFilterFields report={query.report} /> : null}
      <Button type="submit" variant="secondary">Apply filters</Button>
      {narrowed ? (
        <Link className={`inline-flex min-h-11 items-center px-2 text-sm ${TEXT_LINK}`} href={inboxListHref({ tab: query.tab, status: 'waiting' })} prefetch={false}>Clear</Link>
      ) : null}
    </form>
  );
}
