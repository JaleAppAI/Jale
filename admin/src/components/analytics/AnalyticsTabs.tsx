import Link from 'next/link';

const TABS = [
  { key: 'growth', label: 'Growth', href: '/analytics' },
  { key: 'funnels', label: 'Funnels', href: '/analytics/funnels' },
  { key: 'employers', label: 'Employers', href: '/analytics/employers' },
  { key: 'ops', label: 'Ops', href: '/analytics/ops' },
] as const;

export type AnalyticsTab = (typeof TABS)[number]['key'];

export function AnalyticsTabs({ active }: { active: AnalyticsTab }) {
  return (
    <nav className="range-picker analytics-tabs" aria-label="Analytics sections">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          className="button"
          href={tab.href}
          aria-current={tab.key === active ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
