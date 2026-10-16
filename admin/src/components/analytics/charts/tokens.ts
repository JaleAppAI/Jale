import type { ChartColor } from './types';

// Every chart colour is a token from globals.css (FE-1), so both themes work.
// Marks wear the series token; all chart text wears --chart-axis (ticks, axis
// titles) or --chart-label (values, legend); a hollow point fills with the card.
export const CHART_VAR: Record<ChartColor, string> = {
  'chart-1': 'var(--chart-1)',
  'chart-2': 'var(--chart-2)',
  'chart-3': 'var(--chart-3)',
  'chart-4': 'var(--chart-4)',
  'chart-5': 'var(--chart-5)',
  'chart-6': 'var(--chart-6)',
};
export const CHART_GRID = 'var(--chart-grid)';
export const CHART_AXIS = 'var(--chart-axis)';
export const CHART_LABEL = 'var(--chart-label)';
export const CHART_SURFACE = 'var(--jale-card)';

export const HOLLOW_POINT_NOTE = 'Hollow point = current week so far';
export const HOLLOW_BAR_NOTE = 'Hollow bar = current week so far';
