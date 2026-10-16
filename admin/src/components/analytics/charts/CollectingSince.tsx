import { ANALYTICS_RELEASE_LABEL } from '@/lib/analytics-format';
import { estimateTextWidth, figureLayout, formatTick } from '@/lib/chart-geometry';
import { ChartScroll, Figure, XAxisTitle, XTicks, YAxisTitle, YTicks } from './axes';
import { CHART_AXIS, CHART_LABEL } from './tokens';

export type CollectingSinceProps = {
  title: string; // for the role="img" label
  xTitle: string;
  yTitle: string; // required (D11)
  unit?: string; // the zero tick reads "0" + unit
  slots: number; // x ticks run "Week 1" … "Week {slots}"
  releaseLabel?: string; // default ANALYTICS_RELEASE_LABEL
  note?: string; // a second line under the message
  width?: number;
  height?: number;
};

/**
 * A tracked-from-now item with no rows yet (K3.0 collectingSince = null):
 * empty, labelled axes and "No data yet · collecting since <release>". It
 * draws no point and no value, so nothing reads as a zero.
 */
export function CollectingSince({
  title,
  xTitle,
  yTitle,
  unit = '',
  slots,
  releaseLabel = ANALYTICS_RELEASE_LABEL,
  note,
  width = 240,
  height = 150,
}: CollectingSinceProps) {
  const message = `No data yet · collecting since ${releaseLabel}`;
  const zero = formatTick(0, unit);
  const layout = figureLayout({ plotWidth: width, plotHeight: height, topSpace: 8, yTickLabels: [zero], yTitle, xTitle });
  const last = `Week ${Math.max(1, slots)}`;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-chart="collecting-since">
      <ChartScroll title={title}>
        <Figure label={`Empty chart: ${title}. ${message}.`} layout={layout}>
          <YAxisTitle text={yTitle} />
          <YTicks ticks={[{ y: layout.plotHeight, text: zero }]} />
          <div
            className="relative flex items-center justify-center px-4 text-center text-sm"
            style={{ gridColumn: '3', gridRow: '2', borderLeft: `1px solid ${CHART_AXIS}`, borderBottom: `1px solid ${CHART_AXIS}`, color: CHART_LABEL }}
          >
            <span>
              <strong data-collecting-since="">{message}</strong>
              {note ? (
                <>
                  <br />
                  {note}
                </>
              ) : null}
            </span>
          </div>
          <XTicks
            plotWidth={layout.plotWidth}
            ticks={[
              { fraction: 0, text: 'Week 1' },
              ...(slots > 1 && estimateTextWidth(last) < layout.plotWidth ? [{ fraction: 1, text: last }] : []),
            ]}
          />
          <XAxisTitle text={xTitle} />
        </Figure>
      </ChartScroll>
    </div>
  );
}
