'use client';

import { useRequireAuth } from '@/hooks/useRequireAuth';
import { HelpCenter } from '@/components/tutorials/HelpCenter';

export const dynamic = 'force-dynamic';

/** `/worker/help`: the worker's Help center (see `HelpCenter`). */
export default function WorkerHelpPage() {
    useRequireAuth();
    return <HelpCenter role="worker" />;
}
