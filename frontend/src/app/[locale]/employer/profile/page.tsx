'use client';
import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { KVList } from '@/components/ui/kv-list';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import {
    getEmployerProfile,
    updateEmployerProfile,
    type CompanySize,
    type EmployerJobType,
    type EmployerProfileData,
    type EmployerProfilePatch,
    type EmployerTrade,
} from '@/lib/api/employer';
import { validateEmployerProfileFields, type EmployerProfileField } from '@/lib/employer-profile-form';

const FIELD_LABEL_KEY: Record<EmployerProfileField, string> = {
    company_name: 'field_company',
    contact_name: 'field_contact',
    phone: 'field_phone',
    city: 'field_city',
    service_area: 'field_service_area',
    hiring_trades: 'field_hiring_trades',
    typical_job_types: 'field_job_types',
};

export const dynamic = 'force-dynamic';

const TRADES: EmployerTrade[] = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];
const JOB_TYPES: EmployerJobType[] = ['full-time', 'part-time', 'contract'];
const COMPANY_SIZES: CompanySize[] = ['1-10', '11-50', '51-200', '200+'];

/** See the identical note in `ProfileEditForm`: two different problems, two tones. */
type FormFeedback = { tone: Extract<FeedbackTone, 'warning' | 'danger'>; text: string };

export default function EmployerProfilePage() {
    const { idToken } = useAuth();
    const t = useTranslations('employer.profile');
    const tAuth = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const tNav = useTranslations('employer_dashboard');

    const [editing, setEditing] = useState(false);
    const [saved, setSaved] = useState(false);

    const {
        phase,
        data: profile,
        errorKind,
        refreshError,
        retry,
        setData,
    } = usePageData<EmployerProfileData>({
        fetcher: async ({ token }) => {
            let loaded = await getEmployerProfile(token);
            const pending = sessionStorage.getItem('pendingEmployerProfile');
            if (pending) {
                loaded = await updateEmployerProfile(token, JSON.parse(pending));
                sessionStorage.removeItem('pendingEmployerProfile');
            }
            return loaded;
        },
        legalReturnUrl: '/employer/profile',
    });

    async function handleSave(patch: EmployerProfilePatch) {
        if (!idToken) return;
        const updated = await updateEmployerProfile(idToken, patch);
        // The PATCH response IS the new profile, so the page updates from it
        // rather than spending a second round trip re-reading what it just sent.
        setData(updated);
        setEditing(false);
        setSaved(true);
    }

    function startEditing() {
        setSaved(false);
        setEditing(true);
    }

    // 'auth' means the token gate has not opened yet: nothing has been asked
    // for, so the page owes the reader a skeleton rather than an empty screen.
    const showSkeleton = phase === 'auth' || phase === 'loading';
    const companyLabel = profile
        ? profile.company_name ?? profile.full_name ?? t('fallback_company')
        : t('fallback_company');

    return (
        <AppShell role="employer" title={tNav('nav.settings')}>
            <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {showSkeleton ? (
                    /* Same archetype and geometry as `loading.tsx`, so the route-level
                       skeleton and this one are the same picture — the handover from
                       server render to client fetch costs no visible swap. */
                    <DetailPageSkeleton />
                ) : phase === 'error' && errorKind ? (
                    <DashboardPanel>
                        <ErrorState kind={errorKind} onRetry={retry} />
                    </DashboardPanel>
                ) : !profile ? (
                    <DashboardPanel>
                        <ErrorState kind="unknown" onRetry={retry} />
                    </DashboardPanel>
                ) : (
                    <div className="anim-fade-in space-y-6">
                        {refreshError && (
                            <InlineFeedback tone="warning">{tCommon('feedback.refresh_failed')}</InlineFeedback>
                        )}

                        <DashboardPanel>
                            {/* PanelHeader's geometry, plus the avatar it has no slot for. */}
                            <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                                <div className="flex min-w-0 items-center gap-3">
                                    <InitialsAvatar name={companyLabel} fallback="E" size={36} square />
                                    <h2 className="min-w-0 truncate text-base font-extrabold text-[var(--jale-ink)]">
                                        {companyLabel}
                                    </h2>
                                </div>
                                {!editing && (
                                    <Button variant="outline" size="sm" onClick={startEditing}>
                                        {t('edit_button')}
                                    </Button>
                                )}
                            </div>

                            {editing ? (
                                <div className="anim-fade-in px-5 py-5">
                                    <EmployerProfileForm
                                        initial={profile}
                                        onCancel={() => setEditing(false)}
                                        onSave={handleSave}
                                    />
                                </div>
                            ) : (
                                <div className="anim-fade-in px-5 py-3">
                                    {saved && (
                                        <InlineFeedback
                                            tone="success"
                                            onDismiss={() => setSaved(false)}
                                            className="mb-3 mt-2"
                                        >
                                            {tCommon('feedback.saved')}
                                        </InlineFeedback>
                                    )}
                                    <KVList
                                        items={[
                                            { label: t('field_email'), value: profile.email },
                                            { label: t('field_company'), value: profile.company_name ?? profile.full_name ?? '-' },
                                            { label: t('field_contact'), value: profile.contact_name ?? '-' },
                                            {
                                                label: t('field_phone'),
                                                value: <span className="tabular-nums">{profile.phone ?? '-'}</span>,
                                            },
                                            { label: t('field_city'), value: profile.city ?? '-' },
                                            { label: t('field_service_area'), value: profile.service_area ?? '-' },
                                            {
                                                label: t('field_hiring_trades'),
                                                value: (
                                                    <BadgeList
                                                        items={profile.hiring_trades.map((trade) => tAuth(`trades.${trade}`))}
                                                        tone="info"
                                                    />
                                                ),
                                            },
                                            {
                                                label: t('field_job_types'),
                                                value: (
                                                    <BadgeList
                                                        items={profile.typical_job_types.map((jobType) =>
                                                            tAuth(`job_types.${jobType.replace('-', '_')}`),
                                                        )}
                                                    />
                                                ),
                                            },
                                            {
                                                label: t('field_company_size'),
                                                value: <span className="tabular-nums">{profile.company_size ?? '-'}</span>,
                                            },
                                            { label: t('field_description'), value: profile.company_description || '-' },
                                        ]}
                                    />
                                </div>
                            )}
                        </DashboardPanel>
                    </div>
                )}
            </div>
        </AppShell>
    );
}

