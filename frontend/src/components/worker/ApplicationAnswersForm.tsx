'use client';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { REQUIREMENT_DOC_KEYS, type RequirementFieldKey } from '@/lib/job-requirements';
import {
  APPLY_PAY_INTERVALS, EDUCATION_LEVELS, MAX_REPEATING_ENTRIES,
  addRepeatingEntry, buildAnswersPayload, canSubmitAnswers, emptyAnswerDraft,
  emptyReferenceEntry, emptyWorkHistoryEntry, isFieldComplete, missingRequiredFields,
  removeRepeatingEntry, visibleFieldKeys,
  type AnswerDraft, type ApplyPayInterval,
} from '@/lib/application-answers-form';
import {
  getAuthUploadUrl, confirmAuthUpload, getVaultDocuments, uploadFileToS3,
  type JobDocType, type JobDetail, type WorkerVaultDoc,
} from '@/lib/api/worker';

const MAX_CERTIFICATION_FILES = 5;

/**
 * The pre-apply requirements gate: parallel to `ProfileCompleteModal`, opened
 * the same way (worker taps Apply, this fills in what the JOB -- not the
 * general profile -- asks for). Renders exactly the job's checked fields
 * (`job.required_fields`/`job.optional_fields`, both `?? []` -- the
 * currently-deployed handler sends neither yet) plus a document section for
 * `job.required_docs`/`job.optional_docs`.
 *
 * Submit stays disabled until every required field is complete AND every
 * required doc is uploaded (`missing_docs`-equivalent, computed locally from
 * the vault so an in-place upload clears the block without a page reload).
 * Optional fields carry an explicit Skip affordance; optional docs are never
 * blocking.
 */
