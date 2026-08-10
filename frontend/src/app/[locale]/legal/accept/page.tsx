'use client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import LegalWall from '@/components/legal/LegalWall';

/**
 * The legal wall route.
 *
 * `LegalWall` owns the whole screen: the `/legal/tos` fetch (on `usePageData`),
 * its skeleton / error / accept surfaces, the `legalReturnUrl` handoff and the
 * redirect that lets the rest of the app load. It renders its own `<main>` and
 * its own centering frame, so this page adds no wrapper — nesting a second
 * `<main>` put two landmarks in the document.
 *
 * `useRequireAuth()` here is deliberately redundant with the gate `usePageData`
 * arms inside the component (`useRequireAuth({ enabled: requireAuth })`). Both
 * resolve to the same idempotent `router.replace('/auth/<type>')`, and this one
 * keeps the route guarded at the ROUTE level — the screen that gates the whole
 * authenticated app should not depend on a child component to stay guarded.
 */
export default function LegalAcceptPage() {
    useRequireAuth();

    return <LegalWall />;
}
