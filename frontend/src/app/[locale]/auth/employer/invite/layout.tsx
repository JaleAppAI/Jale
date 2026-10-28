import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * The invite page carries a secret in its address (`?token=`). The page takes
 * it out of the address bar on arrival, and this keeps it out of the Referer
 * header of anything the page loads or links to before then: Next renders it
 * as `<meta name="referrer" content="no-referrer">`.
 *
 * A layout because the page is a client component, and only a server
 * component can export metadata (precedent: `auth/worker/layout.tsx`).
 */
export const metadata: Metadata = { referrer: 'no-referrer' };

export default function EmployerInviteLayout({ children }: { children: ReactNode }) {
    return <>{children}</>;
}
