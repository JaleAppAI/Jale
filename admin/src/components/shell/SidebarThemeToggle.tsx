'use client';

import { Moon, Sun } from 'lucide-react';
import { useThemeToggle } from '@/components/ui/theme-toggle';
import { RAIL_PILL } from './rail-styles';

/** The theme switch on the navy footer (prototype): its text names the theme it switches to. */
export function SidebarThemeToggle() {
  const { isDark, toggle } = useThemeToggle();
  return (
    <button type="button" onClick={toggle} className={RAIL_PILL}>
      {isDark ? <Sun aria-hidden size={14} /> : <Moon aria-hidden size={14} />}
      {isDark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
