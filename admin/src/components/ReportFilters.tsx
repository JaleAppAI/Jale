import Link from 'next/link';
import {
  EMPLOYER_REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  REPORT_ROLES,
  REPORT_ROLE_LABELS,
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  WORKER_REPORT_CATEGORIES,
} from '@/lib/report-policy';
import type { ReportInboxFilters } from '@/lib/server/admin-reports';

// The inbox filters: a plain GET form that puts its values in the URL, so a
// filtered view can be shared and needs no client code.

// 'other' belongs to both lists; it is offered once.
const WORKER_ONLY = WORKER_REPORT_CATEGORIES.filter((category) => category !== 'other');
const EMPLOYER_ONLY = EMPLOYER_REPORT_CATEGORIES.filter((category) => category !== 'other');

export function ReportFilters({ filters }: { filters: ReportInboxFilters }) {
  return (
    <form action="/reports" aria-label="Filter reports" className="card report-filters" method="get" role="search">
      <div className="field">
        <label htmlFor="filter-status">Status</label>
        <select defaultValue={filters.status ?? ''} id="filter-status" name="status">
          <option value="">All</option>
          {REPORT_STATUSES.map((status) => (
            <option key={status} value={status}>{REPORT_STATUS_LABELS[status]}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="filter-role">Role</label>
        <select defaultValue={filters.role ?? ''} id="filter-role" name="role">
          <option value="">All</option>
          {REPORT_ROLES.map((role) => (
            <option key={role} value={role}>{REPORT_ROLE_LABELS[role]}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="filter-category">Category</label>
        <select defaultValue={filters.category ?? ''} id="filter-category" name="category">
          <option value="">All</option>
          <optgroup label="Worker">
            {WORKER_ONLY.map((category) => (
              <option key={category} value={category}>{REPORT_CATEGORY_LABELS[category]}</option>
            ))}
          </optgroup>
          <optgroup label="Employer">
            {EMPLOYER_ONLY.map((category) => (
              <option key={category} value={category}>{REPORT_CATEGORY_LABELS[category]}</option>
            ))}
          </optgroup>
          <option value="other">{REPORT_CATEGORY_LABELS.other}</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="filter-verified">Verified</label>
        <select defaultValue={filters.verified === null ? '' : filters.verified ? 'yes' : 'no'} id="filter-verified" name="verified">
          <option value="">All</option>
          <option value="yes">Verified</option>
          <option value="no">Unverified</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="filter-number">Find a number</label>
        <input
          aria-describedby={filters.numberInvalid ? 'filter-number-error' : undefined}
          aria-invalid={filters.numberInvalid || undefined}
          autoComplete="off"
          defaultValue={filters.numberInput}
          id="filter-number"
          inputMode="text"
          name="number"
          placeholder="JR-1042…"
          spellCheck={false}
          type="search"
        />
        {filters.numberInvalid ? (
          <p className="form-error" id="filter-number-error">Enter a report number such as JR-1042 or 1042.</p>
        ) : null}
      </div>

      <div className="report-filter-actions">
        <button className="button" type="submit">Apply filters</button>
        <Link className="button secondary" href="/reports" prefetch={false}>Clear</Link>
      </div>
    </form>
  );
}
