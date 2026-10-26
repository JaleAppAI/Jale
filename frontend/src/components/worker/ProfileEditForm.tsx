'use client';
import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { CityMultiSelect } from '@/components/ui/CityMultiSelect';
import type { LocationSource } from '@/lib/location-search';
import type { PreferredCity, WorkerAvailability, WorkerProfileData, WorkerProfilePatch } from '@/lib/api/worker';
import { customTradeAcceptable, MAX_CUSTOM_TRADE_CHARS, MIN_CUSTOM_TRADE_CHARS } from '@/lib/onboarding-flow';
import { splitDedupe } from '@/lib/text';
import { validateWorkerProfileFields, type WorkerProfileField } from '@/lib/worker-profile-form';
import { AVAILABILITY_KEYS, TRADE_KEYS, isAvailabilityKey, isTradeKey, tradeLabelKey, type TradeKey } from '@/lib/worker-vocab';
import { useErrorMessage } from '@/hooks/useErrorMessage';

/** What the Save gate can name: the four required fields, the Other trade's box, the years and an unpicked city. */
type FormField = WorkerProfileField | 'trade_other' | 'years' | 'cities';

const FIELD_LABEL_KEY: Record<FormField, string> = {
  full_name: 'full_name',
  trade_other: 'trade_other_label',
  years: 'years_experience',
  skills: 'skills_label',
  availability: 'availability_label',
  location: 'location',
  cities: 'preferred_cities_label',
};

/** The order the form shows them in, so "Please add: …" reads top to bottom. */
const FIELD_ORDER: readonly FormField[] = ['full_name', 'trade_other', 'skills', 'availability', 'years', 'location', 'cities'];

/**
 * What the form has to say about the last save attempt.
 *
 * The two tones are different problems and must not read alike: `warning` is
 * "you still have fields to fill in" (the user's own next step, listed by
 * name), `danger` is "the save itself failed" (nothing the user typed is
 * wrong). Both sentences are translated -- `danger` goes through
 * `useErrorMessage`, never a thrown string.
 */
type FormFeedback = { tone: Extract<FeedbackTone, 'warning' | 'danger'>; text: string };

/**
 * The trade as the patch carries it. A standard trade clears any custom text;
 * Other carries the worker's own words, trimmed; no trade chosen (and none
 * stored, since a stored one is always selected) sends neither, so the saved
 * row keeps what it has.
 */
function tradePatch(trade: TradeKey | '', other: string): Pick<WorkerProfilePatch, 'main_trade' | 'main_trade_other'> {
  if (trade === '') return {};
  if (trade === 'other') return { main_trade: 'other', main_trade_other: other.trim() };
  return { main_trade: trade, main_trade_other: null };
}

/**
 * The worker's profile, edited in place on `/worker/profile`.
 *
 * Nothing is saved that the worker did not choose. A field the profile has no
 * value for starts EMPTY: availability shows a "choose" option and must be
 * picked before Save (it is one of the required fields), and an empty years
 * box sends no number, so the stored value (if any) stays as it is.
 *
 * The trade offers the same six choices as onboarding. Other opens a box held
 * to the same rule as there: 2 to 60 characters once trimmed, said while
 * typing and checked again on Save. The trade is sent, and that rule
 * applied, ONLY when the worker changed it: a stored trade (whatever its
 * length, from WhatsApp or voice) is never re-sent, so an edit to anything
 * else neither trips over it nor has it reworded by the server.
 *
 * A stored number of years cannot be cleared: the server keeps a value it is
 * not sent, so an emptied box would look saved and not be. Save asks for a
 * number instead (0 if none).
 *
 * A city typed in the cities box and never picked from the list is not a
 * city: Save refuses it (pick it or clear the box) rather than save the list
 * without it and let the worker think it was added.
 *
 * `data-guide="profile.*"` marks the controls the profile's step-by-step guide
 * points at (`components/tutorials/guides/worker-profile.ts`).
 */
