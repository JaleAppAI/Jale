'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { findCertificationByName, certificationLabel } from '@/lib/certifications';
import {
  REQUIREMENT_DOC_KEYS,
  FIELD_GROUPS,
  countRequirements,
  certificationHintNames,
  certificationHintKey,
  docHintKey,
  setRequirementState,
  type RequirementDocKey,
  type RequirementKey,
  type RequirementsMap,
  type RequirementState,
  type CertificationRequirement,
  type CertificationTier,
} from '@/lib/job-requirements';

const STATES: readonly RequirementState[] = ['off', 'optional', 'required'];
const CERT_TIERS: readonly CertificationTier[] = ['optional', 'required'];

/**
 * "What applicants must provide" -- Design A, grouped checklist.
 *
 * Shared by PostJobModal's step 3 and JobFormFields (EditJobModal +
 * TemplateEditModal). Renders TWO fieldsets -- Documents and Questions (11
 * rows, sub-grouped) -- each row a labelled radiogroup of segmented options,
 * so the state is announced per row without inventing a bespoke widget.
 *
 * The Documents fieldset has two mutually exclusive shapes for its
 * certification row(s), chosen by whether `certificationRequirements` is
 * empty (see that prop's doc comment): the single legacy `certification_doc`
 * three-state row, or one two-state row per named certification. The two
 * never render together -- see bullet 6 of FE-T5's spec.
 *
 * `locked` freezes every control (jobs with applicants -- the same freeze
 * `JobFormFields` already applies to job_type/required docs) and shows the
 * existing locked note above the picker instead of duplicating it per row.
 */
interface RequirementsPickerProps {
  requirements: RequirementsMap;
  onChange: (next: RequirementsMap) => void;
  /**
   * Step 2's free-text certifications, for the legacy certification_doc
   * row's hint. Unused once `certificationRequirements` is non-empty --
   * per-cert rows carry their own resolved display name instead.
   */
  certifications?: string;
  /**
   * Per-certification requirements (job-flow redesign data model, FE-T2 --
   * `CertificationRequirement` in `lib/job-requirements.ts`).
   *
   * Non-empty: the single legacy `certification_doc` row is replaced by one
   * row per entry, each with its own Required/Optional tier control and its
   * own proof-upload toggle. `certification_doc` is never rendered
   * alongside these rows, locked or not.
   *
   * Empty or omitted (the default): renders today's single
   * `certification_doc` row, unchanged -- so legacy jobs, and callers not
   * yet wired to this contract (PostJobModal / JobFormFields, Wave-3 task),
   * look byte-identical to before.
   *
   * Removing a certification entirely ('off') is NOT a control this
   * component exposes -- that's the chip-delete affordance on step 2's
   * picker, owned by another task.
   */
  certificationRequirements?: CertificationRequirement[];
  /** Fired when a cert row's Required/Optional control changes. */
  onCertificationTierChange?: (name: string, tier: CertificationTier) => void;
  /** Fired when a cert row's proof-upload toggle is flipped. */
  onCertificationProofToggle?: (name: string) => void;
  locked?: boolean;
}

