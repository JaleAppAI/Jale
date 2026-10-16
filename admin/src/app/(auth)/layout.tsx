import type { ReactNode } from 'react';

/** The sign-in frame: no shell and no session read. */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main id="main" className="min-h-screen bg-[var(--jale-shell)] text-[var(--jale-ink)]">
      {children}
    </main>
  );
}
