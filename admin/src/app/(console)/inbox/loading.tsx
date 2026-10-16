import { ListPageSkeleton } from '@/components/ui/page-skeletons';

export default function InboxLoading() {
  return <ListPageSkeleton rows={8} withSearch />;
}