function EmployerProfileForm(props: {
    initial: EmployerProfileData;
    onCancel: () => void;
    onSave: (patch: EmployerProfilePatch) => Promise<void>;
}) {
    const t = useTranslations('employer.profile');
    const tAuth = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const errorMessage = useErrorMessage();
    const fieldId = useId();
    const [companyName, setCompanyName] = useState(props.initial.company_name ?? props.initial.full_name ?? '');
    const [contactName, setContactName] = useState(props.initial.contact_name ?? '');
    const [phone, setPhone] = useState(props.initial.phone ?? '');
    const [city, setCity] = useState(props.initial.city ?? '');
    const [serviceArea, setServiceArea] = useState(props.initial.service_area ?? '');
    const [hiringTrades, setHiringTrades] = useState<EmployerTrade[]>(props.initial.hiring_trades ?? []);
    const [typicalJobTypes, setTypicalJobTypes] = useState<EmployerJobType[]>(props.initial.typical_job_types ?? []);
    const [companySize, setCompanySize] = useState<CompanySize>(props.initial.company_size ?? '1-10');
    const [companyDescription, setCompanyDescription] = useState(props.initial.company_description ?? '');
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<FormFeedback | null>(null);
    const [missingFields, setMissingFields] = useState<EmployerProfileField[]>([]);

    async function save() {
        setFeedback(null);
        const missing = validateEmployerProfileFields({
            company_name: companyName, contact_name: contactName, phone,
            city, service_area: serviceArea, hiring_trades: hiringTrades, typical_job_types: typicalJobTypes,
        });
        setMissingFields(missing);
        if (missing.length > 0) {
            setFeedback({
                tone: 'warning',
                text: t('errors.missing_summary', {
                    fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
                }),
            });
            return;
        }
        setSaving(true);
        try {
            await props.onSave({
                company_name: companyName.trim(),
                contact_name: contactName.trim(),
                phone: phone.trim(),
                city: city.trim(),
                service_area: serviceArea.trim(),
                hiring_trades: hiringTrades,
                typical_job_types: typicalJobTypes,
                company_size: companySize,
                company_description: companyDescription.trim(),
            });
        } catch (e) {
            // Never `err.message`: on a failed save that is a backend error
            // CODE or an exception string -- untranslated, and sometimes server
            // detail. Classify it into one of the reviewed bilingual sentences.
            setFeedback({ tone: 'danger', text: errorMessage(e) });
        } finally {
            setSaving(false);
        }
    }

    const toggleTrade = (trade: EmployerTrade) => {
        setHiringTrades((current) => current.includes(trade) ? current.filter((item) => item !== trade) : [...current, trade]);
    };
    const toggleJobType = (jobType: EmployerJobType) => {
        setTypicalJobTypes((current) => current.includes(jobType) ? current.filter((item) => item !== jobType) : [...current, jobType]);
    };

    const requiredError = t('errors.required');

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <LabeledField
                label={t('field_company')}
                htmlFor={`${fieldId}-company`}
                error={missingFields.includes('company_name') ? requiredError : undefined}
            >
                <Input id={`${fieldId}-company`} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </LabeledField>
            <LabeledField
                label={t('field_contact')}
                htmlFor={`${fieldId}-contact`}
                error={missingFields.includes('contact_name') ? requiredError : undefined}
            >
                <Input id={`${fieldId}-contact`} value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
            </LabeledField>
            <LabeledField
                label={t('field_phone')}
                htmlFor={`${fieldId}-phone`}
                error={missingFields.includes('phone') ? requiredError : undefined}
            >
                <Input id={`${fieldId}-phone`} type="tel" className="tabular-nums" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            </LabeledField>
            {/* LocationPicker owns its own input and takes no id, so its label is
                plain text rather than a <label> pointing at nothing. */}
            <StackedField
                label={t('field_city')}
                error={missingFields.includes('city') ? requiredError : undefined}
            >
                <LocationPicker value={city} onChange={(v) => setCity(v.label)} />
            </StackedField>
            <LabeledField
                label={t('field_service_area')}
                htmlFor={`${fieldId}-service-area`}
                error={missingFields.includes('service_area') ? requiredError : undefined}
            >
                <Input id={`${fieldId}-service-area`} value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_company_size')} htmlFor={`${fieldId}-company-size`}>
                <Select
                    id={`${fieldId}-company-size`}
                    className="tabular-nums"
                    value={companySize}
                    onChange={(e) => setCompanySize(e.target.value as CompanySize)}
                >
                    {COMPANY_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </Select>
            </LabeledField>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_hiring_trades')} error={missingFields.includes('hiring_trades') ? requiredError : undefined}>
                    {TRADES.map((trade) => <CheckboxCard key={trade} checked={hiringTrades.includes(trade)} label={tAuth(`trades.${trade}`)} onChange={() => toggleTrade(trade)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_job_types')} error={missingFields.includes('typical_job_types') ? requiredError : undefined}>
                    {JOB_TYPES.map((jobType) => <CheckboxCard key={jobType} checked={typicalJobTypes.includes(jobType)} label={tAuth(`job_types.${jobType.replace('-', '_')}`)} onChange={() => toggleJobType(jobType)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <LabeledField label={t('field_description')} htmlFor={`${fieldId}-description`}>
                    <Textarea id={`${fieldId}-description`} rows={3} value={companyDescription} onChange={(e) => setCompanyDescription(e.target.value)} />
                </LabeledField>
            </div>
            {feedback && (
                <div className="md:col-span-2">
                    <InlineFeedback tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                        {feedback.text}
                    </InlineFeedback>
                </div>
            )}
            <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
                <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
                <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
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
    children,
}: {
    label: string;
    htmlFor: string;
    error?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className={labelClasses} htmlFor={htmlFor}>{label}</label>
            {children}
            {error && <p className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
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

function CheckboxGroup({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className={labelClasses}>{label}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
            {error && <p className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
        </div>
    );
}

/**
 * A KV row whose value is a set of chips. Right-aligned to sit under the
 * column the dashed rows establish, wrapping onto more lines at 390px rather
 * than squeezing the label.
 */
function BadgeList({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'info' }) {
    if (items.length === 0) return <>-</>;

    return (
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            {items.map((item) => (
                <Badge key={item} tone={tone}>
                    {item}
                </Badge>
            ))}
        </span>
    );
}