export function ApplicationAnswersForm(props: {
  open: boolean;
  job: JobDetail;
  token: string;
  onClose: () => void;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
}) {
  const { open, job, token, onClose, onSubmit } = props;
  const t = useTranslations('job_requirements');
  const tCommon = useTranslations('common');
  const tDocs = useTranslations('worker_profile.documents');
  const errorMessage = useErrorMessage();
  const fieldId = useId();

  const requiredFields = job.required_fields ?? [];
  const optionalFields = job.optional_fields ?? [];
  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  const fieldsToShow = visibleFieldKeys(requiredFields, optionalFields);
  const docsToShow = REQUIREMENT_DOC_KEYS.filter(
    (key) => requiredDocs.includes(key) || optionalDocs.includes(key),
  ) as JobDocType[];

  const [draft, setDraft] = useState<AnswerDraft>(emptyAnswerDraft());
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [vaultDocs, setVaultDocs] = useState<WorkerVaultDoc[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);

  // Fresh state every time the gate opens -- a worker who closes it midway
  // and reopens later on the same job should not be greeted with a stale
  // half-filled form from a different visit.
  useEffect(() => {
    if (!open) return;
    setDraft(emptyAnswerDraft());
    setSkipped(new Set());
    setError(null);
    setShowMissing(false);
    let cancelled = false;
    getVaultDocuments(token)
      .then(({ documents }) => {
        if (!cancelled) setVaultDocs(documents);
      })
      .catch(() => {
        // The doc section degrades to "nothing uploaded yet" rather than
        // blocking the whole gate on a vault-list failure.
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, job.id]);

  const update = useCallback(<K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const toggleSkip = (key: RequirementFieldKey) => {
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const certDocsUploaded = vaultDocs.filter((d) => d.doc_type === 'certification_doc');
  const hasDoc = (docType: JobDocType) => vaultDocs.some((d) => d.doc_type === docType);
  const missingRequiredDocs = requiredDocs.filter((doc) => !hasDoc(doc as JobDocType));
  const missingFields = missingRequiredFields(requiredFields, draft);
  const canSubmit = canSubmitAnswers(requiredFields, draft) && missingRequiredDocs.length === 0;

  async function handleUpload(docType: JobDocType, file: File) {
    setUploading(docType);
    setError(null);
    try {
      const { url, s3_key } = await getAuthUploadUrl(token, docType, file.type);
      await uploadFileToS3(url, file);
      await confirmAuthUpload(token, s3_key, docType, file);
      const { documents } = await getVaultDocuments(token);
      setVaultDocs(documents);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(null);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setShowMissing(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const answers = buildAnswersPayload(requiredFields, optionalFields, draft, skipped);
      await onSubmit(answers);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('apply.title')}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={submitting} loadingLabel={tCommon('loading')}>
            {t('apply.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {fieldsToShow.map((key) => (
          <FieldRow
            key={key}
            fieldKey={key}
            required={requiredFields.includes(key)}
            skipped={skipped.has(key)}
            onSkip={() => toggleSkip(key)}
            draft={draft}
            update={update}
            fieldId={fieldId}
            missing={showMissing && missingFields.includes(key)}
          />
        ))}

        {docsToShow.length > 0 && (
          <div className="grid gap-2.5">
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
              {t('groups.documents')}
            </p>
            <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
              {docsToShow.map((docType) =>
                docType === 'certification_doc' ? (
                  <li key={docType} className="p-4">
                    <CertificationDocRow
                      count={certDocsUploaded.length}
                      uploading={uploading === docType}
                      onUpload={(file) => void handleUpload(docType, file)}
                      required={requiredDocs.includes(docType)}
                    />
                  </li>
                ) : (
                  <li key={docType}>
                    <SingleDocRow
                      docType={docType}
                      existing={vaultDocs.find((d) => d.doc_type === docType)}
                      uploading={uploading === docType}
                      onUpload={(file) => void handleUpload(docType, file)}
                      required={requiredDocs.includes(docType)}
                    />
                  </li>
                ),
              )}
            </ul>
          </div>
        )}

        {error ? <InlineFeedback tone="danger" onDismiss={() => setError(null)}>{error}</InlineFeedback> : null}
        {showMissing && !canSubmit ? (
          <InlineFeedback tone="warning">{t('apply.submit_blocked')}</InlineFeedback>
        ) : null}
      </div>
    </Modal>
  );

  function tDocLabel(docType: JobDocType) {
    return t(`docs.${docType}`);
  }

  function SingleDocRow({
    docType, existing, uploading: busy, onUpload, required,
  }: {
    docType: JobDocType;
    existing?: WorkerVaultDoc;
    uploading: boolean;
    onUpload: (file: File) => void;
    required: boolean;
  }) {
    return (
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--jale-ink)]">
            {tDocLabel(docType)}
            {!required && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                {t('states.optional')}
              </span>
            )}
          </p>
          <div className="mt-1 flex items-center gap-2">
            {existing ? <Badge tone="success">{tDocs('uploaded')}</Badge> : <Badge tone="neutral">{tDocs('not_uploaded')}</Badge>}
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--jale-ink-2)]">
                <Spinner size="sm" />{tDocs('uploading')}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {existing && (
            <a href={existing.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--jale-blue-700)] underline">
              {tDocs('view')}
            </a>
          )}
          <UploadButton disabled={busy} label={existing ? tDocs('replace') : tDocs('upload')} onFile={onUpload} />
        </div>
      </div>
    );
  }

  function CertificationDocRow({
    count, uploading: busy, onUpload, required,
  }: {
    count: number;
    uploading: boolean;
    onUpload: (file: File) => void;
    required: boolean;
  }) {
    const atMax = count >= MAX_CERTIFICATION_FILES;
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--jale-ink)]">
            {tDocLabel('certification_doc')}
            {!required && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                {t('states.optional')}
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--jale-ink-2)]">
            {t('apply.certification_count', { count, max: MAX_CERTIFICATION_FILES })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy && <Spinner size="sm" />}
          <UploadButton
            disabled={busy || atMax}
            label={t('apply.add_certification')}
            onFile={onUpload}
          />
        </div>
      </div>
    );
  }
}

