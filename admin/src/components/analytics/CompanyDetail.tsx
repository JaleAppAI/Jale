import { Badge, type BadgeTone } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { KVList } from '@/components/ui/kv-list';
import { PanelHeader } from '@/components/ui/panel-header';
import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { formatDay, memberLabel, planStatusLabel } from '@/lib/employer-health';
import type { CompanyMember, CompanySummary } from '@/lib/types';
import { SeatMeter } from './SeatMeter';
import { TABLE, TD, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

const STATUS_TONE: Record<CompanyMember['status'], BadgeTone> = { active: 'success', suspended: 'warning', removed: 'neutral' };
const STATUS_LABEL: Record<CompanyMember['status'], string> = { active: 'Active', suspended: 'Suspended', removed: 'Removed' };
const ROLE_LABEL: Record<CompanyMember['role'], string> = { owner: 'Owner', foreman: 'Foreman' };

// The company's plan, seats and sign-up date. No contact details: the page
// names people by their contact or account name only.
export function CompanyFacts({ company }: { company: CompanySummary }) {
  return (
    <DashboardPanel as="section" className="flex min-w-0 flex-col">
      <PanelHeader title="Plan and seats" />
      <div className="p-5">
        <KVList
          items={[
            { label: 'Plan', value: company.planCode },
            { label: 'Plan status', value: planStatusLabel(company.planStatus) },
            { label: 'Seats', value: <SeatMeter seats={company} /> },
            { label: 'Active members', value: formatCount(company.membersActive) },
            { label: 'Active jobs', value: formatCount(company.activeJobs) },
            { label: 'Created', value: formatDay(company.createdAt) },
          ]}
        />
      </div>
    </DashboardPanel>
  );
}

// Every member the company has had, removed ones included: owner first, then
// active, suspended and removed. A billing-suspended foreman is tagged.
export function CompanyMembers({ members }: { members: CompanyMember[] }) {
  return (
    <DashboardPanel as="section" className="flex min-w-0 flex-col">
      <PanelHeader title="Members" subtitle={`${formatCount(members.length)} in all, removed members included`} />
      <div className="flex min-w-0 flex-col gap-3 p-5">
        {members.length === 0 ? (
          <p className="m-0 text-sm text-[var(--jale-ink-2)]">No members.</p>
        ) : (
          <TableScroll label="Company members table">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>Name</th>
                  <th className={TH}>Role</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Joined</th>
                  <th className={TH_NUM}>Active jobs</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td className={TD_WRAP}>{memberLabel(member.displayName)}</td>
                    <td className={TD}>{ROLE_LABEL[member.role]}</td>
                    <td className={TD}>
                      <span title={member.billingSuspended ? 'Suspended by billing' : undefined}>
                        <Badge tone={STATUS_TONE[member.status]}>
                          {member.billingSuspended ? `${STATUS_LABEL[member.status]} for billing` : STATUS_LABEL[member.status]}
                        </Badge>
                      </span>
                      {member.status !== 'active' && member.statusChangedAt !== null ? (
                        <>
                          {' '}
                          <span className="text-xs text-[var(--jale-ink-2)]">{formatDay(member.statusChangedAt)}</span>
                        </>
                      ) : null}
                    </td>
                    <td className={TD}>{formatDay(member.joinedAt)}</td>
                    <td className={TD_NUM}>{formatCount(member.activeJobs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </DashboardPanel>
  );
}
