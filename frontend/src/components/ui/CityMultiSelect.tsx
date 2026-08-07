'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LocationPicker, type LocationPickerValue } from '@/components/ui/LocationPicker';
import type { PreferredCity } from '@/lib/api/worker';

const MAX_CITIES = 10;

type PendingFocus = { type: 'chip'; key: string } | { type: 'picker' } | null;

/**
 * Chips + typeahead multi-select for preferred cities. Only ever emits picked
 * suggestions — free-typed text is never added to the list.
 *
 * Note: in-progress typed text is intentionally local state that survives
 * `value` prop changes, so a parent re-render mid-typing doesn't clobber what
 * the user is typing. Consumers that need to hard-reset the field (e.g. a
 * profile-edit Cancel flow restoring the saved `value`) should force a
 * remount via a changed `key` prop rather than expecting a `value` change
 * alone to clear any not-yet-picked text.
 */
export function CityMultiSelect({
  value,
  onChange,
}: {
  value: PreferredCity[];
  onChange: (next: PreferredCity[]) => void;
}) {
  const tCommon = useTranslations('common');
  const [text, setText] = useState('');
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const containerRef = useRef<HTMLDivElement>(null);
  const atMax = value.length >= MAX_CITIES;

  // Runs after `value` (and thus the chip list / picker visibility) has
  // re-rendered, so the target node we want to focus actually exists.
  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus.type === 'picker') {
      containerRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    } else {
      buttonRefs.current.get(pendingFocus.key)?.focus();
    }
    setPendingFocus(null);
  }, [value, pendingFocus]);

  function setButtonRef(key: string) {
    return (el: HTMLButtonElement | null) => {
      if (el) buttonRefs.current.set(key, el);
      else buttonRefs.current.delete(key);
    };
  }

  function handlePick(v: LocationPickerValue) {
    if (v.cityKey === null || v.city === null || v.state === null) {
      // Free typing — just track the text.
      setText(v.label);
      return;
    }
    if (!atMax && !value.some((c) => c.city_key === v.cityKey)) {
      const next = [...value, {
        city_key: v.cityKey,
        city: v.city,
        state: v.state,
        latitude: v.latitude,
        longitude: v.longitude,
      }];
      onChange(next);
      if (next.length >= MAX_CITIES) {
        // Hitting the cap unmounts the picker input — keep focus on the
        // chip we just added instead of letting it fall through to <body>.
        setPendingFocus({ type: 'chip', key: v.cityKey });
      }
    }
    setText('');
  }

  function remove(cityKey: string) {
    const idx = value.findIndex((c) => c.city_key === cityKey);
    const next = value.filter((c) => c.city_key !== cityKey);
    // Prefer the chip that slides into the removed one's slot, then the
    // previous chip, then (list now empty) the picker input — which is
    // guaranteed to be mounted once we're below the cap.
    const fallbackKey = next[idx]?.city_key ?? next[idx - 1]?.city_key;
    setPendingFocus(fallbackKey ? { type: 'chip', key: fallbackKey } : { type: 'picker' });
    onChange(next);
  }

  return (
    <div ref={containerRef} className="space-y-2">
      {value.length > 0 && (
        <ul role="list" className="flex flex-wrap gap-2">
          {value.map((c) => (
            <li key={c.city_key}>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--jale-divider)] bg-white px-3 py-1 text-xs font-semibold text-[var(--jale-ink)]">
                {c.city}, {c.state}
                <button
                  ref={setButtonRef(c.city_key)}
                  type="button"
                  aria-label={tCommon('city_multi_remove', { city: c.city, state: c.state })}
                  onClick={() => remove(c.city_key)}
                  className="cursor-pointer text-[var(--jale-ink-2)] hover:text-[var(--jale-ink)]"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!atMax && (
        <LocationPicker
          value={text}
          placeholder={tCommon('city_multi_placeholder')}
          onChange={handlePick}
        />
      )}
      {atMax && (
        <p className="text-xs text-[var(--jale-ink-2)]">{tCommon('city_multi_max', { max: MAX_CITIES })}</p>
      )}
    </div>
  );
}
