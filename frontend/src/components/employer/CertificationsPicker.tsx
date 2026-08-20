'use client';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  searchCertifications, findCertificationByName, certificationLabel,
} from '@/lib/certifications';
import type { CertificationRequirement } from '@/lib/job-requirements';
import { Input } from '@/components/ui/input';

const MAX_RESULTS = 8;

/**
 * Diacritic- and case-folds, same recipe as `lib/certifications.ts`'s private
 * `fold` (not exported -- this is the one place outside that module that
 * needs it, for dedupe-on-add against the employer's already-picked list,
 * which is a `CertificationRequirement[]` this module knows nothing about).
 */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Searchable certification picker (job-flow redesign, FE-T6, step 2 of
 * PostJobModal / JobFormFields). Selected certifications render as removable
 * chips; typing searches the curated bilingual list (`lib/certifications.ts`)
 * with a suggestions dropdown, and any typed text that doesn't match an
 * already-added entry can be added as a custom certification.
 *
 * This component owns ONLY the name list (add/remove) -- per-certification
 * tier and proof-upload requirement are `RequirementsPicker`'s job in step 3
 * (`certificationRequirements`/`onCertificationTierChange`/
 * `onCertificationProofToggle`), which is why every entry this component
 * creates defaults to `{ tier: 'optional', proof_required: false }`: neutral
 * until the employer visits that step.
 *
 * Dedupe is diacritic- and case-insensitive (`fold`), matching
 * `findCertificationByName`'s own matching rule -- the backend rejects two
 * certification_requirements entries with the same name, so this is not
 * just a UX nicety, it is the frontend's half of that invariant. Removing a
 * certification is still exact-name (chips are keyed by the stored `name`,
 * which is unique by construction).
 */
interface CertificationsPickerProps {
  certificationRequirements: CertificationRequirement[];
  onChange: (next: CertificationRequirement[]) => void;
  disabled?: boolean;
}

export function CertificationsPicker({ certificationRequirements, onChange, disabled }: CertificationsPickerProps) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();
  const activeLocale: 'en' | 'es' = locale === 'es' ? 'es' : 'en';
  const listboxId = useId();

  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const trimmedQuery = text.trim();
  const results = useMemo(
    () => (trimmedQuery ? searchCertifications(trimmedQuery, activeLocale).slice(0, MAX_RESULTS) : []),
    [trimmedQuery, activeLocale],
  );

  const isAlreadyAdded = (name: string) =>
    certificationRequirements.some((cert) => fold(cert.name) === fold(name));

  // Suppress the custom-add row when the typed text is itself an exact
  // (fold-insensitive) match for one of the curated rows already on screen --
  // picking that row is the same result, without inventing a second entry
  // that reads identically.
  const showAddCustom =
    trimmedQuery !== '' && !isAlreadyAdded(trimmedQuery) &&
    !results.some((cert) => fold(certificationLabel(cert, activeLocale)) === fold(trimmedQuery));

  const optionCount = results.length + (showAddCustom ? 1 : 0);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function addCertification(name: string) {
    const trimmed = name.trim();
    if (!trimmed || isAlreadyAdded(trimmed)) return;
    onChange([...certificationRequirements, { name: trimmed, tier: 'optional', proof_required: false }]);
    setText('');
    setOpen(false);
    setActive(-1);
  }

  function remove(name: string) {
    onChange(certificationRequirements.filter((cert) => cert.name !== name));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (optionCount === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? optionCount - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && active < results.length) {
        addCertification(certificationLabel(results[active], activeLocale));
      } else if (showAddCustom) {
        addCertification(trimmedQuery);
      }
    }
  }

  return (
    <div className="grid gap-2">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {t('modal.certifications')}
      </label>

      {certificationRequirements.length > 0 && (
        <ul role="list" className="flex flex-wrap gap-2">
          {certificationRequirements.map((cert) => {
            const curated = findCertificationByName(cert.name);
            const displayName = curated ? certificationLabel(curated, activeLocale) : cert.name;
            return (
              <li key={cert.name}>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3 py-1 text-xs font-semibold text-[var(--jale-ink)]">
                  {displayName}
                  <button
                    type="button"
                    aria-label={t('modal.certifications_remove_aria', { name: displayName })}
                    onClick={() => remove(cert.name)}
                    disabled={disabled}
                    className="cursor-pointer text-[var(--jale-ink-2)] hover:text-[var(--jale-ink)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div ref={containerRef} className="relative">
        <Input
          value={text}
          placeholder={t('modal.certifications_search_placeholder')}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open && active >= 0 ? `${listboxId}-opt-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (trimmedQuery) setOpen(true);
          }}
          onBlur={() => setOpen(false)}
        />
        {open && trimmedQuery !== '' && (
          <ul
            id={listboxId}
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            className={[
              'absolute z-10 mt-1 max-h-64 w-full overflow-y-auto',
              'rounded-[var(--radius-input)] border border-[var(--jale-divider)]',
              'bg-[var(--jale-card)] py-1 shadow-[var(--shadow-modal)]',
            ].join(' ')}
          >
            {results.length === 0 && (
              <li role="presentation" className="px-3.5 py-2 text-sm text-[var(--jale-placeholder)]">
                {t('modal.certifications_no_matches')}
              </li>
            )}
            {results.map((cert, i) => {
              const label = certificationLabel(cert, activeLocale);
              const already = isAlreadyAdded(label);
              return (
                <li
                  key={cert.id}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={already}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!already) addCertification(label);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={[
                    'flex items-center justify-between gap-2 px-3.5 py-2 text-sm',
                    already ? 'cursor-not-allowed text-[var(--jale-ink-2)]' : 'cursor-pointer',
                    !already && i === active ? 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]' : '',
                    !already && i !== active ? 'text-[var(--jale-ink)]' : '',
                  ].join(' ')}
                >
                  <span>{label}</span>
                  {already && <span className="text-xs">{t('modal.certifications_already_added')}</span>}
                </li>
              );
            })}
            {showAddCustom && (
              <li
                id={`${listboxId}-opt-${results.length}`}
                role="option"
                aria-selected={active === results.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addCertification(trimmedQuery);
                }}
                onMouseEnter={() => setActive(results.length)}
                className={[
                  'cursor-pointer px-3.5 py-2 text-sm font-semibold',
                  active === results.length
                    ? 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                    : 'text-[var(--jale-blue-700)]',
                ].join(' ')}
              >
                {t('modal.certifications_add_custom', { query: trimmedQuery })}
              </li>
            )}
          </ul>
        )}
      </div>
      <p className="text-xs text-[var(--jale-ink-2)]">{t('modal.certifications_picker_hint')}</p>
    </div>
  );
}
