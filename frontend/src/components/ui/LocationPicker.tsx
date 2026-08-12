'use client';

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { queryLocations, type LocationSuggestion, type LocationSource } from '@/lib/location-search';

export interface LocationPickerValue {
  label: string;
  cityKey: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  source: LocationSource | null;
}

export const EMPTY_LOCATION_VALUE: Omit<LocationPickerValue, 'label'> = {
  cityKey: null,
  city: null,
  state: null,
  zip: null,
  latitude: null,
  longitude: null,
  source: null,
};

export function LocationPicker({
  value,
  onChange,
  placeholder,
  required,
}: {
  value: string;
  onChange: (value: LocationPickerValue) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const tCommon = useTranslations('common');
  const [results, setResults] = useState<LocationSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searched, setSearched] = useState(false);
  const skipNextSearch = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = React.useId();

  // Debounced search on the current text value.
  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const q = value.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      setSearched(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      queryLocations(q)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setActive(-1);
          setSearched(true);
          // Only pop the dropdown open if the user is actually in the field —
          // a form that mounts with a prefilled value must stay quiet. The
          // Input isn't forwardRef, so test focus through the container.
          if (containerRef.current?.contains(document.activeElement)) {
            setOpen(true);
          }
        })
        .catch((err) => {
          // Dataset failed to load — degrade to a plain text input.
          console.error(err);
          if (cancelled) return;
          setResults([]);
          setOpen(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function select(s: LocationSuggestion) {
    skipNextSearch.current = true; // don't re-open the dropdown from the value change
    onChange({
      label: s.label,
      cityKey: s.cityKey,
      city: s.city,
      state: s.state,
      zip: s.zip,
      latitude: s.latitude,
      longitude: s.longitude,
      source: s.source,
    });
    setOpen(false);
    setResults([]);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    // Escape dismisses the dropdown even when it only holds the "no matches" row.
    if (e.key === 'Escape') {
      e.stopPropagation(); // don't let an enclosing modal close-on-Escape fire too
      setOpen(false);
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // From "nothing active" (-1) wrap to the last item, not the second-to-last.
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      select(results[active]);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={value}
        placeholder={placeholder}
        required={required}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listboxId}-opt-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => onChange({ label: e.target.value, ...EMPTY_LOCATION_VALUE })}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          // Keep focus in the input when the scrollbar or padding is clicked,
          // so onBlur doesn't close the dropdown mid-scroll.
          onMouseDown={(e) => e.preventDefault()}
          className={[
            'absolute z-10 mt-1 max-h-64 w-full overflow-y-auto',
            'rounded-[var(--radius-input)] border border-[var(--jale-divider)]',
            'bg-[var(--jale-card)] py-1 shadow-[var(--shadow-modal)]',
          ].join(' ')}
        >
          {results.length === 0 && searched ? (
            <li
              role="option"
              aria-disabled={true}
              aria-selected={false}
              className="px-3.5 py-2 text-sm text-[var(--jale-placeholder)]"
            >
              {tCommon('location_no_matches')}
            </li>
          ) : (
            results.map((s, i) => (
              <li
                key={`${s.zip}-${i}`}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={[
                  'cursor-pointer px-3.5 py-2 text-sm',
                  i === active
                    ? 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                    : 'text-[var(--jale-ink)]',
                ].join(' ')}
              >
                {s.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
