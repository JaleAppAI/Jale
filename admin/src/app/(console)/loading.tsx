import { ListPageSkeleton, MetricRowSkeleton } from '@/components/ui/page-skeletons';

/** While a console page loads: a metric row and a list, inside the shell. */
export default function ConsoleLoading() {
  return (
    <div className="flex w-full max-w-[1180px] flex-col gap-7">
      <MetricRowSkeleton count={4} gap="gap-4" />
      <ListPageSkeleton rows={5} />
    </div>
  );
}
