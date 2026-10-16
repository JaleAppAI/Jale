import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { ItemTag } from './charts/ItemTag';

export type PipelineItem = { tag: string; label: string; value: string; hint: string };

// "Pipelines, right now" (#9, #11, #19): one row per pipeline, its live value
// and its list tag. Each item's tag literal is written on the page.
export function PipelinesStrip({ items }: { items: PipelineItem[] }) {
  return (
    <DashboardPanel as="section" className="flex min-w-0 flex-col">
      <PanelHeader title="Pipelines, right now" />
      <dl className="m-0 grid items-center gap-x-3.5 gap-y-3 p-5 text-sm" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}>
        {items.map((item) => (
          <div key={item.tag} className="contents">
            <dt className="min-w-0">
              {item.label}
              <span className="block text-xs text-[var(--jale-ink-2)]">{item.hint}</span>
            </dt>
            <dd data-pipeline-value="" className="m-0 text-right font-bold tabular-nums">
              {item.value}
            </dd>
            <dd className="m-0">
              <ItemTag tag={item.tag} />
            </dd>
          </div>
        ))}
      </dl>
    </DashboardPanel>
  );
}
