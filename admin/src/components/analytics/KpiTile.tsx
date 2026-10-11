import { formatCount } from '@/lib/analytics-format';

export type KpiTileProps = {
  label: string;
  /** A count (shown with thousands separators) or preformatted text such as "5.2 h". */
  value: number | string;
  note: string;
  tone?: 'positive' | 'muted';
};

export function KpiTile({ label, value, note, tone = 'muted' }: KpiTileProps) {
  return (
    <article className="card">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{typeof value === 'number' ? formatCount(value) : value}</strong>
      <span className={tone === 'positive' ? 'kpi-note positive' : 'kpi-note'}>{note}</span>
    </article>
  );
}
