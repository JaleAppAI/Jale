'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { docTypeLabel, type DocTypeKey } from '@/lib/doc-types';
import type { WorkerDocument } from '@/lib/api/employer';

/**
 * The applicant's documents, one section per slot the app can still ask for.
 *
 * `ssn` is NOT here. Nothing in the product offers it as an upload any more,
 * so an "SSN Card — Not uploaded yet" row asked the employer to chase a
 * document neither side can produce, and a stray legacy row would have put a
 * social-security card on screen for no reason. It stays in `DOC_TYPE_KEYS`
 * (old `jobs.required_docs` rows still name it) but not in this list.
 *
 * `work_auth_doc` and `certification_doc` are here for the first time: the
 * backend has accepted both since migration 074, and workers have been
 * uploading them through the apply flow into a slot no employer surface
 * rendered.
 */
const ALL_DOC_TYPES: DocTypeKey[] = [
  'resume',
  'driver_license',
  'work_auth_doc',
  'certification_doc',
];

/**
 * Types this app KNOWS and has deliberately withdrawn. They are not unknown,
 * and must never fall through to the "Other document" catch-all below -- that
 * would put a social-security card back on screen through the side door.
 */
const RETIRED_DOC_TYPES = new Set<string>(['ssn']);

/**
 * Anchors styled as buttons.
 *
 * `Button` renders a `<button>`, and the document actions are real navigations
 * to a presigned S3 URL (open in a tab / download), so they must be anchors.
 * These two recipes mirror `button.tsx`'s primary/ghost output at `size="sm"`.
 * Same escape hatch, and same TODO, as `StateAction` in `ui/empty-state`.
 */
const DOC_ACTION_BASE = [
  'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4',
  'text-xs font-semibold leading-none whitespace-nowrap select-none',
  'transition-all duration-150 active:scale-[0.98]',
  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

const DOC_ACTION_PRIMARY =
  'bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]';

const DOC_ACTION_GHOST =
  'border border-[var(--jale-divider)] bg-transparent text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]';

/** The slot's whole state in one tile: the semantic -bg/-text pairs are the
 *  only two tints that stay legible in both themes. */
function StateTile({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
        filled
          ? 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]'
          : 'bg-[var(--jale-danger-bg)] text-[var(--jale-danger-text)]'
      }`}
    >
      <Icon name={filled ? 'check' : 'alert'} />
    </span>
  );
}

/** One uploaded file: what it is, how big, and the two ways to open it. */
function DocFileRow({ doc }: { doc: WorkerDocument }) {
  const t = useTranslations('employer_worker_profile');
  return (
    <li className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {/* The worker's own name for the file, when they gave one (078's
            `cert_name`). Without it a slot holding four certificates is four
            indistinguishable PDF names. */}
        {doc.cert_name ? (
          <p className="truncate text-sm font-semibold text-[var(--jale-ink)]">{doc.cert_name}</p>
        ) : null}
        {/* The size never gets truncated away: it is the one part of this line
            a reader scans for, and a long filename would otherwise eat it
            whole in the narrow column. */}
        <p className="mt-0.5 flex items-baseline gap-1 text-xs text-[var(--jale-ink-2)]">
          <span className="truncate">{doc.file_name}</span>
          <span className="shrink-0 tabular-nums">
            {' - '}
            {Math.round(doc.file_size / 1024)} KB
          </span>
        </p>
      </div>

      <div className="flex shrink-0 gap-2">
        <a
          href={doc.url}
          target="_blank"
          rel="noreferrer"
          className={`${DOC_ACTION_BASE} ${DOC_ACTION_PRIMARY}`}
        >
          {t('view')}
        </a>
        <a
          href={doc.url}
          download={doc.file_name}
          className={`${DOC_ACTION_BASE} ${DOC_ACTION_GHOST}`}
        >
          {t('download')}
        </a>
      </div>
    </li>
  );
}

export function DocumentSlots({
  documents,
  onRequest,
  requestDisabled,
  requesting,
}: {
  documents: readonly WorkerDocument[];
  onRequest: () => void;
  requestDisabled: boolean;
  requesting: boolean;
}) {
  const t = useTranslations('employer_worker_profile');
  const tCommon = useTranslations('common');
  const tDocTypes = useTranslations('doc_types');

  const otherDocs = documents.filter(
    (entry) =>
      !(ALL_DOC_TYPES as readonly string[]).includes(entry.doc_type) &&
      !RETIRED_DOC_TYPES.has(entry.doc_type),
  );

  return (
    <ul className="divide-y divide-[var(--jale-divider)]">
      {ALL_DOC_TYPES.map((type) => {
        // A LIST per type, not `find`. The certification slot holds up to 20
        // rows (075/078) -- one per named cert -- and `find` showed the first
        // and silently dropped every other file the worker had uploaded.
        const slotDocs = documents.filter((entry) => entry.doc_type === type);
        const label = docTypeLabel(type, tDocTypes) ?? type;

        return (
          <li key={type} className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <StateTile filled={slotDocs.length > 0} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--jale-ink)]">{label}</p>
                  {slotDocs.length === 0 ? (
                    <p className="mt-0.5 text-xs font-semibold text-[var(--jale-danger-text)]">
                      {t('not_uploaded')}
                    </p>
                  ) : null}
                </div>
              </div>

              {slotDocs.length === 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={onRequest}
                  disabled={requestDisabled}
                  loading={requesting}
                  loadingLabel={tCommon('loading')}
                >
                  {t('request')}
                </Button>
              ) : null}
            </div>

            {slotDocs.length > 0 ? (
              <ul className="mt-2 space-y-2 pl-11">
                {slotDocs.map((doc) => (
                  <DocFileRow key={doc.id} doc={doc} />
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}

      {/* A doc_type the backend accepts and this build has never heard of used
          to vanish entirely: the employer saw the four slots, no file, and no
          hint that one existed. It gets a generic heading and is identified by
          its own file name. No Request button -- we cannot ask for a document
          we cannot name. */}
      {otherDocs.length > 0 ? (
        <li className="px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <StateTile filled />
            <p className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">
              {tDocTypes('other')}
            </p>
          </div>
          <ul className="mt-2 space-y-2 pl-11">
            {otherDocs.map((doc) => (
              <DocFileRow key={doc.id} doc={doc} />
            ))}
          </ul>
        </li>
      ) : null}
    </ul>
  );
}
