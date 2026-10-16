import type { ReactNode } from 'react';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { TableScroll } from '@/components/ui/table-scroll';
import { ChartLegend } from './ChartLegend';
import { ItemTag } from './ItemTag';
import type { ChartTable, LegendItem } from './types';

export type ChartFrameProps = {
  title: string;
  tag?: string; // tag like "#1"
  subtitle?: ReactNode;
  howCounted?: string; // one-line "how it's counted"
  legend?: LegendItem[];
  caption?: ReactNode;
  tools?: ReactNode; // pickers/toggles
  table: ChartTable; // the <details> table twin (keyboard reachable)
  children: ReactNode; // the chart SVG
};

/**
 * One analytics panel around a chart: title and list tag, the chart, its
 * caption and "how it's counted" line, and the table twin: a native
 * <details> whose summary is keyboard reachable and whose table scrolls in its
 * own region. Each chart brings its own series legend; `legend` is for a key
 * shared by more than one chart in the panel.
 */
export function ChartFrame({ title, tag, subtitle, howCounted, legend, caption, tools, table, children }: ChartFrameProps) {
  return (
    <DashboardPanel as="section" className="flex min-w-0 flex-col">
      <PanelHeader title={title} subtitle={subtitle} action={tag ? <ItemTag tag={tag} /> : undefined} />
      <div className="flex min-w-0 flex-col gap-3 p-5">
        {tools ? <div className="flex min-w-0 flex-wrap items-center gap-2">{tools}</div> : null}
        {children}
        {legend && legend.length > 0 ? <ChartLegend items={legend} /> : null}
        {caption ? <div className="text-sm">{caption}</div> : null}
        {howCounted ? (
          <p data-how-counted="" className="m-0 text-xs text-[var(--jale-ink-2)]">
            {howCounted}
          </p>
        ) : null}
        <details className="min-w-0">
          <summary className="cursor-pointer text-sm font-semibold">Table</summary>
          <TableScroll label={`${title} table`}>
            <table className="w-full border-collapse text-sm">
              <caption className="py-1 text-left text-xs text-[var(--jale-ink-2)]">{table.caption}</caption>
              <thead>
                <tr>
                  {table.columns.map((column, i) => (
                    <th key={column} scope="col" className={i === 0 ? 'px-3 py-2 text-left' : 'px-3 py-2 text-right'}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, table.columns.length)} className="px-3 py-2">
                      No data yet
                    </td>
                  </tr>
                ) : (
                  table.rows.map((row, r) => (
                    <tr key={`${row[0]}-${r}`}>
                      {row.map((cell, i) => (
                        <td key={`${r}-${i}`} className={i === 0 ? 'px-3 py-2 text-left' : 'px-3 py-2 text-right tabular-nums'}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableScroll>
        </details>
      </div>
    </DashboardPanel>
  );
}