export function RequirementsPicker({
  requirements,
  onChange,
  certifications = '',
  certificationRequirements = [],
  onCertificationTierChange,
  onCertificationProofToggle,
  locked = false,
}: RequirementsPickerProps) {
  const t = useTranslations('job_requirements');
  const locale = useLocale();
  const activeLocale: 'en' | 'es' = locale === 'es' ? 'es' : 'en';

  const setState = (key: RequirementKey, state: RequirementState) => {
    if (locked) return;
    onChange(setRequirementState(requirements, key, state));
  };

  const setCertTier = (name: string, tier: CertificationTier) => {
    if (locked) return;
    onCertificationTierChange?.(name, tier);
  };

  const toggleCertProof = (name: string) => {
    if (locked) return;
    onCertificationProofToggle?.(name);
  };

  const hasCerts = certificationRequirements.length > 0;

  // 2-arg countRequirements unconditionally excludes certification_doc from
  // the tally (Wave-1 contract: `certs !== undefined` switches modes, not
  // `.length > 0`) -- calling it only when certs are actually present keeps
  // a legacy job's certification_doc state (e.g. Required, no certs array)
  // counted, exactly as it is today.
  const { required, optional } = hasCerts
    ? countRequirements(requirements, certificationRequirements)
    : countRequirements(requirements);

  const certNames = certificationHintNames(certifications);

  // Invariant: certification_doc never renders alongside per-cert rows, in
  // any state (locked or not) -- per-cert presence hides it entirely.
  const docKeys = hasCerts
    ? REQUIREMENT_DOC_KEYS.filter((key) => key !== 'certification_doc')
    : REQUIREMENT_DOC_KEYS;

  /**
   * Every document row now explains what its state actually does to an
   * applicant (`docHintKey` -- Required means the upload itself is mandatory
   * at apply; there is no "I have it" attestation path for these legacy doc
   * types). `certification_doc` KEEPS its existing "Will ask for proof of:
   * …" names hint on top of that sentence rather than losing it: the two say
   * different things (the gate vs. which certificates the employer typed in
   * step 2), so they are composed, not swapped.
   *
   * DOCUMENT ROWS ONLY -- the question rows below pass no hint, and this
   * copy ("this document") would be wrong for them.
   */
  const docRowHint = (key: RequirementDocKey): string | undefined => {
    const stateKey = docHintKey(requirements[key]);
    const parts: string[] = [];
    if (stateKey) parts.push(t(stateKey));
    if (key === 'certification_doc' && requirements[key] !== 'off' && certNames.length > 0) {
      parts.push(t('picker.cert_hint', { names: certNames.join(', ') }));
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--jale-ink-2)]">{t('picker.rule_line')}</p>
        <Badge tone="info">{t('picker.count_badge', { required, optional })}</Badge>
      </div>

      {locked && (
        <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('picker.locked_note')}</p>
      )}

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('groups.documents')}
        </legend>
        <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)]">
          {docKeys.map((key) => (
            <li key={key}>
              <RequirementRow
                rowKey={key}
                label={t(`docs.${key}`)}
                state={requirements[key]}
                onChange={(state) => setState(key, state)}
                disabled={locked}
                hint={docRowHint(key)}
              />
            </li>
          ))}
        </ul>

        {hasCerts && (
          <div className="grid gap-2">
            <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('groups.certifications')}</p>
            <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)]">
              {certificationRequirements.map((cert) => {
                const curated = findCertificationByName(cert.name);
                const displayName = curated ? certificationLabel(curated, activeLocale) : cert.name;
                return (
                  <li key={cert.name}>
                    <CertificationRow
                      displayName={displayName}
                      tier={cert.tier}
                      proofRequired={cert.proof_required}
                      onTierChange={(tier) => setCertTier(cert.name, tier)}
                      onProofToggle={() => toggleCertProof(cert.name)}
                      disabled={locked}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('groups.questions')}
        </legend>
        {(Object.keys(FIELD_GROUPS) as Array<keyof typeof FIELD_GROUPS>).map((group) => (
          <div key={group} className="grid gap-2">
            <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t(`groups.${group}`)}</p>
            <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)]">
              {FIELD_GROUPS[group].map((key) => (
                <li key={key}>
                  <RequirementRow
                    rowKey={key}
                    label={t(`fields.${key}`)}
                    state={requirements[key]}
                    onChange={(state) => setState(key, state)}
                    disabled={locked}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

function RequirementRow({
  rowKey, label, state, onChange, disabled, hint,
}: {
  rowKey: string;
  label: string;
  state: RequirementState;
  onChange: (state: RequirementState) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const t = useTranslations('job_requirements');
  const groupName = `requirement-${rowKey}`;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">{label}</span>
        <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full border border-[var(--jale-divider)] p-0.5">
          {STATES.map((option) => {
            const selected = state === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                name={groupName}
                disabled={disabled}
                onClick={() => onChange(option)}
                className={[
                  'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  selected
                    ? 'bg-[var(--jale-blue-500)] text-white'
                    : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
                ].join(' ')}
              >
                {t(`states.${option}`)}
              </button>
            );
          })}
        </div>
      </div>
      {hint && <p className="text-xs text-[var(--jale-ink-2)]">{hint}</p>}
    </div>
  );
}

/**
 * One named certification's row (job-flow redesign, FE-T5): a two-state
 * Required/Optional tier control -- mirroring RequirementRow's segmented
 * idiom, just without the Off option, since removing a certification is a
 * chip-delete affordance elsewhere, not a state this row can reach -- plus a
 * proof-upload toggle, styled after the settings switch in
 * `PublicListingCard` (the codebase's one existing on/off switch idiom).
 */
function CertificationRow({
  displayName, tier, proofRequired, onTierChange, onProofToggle, disabled,
}: {
  displayName: string;
  tier: CertificationTier;
  proofRequired: boolean;
  onTierChange: (tier: CertificationTier) => void;
  onProofToggle: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('job_requirements');

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">{displayName}</span>
        <div
          role="radiogroup"
          aria-label={t('picker.cert_tier_aria', { name: displayName })}
          className="flex gap-1 rounded-full border border-[var(--jale-divider)] p-0.5"
        >
          {CERT_TIERS.map((option) => {
            const selected = tier === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onTierChange(option)}
                className={[
                  'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  selected
                    ? 'bg-[var(--jale-blue-500)] text-white'
                    : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
                ].join(' ')}
              >
                {t(`states.${option}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-[var(--jale-ink)]">{t('picker.proof_toggle_label')}</span>
          {/*
            State-dependent, because the old static sentence ("asks the
            applicant to attach the certificate") described only one of the
            three reachable combinations and quietly misdescribed the other
            two: a required cert with the toggle OFF still gates on the
            worker's yes/no attestation, and an OPTIONAL cert never blocks an
            application no matter how this toggle is set (see
            `certificationHintKey`, and `certification-claims.ts` for the gate
            it mirrors).
          */}
          <span className="block text-xs text-[var(--jale-ink-2)]">
            {t(certificationHintKey(tier, proofRequired))}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={proofRequired}
          aria-label={t('picker.proof_toggle_label')}
          disabled={disabled}
          onClick={onProofToggle}
          className={[
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border',
            'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
            proofRequired
              ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)]'
              : 'border-[var(--jale-divider)] bg-[var(--jale-paper-2)]',
          ].join(' ')}
        >
          <span
            aria-hidden
            className={[
              'inline-block h-4 w-4 rounded-full transition-transform duration-150',
              proofRequired
                ? 'translate-x-[1.4375rem] bg-[var(--jale-blue-500)]'
                : 'translate-x-[0.1875rem] bg-[var(--jale-ink-2)]',
            ].join(' ')}
          />
        </button>
      </div>
    </div>
  );
}
