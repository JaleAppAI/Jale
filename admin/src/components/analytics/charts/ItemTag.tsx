// The analytics-list number of a panel ("#13"), as the prototype shows it.
export function ItemTag({ tag }: { tag: string }) {
  return (
    <span data-item-tag="" className="shrink-0 text-xs font-bold text-[var(--jale-ink-2)]">
      {tag}
    </span>
  );
}
