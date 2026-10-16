import { NotFoundCard } from '@/components/shell/NotFoundCard';

/** notFound() from a console page: shown inside the shell's <main>. */
export default function ConsoleNotFound() {
  return (
    <div className="flex w-full max-w-[1180px] justify-center py-12">
      <NotFoundCard />
    </div>
  );
}
