import { formatCount } from '@/lib/analytics-format';

export type KpiTileProps = {
  label: string;
  value: number;
  note: string;
  tone?: 'positive' | 'muted';
};

export function KpiTile({ label, value, note, tone = 'muted' }: KpiTileProps) {
  return (
    <article className="card">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{formatCount(value)}</strong>
      <span className={tone === 'positive' ? 'kpi-note positive' : 'kpi-note'}>{note}</span>
    </article>
  );
}