export function ProfileEditForm(props: {
  initial: WorkerProfileData;
  onCancel: () => void;
  onSave: (patch: WorkerProfilePatch) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.edit');
  const tFields = useTranslations('worker_profile');
  const tVocab = useTranslations('worker_vocab');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
  const fieldId = useId();
  const [fullName, setFullName] = useState(props.initial.full_name ?? '');
  // Whether the profile came with a trade / an availability. Read once: the
  // "choose" option of an unset one stays put while the form is open.
  const [tradeStored] = useState(() => isTradeKey(props.initial.main_trade));
  const [availabilityStored] = useState(() => isAvailabilityKey(props.initial.availability));
  const [trade, setTrade] = useState<TradeKey | ''>(isTradeKey(props.initial.main_trade) ? props.initial.main_trade : '');
  const [tradeOther, setTradeOther] = useState(props.initial.main_trade_other ?? '');
  // The trade as the profile came with it: what "changed" is measured against.
  const [initialTrade] = useState<TradeKey | ''>(() => (isTradeKey(props.initial.main_trade) ? props.initial.main_trade : ''));
  const [initialTradeOther] = useState(() => (props.initial.main_trade_other ?? '').trim());
  const tradeChanged = trade !== initialTrade || (trade === 'other' && tradeOther.trim() !== initialTradeOther);
  const [yearsStored] = useState(
    () => props.initial.years_experience !== null && props.initial.years_experience !== undefined,
  );
  const [skills, setSkills] = useState((props.initial.skills ?? []).join(', '));
  const [availability, setAvailability] = useState<string>(
    isAvailabilityKey(props.initial.availability) ? props.initial.availability : '',
  );
  const [yearsExp, setYearsExp] = useState(
    props.initial.years_experience === null || props.initial.years_experience === undefined
      ? ''
      : String(props.initial.years_experience),
  );
  const [location, setLocation] = useState(props.initial.location ?? '');
  const [bio, setBio] = useState(props.initial.bio ?? '');
  const [certs, setCerts] = useState((props.initial.certifications ?? []).join(', '));
  const [coords, setCoords] = useState<{ latitude: number; longitude: number; location_source: LocationSource } | null>(null);
  const [preferredCities, setPreferredCities] = useState<PreferredCity[]>(props.initial.preferred_cities ?? []);
  const [citiesPending, setCitiesPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const [missingFields, setMissingFields] = useState<FormField[]>([]);

  async function save() {
    setFeedback(null);
    const skillsList = splitDedupe(skills, { caseInsensitive: true });
    const blocked = new Set<FormField>(
      validateWorkerProfileFields({
        full_name: fullName.trim(),
        skills: skillsList,
        availability,
        location: location.trim(),
      }),
    );
    if (tradeChanged && trade === 'other' && !customTradeAcceptable(tradeOther)) blocked.add('trade_other');
    if (yearsStored && yearsExp.trim() === '') blocked.add('years');
    if (citiesPending) blocked.add('cities');
    const missing = FIELD_ORDER.filter((field) => blocked.has(field));
    setMissingFields(missing);
    if (missing.length > 0) {
      setFeedback({
        tone: 'warning',
        text: tFields('errors.missing_summary', {
          fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
        }),
      });
      return;
    }
    const years = yearsExp.trim();
    setSaving(true);
    try {
      await props.onSave({
        full_name: fullName.trim() || null,
        ...(tradeChanged ? tradePatch(trade, tradeOther) : {}),
        skills: skillsList,
        availability: availability as WorkerAvailability,
        ...(years === '' ? {} : { years_experience: Number(years) }),
        location: location.trim() || null,
        bio: bio.trim() || null,
        certifications: splitDedupe(certs),
        preferred_cities: preferredCities,
        ...(coords ?? {}),
      });
    } catch (e) {
      // Never `err.message`: that is a backend error code or an exception
      // string, neither of which is translated copy.
      setFeedback({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  const requiredError = tFields('errors.required');
  // The Other box's rule, said as soon as typed text breaks it, and for an
  // empty box once Save has asked for it.
  const tradeOtherError =
    tradeChanged &&
    trade === 'other' &&
    !customTradeAcceptable(tradeOther) &&
    (tradeOther.length > 0 || missingFields.includes('trade_other'))
      ? t('trade_other_length', { min: MIN_CUSTOM_TRADE_CHARS, max: MAX_CUSTOM_TRADE_CHARS })
      : undefined;
  const tradeOtherErrorId = `${fieldId}-trade-other-error`;

  return (
    <div className="space-y-4" data-guide="profile.form">
      <LabeledField
        label={t('full_name')}
        htmlFor={`${fieldId}-full-name`}
        error={missingFields.includes('full_name') ? requiredError : undefined}
      >
        <Input
          id={`${fieldId}-full-name`}
          data-guide="profile.name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
        />
      </LabeledField>

      <LabeledField label={t('trade_label')} htmlFor={`${fieldId}-trade`}>
        <Select
          id={`${fieldId}-trade`}
          data-guide="profile.trade"
          value={trade}
          onChange={(e) => setTrade(isTradeKey(e.target.value) ? e.target.value : '')}
        >
          {tradeStored ? null : <option value="" disabled>{t('trade_choose')}</option>}
          {TRADE_KEYS.map((key) => <option key={key} value={key}>{tVocab(tradeLabelKey(key))}</option>)}
        </Select>
      </LabeledField>

      {trade === 'other' ? (
        <LabeledField
          label={t('trade_other_label')}
          htmlFor={`${fieldId}-trade-other`}
          error={tradeOtherError}
          errorId={tradeOtherErrorId}
        >
          <Input
            id={`${fieldId}-trade-other`}
            data-guide="profile.trade_other"
            value={tradeOther}
            placeholder={t('trade_other_placeholder')}
            aria-invalid={tradeOtherError ? true : undefined}
            aria-describedby={tradeOtherError ? tradeOtherErrorId : undefined}
            onChange={(e) => setTradeOther(e.target.value)}
          />
        </LabeledField>
      ) : null}

      <LabeledField
        label={t('skills_label')}
        htmlFor={`${fieldId}-skills`}
        error={missingFields.includes('skills') ? requiredError : undefined}
      >
        <Input
          id={`${fieldId}-skills`}
          data-guide="profile.skills"
          placeholder={t('skills_placeholder')}
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
      </LabeledField>

      <LabeledField
        label={t('availability_label')}
        htmlFor={`${fieldId}-availability`}
        error={missingFields.includes('availability') ? requiredError : undefined}
      >
        <Select
          id={`${fieldId}-availability`}
          data-guide="profile.availability"
          value={availability}
          onChange={(e) => setAvailability(e.target.value)}
        >
          {availabilityStored ? null : <option value="" disabled>{t('availability_choose')}</option>}
          {AVAILABILITY_KEYS.map((a) => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
        </Select>
      </LabeledField>

      <LabeledField
        label={t('years_experience')}
        htmlFor={`${fieldId}-years`}
        error={missingFields.includes('years') ? t('years_required') : undefined}
      >
        <Input
          id={`${fieldId}-years`}
          data-guide="profile.years"
          // For the profile guide: a stored number cannot be cleared.
          data-stored={yearsStored ? '' : undefined}
          type="number"
          min={0}
          max={80}
          inputMode="numeric"
          className="tabular-nums"
          value={yearsExp}
          onChange={(e) => setYearsExp(e.target.value)}
        />
      </LabeledField>

      {/* LocationPicker and CityMultiSelect own their internal inputs and take no
          id, so their labels are plain text rather than a mislinked <label>. */}
      <StackedField
        label={t('location')}
        error={missingFields.includes('location') ? requiredError : undefined}
      >
        <LocationPicker
          data-guide="profile.location"
          picked={coords !== null}
          placeholder={t('location')}
          value={location}
          onChange={(v) => {
            setLocation(v.label);
            setCoords(
              v.latitude != null && v.longitude != null && v.source
                ? { latitude: v.latitude, longitude: v.longitude, location_source: v.source }
                : null,
            );
          }}
        />
      </StackedField>

      <StackedField label={t('preferred_cities_label')}>
        <div data-guide="profile.cities">
          <CityMultiSelect
            value={preferredCities}
            onChange={setPreferredCities}
            onPendingChange={setCitiesPending}
            unpickedError={missingFields.includes('cities')}
          />
        </div>
      </StackedField>

      <LabeledField label={t('bio')} htmlFor={`${fieldId}-bio`}>
        <Textarea
          id={`${fieldId}-bio`}
          data-guide="profile.bio"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
      </LabeledField>

      <LabeledField label={t('certifications_label')} htmlFor={`${fieldId}-certs`}>
        <Input
          id={`${fieldId}-certs`}
          data-guide="profile.certifications"
          placeholder={t('certifications_placeholder')}
          value={certs}
          onChange={(e) => setCerts(e.target.value)}
        />
      </LabeledField>

      {feedback && (
        <InlineFeedback tone={feedback.tone} onDismiss={() => setFeedback(null)} data-guide="profile.form_feedback">
          {feedback.text}
        </InlineFeedback>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel} disabled={saving} data-guide="profile.cancel">
          {t('cancel')}
        </Button>
        <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')} data-guide="profile.save">
          {t('save')}
        </Button>
      </div>
    </div>
  );
}

const labelClasses = 'text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]';

/** Label + control + adjacent validation error, for controls that accept an id. */
function LabeledField({
  label,
  htmlFor,
  error,
  errorId,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  /** Set when the control points at the error with `aria-describedby`. */
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={labelClasses} htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <p id={errorId} className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
    </div>
  );
}

/** Same shape for composite controls that own their own inner input. */
function StackedField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className={labelClasses}>{label}</p>
      {children}
      {error && <p className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
    </div>
  );
}
