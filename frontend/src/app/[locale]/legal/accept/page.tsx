'use client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import LegalWall from '@/components/legal/LegalWall';

/**
 * The legal wall route.
 *
 * `LegalWall` is frozen (auth-critical): it owns the `/legal/tos` fetch, the
 * accept POST, the `legalReturnUrl` handoff and the redirect that lets the rest
 * of the app load. Everything this page can legitimately decide is therefore
 * the auth gate and the landmark — the component draws its own `<main>` and its
 * own centering frame.
 *
 * Consequently the state surfaces this page would otherwise own live inside the
 * frozen component and are NOT migrated here:
 *   - S1  its fetch-phase copy is a plain "Loading…" line, not the
 *         `CenteredCardSkeleton` that `loading.tsx` renders for the route.
 *   - S5  its fetch failure is a hand-rolled message + retry, not `ErrorState`
 *         by kind (it also swallows the kind: `catch { setFetchError(true) }`).
 *   - S7  its accept failure is a bare `<p class="text-error">`, not
 *         `InlineFeedback tone="danger"`.
 * Moving those onto `usePageData` / the foundation primitives requires editing
 * `components/legal/LegalWall.tsx`; see the contract-change request filed with
 * this change.
 *
 * `useRequireAuth()` is the same gate `usePageData` arms internally
 * (`useRequireAuth({ enabled: requireAuth })`), so the auth contract already
 * matches the hook's.
 */
export default function LegalAcceptPage() {
    useRequireAuth();

    // No wrapper element: `LegalWall` renders the `<main>` landmark itself, and
    // nesting a second one produced two `main`s in the document.
    return <LegalWall />;
}
