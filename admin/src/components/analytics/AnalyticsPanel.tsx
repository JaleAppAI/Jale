import type { ReactNode } from 'react';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { ItemTag } from './charts/ItemTag';

/**
 * An analytics panel that is not a chart (tables, lists, figures): the same
 * header as ChartFrame (title, list tag), its content, then the one-line
 * "how it's counted".
 */
export function AnalyticsPanel({
  title,
  tag,
  subtitle,
  howCounted,
  notes,
  tools,
  children,
}: {
  title: string;
  tag?: string;
  subtitle?: ReactNode;
  howCounted?: string;
  notes?: string[]; // facts the one-liner cannot hold, under "More about these numbers"
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DashboardPanel as="section" className="flex min-w-0 flex-col">
      <PanelHeader title={title} subtitle={subtitle} action={tag ? <ItemTag tag={tag} /> : undefined} />
      <div className="flex min-w-0 flex-col gap-3 p-5">
        {tools ? <div className="flex min-w-0 flex-wrap items-center gap-2">{tools}</div> : null}
        {children}
        {howCounted ? (
          <p data-how-counted="" className="text-xs text-[var(--jale-ink-2)]">
            {howCounted}
          </p>
        ) : null}
        {notes && notes.length > 0 ? (
          <details data-panel-notes="" className="text-xs text-[var(--jale-ink-2)]">
            <summary className="cursor-pointer font-semibold text-[var(--jale-ink)]">More about these numbers</summary>
            <div className="mt-2 flex flex-col gap-2">
              {notes.map((note) => (
                <p key={note} className="m-0" data-panel-note="">
                  {note}
                </p>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </DashboardPanel>
  );
}

// The big figure at the top of a panel: "1,240 +144 this week so far".
export function Headline({ value, note }: { value: string; note?: string }) {
  return (
    <p data-headline="" className="m-0 text-2xl font-extrabold">
      {value}
      {note ? <span className="ml-2 text-sm font-semibold text-[var(--jale-ink-2)]">{note}</span> : null}
    </p>
  );
}
