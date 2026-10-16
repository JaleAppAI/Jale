'use client';

import { LogOut } from 'lucide-react';
import { useState } from 'react';
import type { AdminClientAuthConfig } from '@/lib/auth';
import { RAIL_PILL } from './rail-styles';
import { signOutAdmin } from './sign-out';

export function SignOutButton({ authConfig }: { authConfig: AdminClientAuthConfig }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => {
        setPending(true);
        void signOutAdmin(authConfig);
      }}
      className={RAIL_PILL}
    >
      <LogOut aria-hidden size={14} />
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
