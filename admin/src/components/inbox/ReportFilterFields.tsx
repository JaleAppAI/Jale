import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { InboxQuery } from '@/lib/server/admin-inbox';
import {
  EMPLOYER_REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  REPORT_ROLES,
  REPORT_ROLE_LABELS,
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  WORKER_REPORT_CATEGORIES,
} from '@/lib/report-policy';
import { DANGER_TEXT, LABEL } from './styles';

export type ReportFilterValues = NonNullable<InboxQuery['report']>;

// 'other' belongs to both lists; it is offered once.
const WORKER_ONLY = WORKER_REPORT_CATEGORIES.filter((category) => category !== 'other');
const EMPLOYER_ONLY = EMPLOYER_REPORT_CATEGORIES.filter((category) => category !== 'other');
const FIELD = 'flex min-w-0 flex-col gap-1.5';

/**
 * The report filters K2.3 passes through on the Reports tab: reportStatus
 * (its own key; `status` is the Inbox status), role, category, verified and
 * number. Fields only: they sit inside InboxFilters' one GET form.
 */
export function ReportFilterFields({ report }: { report: ReportFilterValues | undefined }) {
  const numberInvalid = report?.numberInvalid === true;
  return (
    <>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="report-filter-status">Report status</label>
        <Select defaultValue={report?.reportStatus ?? ''} id="report-filter-status" name="reportStatus">
          <option value="">Follow Status</option>
          {REPORT_STATUSES.map((value) => <option key={value} value={value}>{REPORT_STATUS_LABELS[value]}</option>)}
        </Select>
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="report-filter-role">Role</label>
        <Select defaultValue={report?.role ?? ''} id="report-filter-role" name="role">
          <option value="">All</option>
          {REPORT_ROLES.map((value) => <option key={value} value={value}>{REPORT_ROLE_LABELS[value]}</option>)}
        </Select>
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="report-filter-category">Category</label>
        <Select defaultValue={report?.category ?? ''} id="report-filter-category" name="category">
          <option value="">All</option>
          <optgroup label="Worker">{WORKER_ONLY.map((value) => <option key={value} value={value}>{REPORT_CATEGORY_LABELS[value]}</option>)}</optgroup>
          <optgroup label="Employer">{EMPLOYER_ONLY.map((value) => <option key={value} value={value}>{REPORT_CATEGORY_LABELS[value]}</option>)}</optgroup>
          <option value="other">{REPORT_CATEGORY_LABELS.other}</option>
        </Select>
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="report-filter-verified">Verified</label>
        <Select defaultValue={!report || report.verified === null ? '' : report.verified ? 'yes' : 'no'} id="report-filter-verified" name="verified">
          <option value="">All</option>
          <option value="yes">Verified</option>
          <option value="no">Unverified</option>
        </Select>
      </div>
      <div className={FIELD}>
        <label className={LABEL} htmlFor="report-filter-number">Find a number</label>
        <Input
          aria-describedby={numberInvalid ? 'report-filter-number-error' : undefined}
          aria-invalid={numberInvalid || undefined}
          autoComplete="off"
          defaultValue={report?.numberInput ?? ''}
          id="report-filter-number"
          name="number"
          placeholder="JR-1042…"
          spellCheck={false}
          type="search"
        />
        {numberInvalid ? <p className={DANGER_TEXT} id="report-filter-number-error">Enter a report number such as JR-1042 or 1042.</p> : null}
      </div>
    </>
  );
}
