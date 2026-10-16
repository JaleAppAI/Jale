// The D11 chart contract (00-FE-INTERFACES §5). Server components only.
export type ChartColor = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5' | 'chart-6';
export type ChartSeries = { key: string; label: string; color: ChartColor; values: (number | null)[] };
export type ChartTable = { caption: string; columns: string[]; rows: (string | number)[][] };
export type LegendItem = { label: string; color: ChartColor; hollow?: boolean };
