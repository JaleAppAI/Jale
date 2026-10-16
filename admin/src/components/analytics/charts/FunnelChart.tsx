import { formatCount, funnelLabel, wholePercent } from '@/lib/analytics-format';
import { HBarFigure } from './HBarFigure';
import type { ChartColor } from './types';

export type FunnelStageInput = { key: string; label: string; count: number };

export type FunnelChartProps = {
  title: string;
  stages: FunnelStageInput[]; // in funnel order
  base?: number; // the 100% count; default: the first stage's count
  xTitle: string;
  yTitle: string; // required (D11)
  color?: ChartColor; // one colour for every stage (ordered categories); default chart-1
  formatValue?: (v: number) => string; // the count; default formatCount
};

const FUNNEL_TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * D11 funnel: one bar per stage, its length the share of the base, labelled
 * "NN% · count". A share never rounds a fact away ("<1%", ">99%"); with no
 * base it reads "— · 0", never NaN%.
 */
export function FunnelChart({ title, stages, base, xTitle, yTitle, color = 'chart-1', formatValue = formatCount }: FunnelChartProps) {
  const whole = base ?? stages[0]?.count ?? 0;
  const text = (count: number) => (formatValue === formatCount ? funnelLabel(count, whole) : `${wholePercent(count, whole)} · ${formatValue(count)}`);
  const summary =
    stages.length === 0 ? `${title}: no data` : `${title}: ${stages.map((stage) => `${stage.label} ${text(stage.count)}`).join('; ')}`;
  return (
    <div data-chart="funnel">
      <HBarFigure
        title={title}
        summary={summary}
        rows={stages.map((stage) => ({
          label: stage.label,
          bars: [{ key: stage.key, color, part: whole > 0 ? stage.count / whole : 0, text: text(stage.count) }],
        }))}
        ticks={FUNNEL_TICKS.map((fraction) => ({ fraction, text: `${fraction * 100}%` }))}
        xTitle={xTitle}
        yTitle={yTitle}
        legend={[]}
      />
    </div>
  );
}