function UploadButton({ disabled, label, onFile }: { disabled?: boolean; label: string; onFile: (file: File) => void }) {
  const inputId = useId();
  return (
    <label
      htmlFor={inputId}
      className={[
        'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--jale-divider)] px-3 text-xs font-semibold text-[var(--jale-ink)]',
        'hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
    >
      <Icon name="upload" />
      {label}
      <input
        id={inputId}
        type="file"
        hidden
        disabled={disabled}
        accept="application/pdf,image/jpeg,image/png"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function FieldRow({
  fieldKey, required, skipped, onSkip, draft, update, fieldId, missing,
}: {
  fieldKey: RequirementFieldKey;
  required: boolean;
  skipped: boolean;
  onSkip: () => void;
  draft: AnswerDraft;
  update: <K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) => void;
  fieldId: string;
  missing: boolean;
}) {
  const t = useTranslations('job_requirements');
  const complete = isFieldComplete(fieldKey, draft);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-bold text-[var(--jale-ink)]">
          {t(`fields.${fieldKey}`)}
          {required ? ' *' : null}
        </label>
        {!required && (
          <button
            type="button"
            aria-pressed={skipped}
            onClick={onSkip}
            className="text-xs font-semibold text-[var(--jale-ink-2)] underline underline-offset-2"
          >
            {skipped ? t('apply.skipped') : t('apply.skip')}
          </button>
        )}
      </div>

      {!skipped && <FieldInput fieldKey={fieldKey} draft={draft} update={update} fieldId={fieldId} />}

      {missing && !complete && (
        <p className="text-xs font-semibold text-[var(--jale-danger)]">{t('apply.not_answered')}</p>
      )}
    </div>
  );
}

function FieldInput({
  fieldKey, draft, update, fieldId,
}: {
  fieldKey: RequirementFieldKey;
  draft: AnswerDraft;
  update: <K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) => void;
  fieldId: string;
}) {
  const t = useTranslations('job_requirements');

  switch (fieldKey) {
    case 'work_authorization':
      return (
        <YesNo
          value={draft.work_authorization ?? null}
          onChange={(v) => update('work_authorization', v)}
        />
      );

    case 'date_available':
      return (
        <Input
          type="date"
          value={draft.date_available}
          onChange={(e) => update('date_available', e.target.value)}
        />
      );

    case 'desired_pay':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="number" min={0} max={9999}
            value={draft.desired_pay.amount}
            onChange={(e) => update('desired_pay', { ...draft.desired_pay, amount: e.target.value })}
          />
          <Select
            value={draft.desired_pay.interval}
            onChange={(e) => update('desired_pay', { ...draft.desired_pay, interval: e.target.value as ApplyPayInterval })}
          >
            {APPLY_PAY_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>{t(`apply.pay_interval.${interval}`)}</option>
            ))}
          </Select>
        </div>
      );

    case 'date_of_birth':
      return (
        <Input
          type="date"
          value={draft.date_of_birth}
          onChange={(e) => update('date_of_birth', e.target.value)}
        />
      );

    case 'home_address': {
      const a = draft.home_address;
      const set = (patch: Partial<AnswerDraft['home_address']>) => update('home_address', { ...a, ...patch });
      return (
        <div className="grid gap-2">
          <Input placeholder={t('apply.address.street')} value={a.street} onChange={(e) => set({ street: e.target.value })} />
          <Input placeholder={t('apply.address.apartment')} value={a.apartment} onChange={(e) => set({ apartment: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder={t('apply.address.city')} value={a.city} onChange={(e) => set({ city: e.target.value })} />
            <Input placeholder={t('apply.address.state')} maxLength={2} value={a.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
            <Input placeholder={t('apply.address.zip')} value={a.zip} onChange={(e) => set({ zip: e.target.value })} />
          </div>
        </div>
      );
    }

    case 'emergency_contact': {
      const c = draft.emergency_contact;
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder={t('apply.contact.name')} value={c.name} onChange={(e) => update('emergency_contact', { ...c, name: e.target.value })} />
          <Input placeholder={t('apply.contact.phone')} value={c.phone} onChange={(e) => update('emergency_contact', { ...c, phone: e.target.value })} />
        </div>
      );
    }

    case 'worked_here_before': {
      const w = draft.worked_here_before;
      return (
        <div className="grid gap-2">
          <YesNo value={w.answer} onChange={(v) => update('worked_here_before', { ...w, answer: v })} />
          {w.answer === true && (
            <Input
              placeholder={t('apply.worked_here_before_when')}
              value={w.when}
              onChange={(e) => update('worked_here_before', { ...w, when: e.target.value })}
            />
          )}
        </div>
      );
    }

    case 'education': {
      const ed = draft.education;
      return (
        <div className="grid gap-2">
          <Select value={ed.level} onChange={(e) => update('education', { ...ed, level: e.target.value as typeof ed.level })}>
            <option value="">{t('apply.select_placeholder')}</option>
            {EDUCATION_LEVELS.map((level) => (
              <option key={level} value={level}>{t(`apply.education_level.${level}`)}</option>
            ))}
          </Select>
          {ed.level && ed.level !== 'none' && (
            <YesNo
              label={t('apply.graduated')}
              value={ed.graduated}
              onChange={(v) => update('education', { ...ed, graduated: v })}
            />
          )}
        </div>
      );
    }

    case 'references':
      return (
        <RepeatingGroup
          entries={draft.references}
          empty={emptyReferenceEntry}
          onChange={(next) => update('references', next)}
          renderEntry={(entry, onEntryChange) => (
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder={t('apply.reference.name')} value={entry.name} onChange={(e) => onEntryChange({ ...entry, name: e.target.value })} />
              <Input placeholder={t('apply.reference.relationship')} value={entry.relationship} onChange={(e) => onEntryChange({ ...entry, relationship: e.target.value })} />
              <Input placeholder={t('apply.reference.company')} value={entry.company} onChange={(e) => onEntryChange({ ...entry, company: e.target.value })} />
              <Input placeholder={t('apply.reference.phone')} value={entry.phone} onChange={(e) => onEntryChange({ ...entry, phone: e.target.value })} />
            </div>
          )}
          addLabel={t('apply.add_reference')}
          fieldId={`${fieldId}-refs`}
        />
      );

    case 'work_history':
      return (
        <RepeatingGroup
          entries={draft.work_history}
          empty={emptyWorkHistoryEntry}
          onChange={(next) => update('work_history', next)}
          renderEntry={(entry, onEntryChange) => (
            <div className="grid gap-2">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('apply.work_history.company')} value={entry.company} onChange={(e) => onEntryChange({ ...entry, company: e.target.value })} />
                <Input placeholder={t('apply.work_history.title')} value={entry.title} onChange={(e) => onEntryChange({ ...entry, title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('apply.work_history.from')} value={entry.from} onChange={(e) => onEntryChange({ ...entry, from: e.target.value })} />
                <Input placeholder={t('apply.work_history.to')} value={entry.to} onChange={(e) => onEntryChange({ ...entry, to: e.target.value })} />
              </div>
              <Input placeholder={t('apply.work_history.responsibilities')} value={entry.responsibilities} onChange={(e) => onEntryChange({ ...entry, responsibilities: e.target.value })} />
              <Input placeholder={t('apply.work_history.reason_for_leaving')} value={entry.reason_for_leaving} onChange={(e) => onEntryChange({ ...entry, reason_for_leaving: e.target.value })} />
            </div>
          )}
          addLabel={t('apply.add_work_history')}
          fieldId={`${fieldId}-work-history`}
        />
      );

    case 'military_service': {
      const m = draft.military_service;
      const set = (patch: Partial<AnswerDraft['military_service']>) => update('military_service', { ...m, ...patch });
      return (
        <div className="grid gap-2">
          <YesNo value={m.served} onChange={(v) => set({ served: v })} />
          {m.served === true && (
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder={t('apply.military.branch')} value={m.branch} onChange={(e) => set({ branch: e.target.value })} />
              <Input placeholder={t('apply.military.rank_at_discharge')} value={m.rank_at_discharge} onChange={(e) => set({ rank_at_discharge: e.target.value })} />
              <Input placeholder={t('apply.military.from')} value={m.from} onChange={(e) => set({ from: e.target.value })} />
              <Input placeholder={t('apply.military.to')} value={m.to} onChange={(e) => set({ to: e.target.value })} />
              <Input placeholder={t('apply.military.discharge_type')} value={m.discharge_type} onChange={(e) => set({ discharge_type: e.target.value })} />
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

function YesNo({ value, onChange, label }: { value: boolean | null; onChange: (value: boolean) => void; label?: string }) {
  const t = useTranslations('job_requirements');
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs font-semibold text-[var(--jale-ink-2)]">{label}</span>}
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full border border-[var(--jale-divider)] p-0.5">
        {[true, false].map((option) => {
          const selected = value === option;
          return (
            <button
              key={String(option)}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={[
                'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                selected ? 'bg-[var(--jale-blue-500)] text-white' : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
              ].join(' ')}
            >
              {t(option ? 'apply.yes' : 'apply.no')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RepeatingGroup<T>({
  entries, empty, onChange, renderEntry, addLabel, fieldId,
}: {
  entries: T[];
  empty: () => T;
  onChange: (next: T[]) => void;
  renderEntry: (entry: T, onEntryChange: (next: T) => void) => ReactNode;
  addLabel: string;
  fieldId: string;
}) {
  const t = useTranslations('job_requirements');
  return (
    <div className="grid gap-3">
      {entries.map((entry, index) => (
        <div key={`${fieldId}-${index}`} className="rounded-[10px] border border-[var(--jale-divider)] p-3">
          {renderEntry(entry, (next) => {
            const copy = [...entries];
            copy[index] = next;
            onChange(copy);
          })}
          <button
            type="button"
            onClick={() => onChange(removeRepeatingEntry(entries, index))}
            className="mt-2 text-xs font-semibold text-[var(--jale-danger)] underline"
          >
            {t('apply.remove')}
          </button>
        </div>
      ))}
      {entries.length < MAX_REPEATING_ENTRIES && (
        <Button variant="outline" size="sm" onClick={() => onChange(addRepeatingEntry(entries, empty))}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}
