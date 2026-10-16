import { formatCount } from '@/lib/analytics-format';
import type { StalledStep } from '@/lib/types';
import { BarChart } from './charts/BarChart';
import { ChartFrame } from './charts/ChartFrame';

// Kept: "Stuck now", now a D11 bar chart (was hand-made bars).
export function StalledList({ steps, days }: { steps: StalledStep[]; days: number }) {
  const series = [{ key: 'workers', label: 'Workers', color: 'chart-1' as const, values: steps.map((step) => step.workers) }];
  return (
    <ChartFrame
      title="Stuck now"
      subtitle={`Active workers with no progress for ${days}+ days, by step and the door their run started in`}
      table={{ caption: 'Stuck workers by step', columns: ['Step', 'Workers'], rows: steps.map((step) => [step.label, formatCount(step.workers)]) }}
    >
      {steps.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No one is stuck right now.</p>
      ) : (
        <BarChart
          title="Stuck now"
          orientation="horizontal"
          labels={steps.map((step) => step.label)}
          series={series}
          xTitle="Workers with no progress"
          yTitle="Onboarding step"
        />
      )}
    </ChartFrame>
  );
}
