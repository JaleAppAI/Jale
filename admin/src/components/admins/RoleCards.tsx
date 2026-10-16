import type { AdminRole } from '@/lib/server/admin-users';
import { ROLE_OPTIONS } from './admin-actions';

/** The three roles as cards: one radio group, the whole card is the hit target. */
export function RoleCards({ name, value, disabled = false, onChange }: {
  name: string;
  value: AdminRole;
  disabled?: boolean;
  onChange: (role: AdminRole) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold text-[var(--jale-ink)]">Role</legend>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
        {ROLE_OPTIONS.map((option) => {
          const checked = option.role === value;
          return (
            <label
              className={[
                'flex cursor-pointer gap-2.5 rounded-xl border-2 bg-[var(--jale-paper)] p-3.5',
                'has-[:focus-visible]:shadow-[var(--shadow-focus)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
                checked ? 'border-[var(--jale-blue-500)]' : 'border-[var(--jale-divider)]',
              ].join(' ')}
              key={option.role}
            >
              <input
                checked={checked}
                className="mt-0.5 size-4 shrink-0 accent-[var(--jale-blue-500)]"
                name={name}
                onChange={() => onChange(option.role)}
                type="radio"
                value={option.role}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-bold text-[var(--jale-ink)]">{option.title}</span>
                <span className="text-xs text-[var(--jale-ink-2)]">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
