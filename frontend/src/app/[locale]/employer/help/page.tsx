'use client';

import { useRequireAuth } from '@/hooks/useRequireAuth';
import { HelpCenter } from '@/components/tutorials/HelpCenter';

export const dynamic = 'force-dynamic';

/** `/employer/help`: the employer's Help center (see `HelpCenter`). */
export default function EmployerHelpPage() {
    useRequireAuth();
    return <HelpCenter role="employer" />;
}
