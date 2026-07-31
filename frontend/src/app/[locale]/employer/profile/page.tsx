'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import { Input } from '@/components/ui/input';
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

export default function EmployerProfilePage() {
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const t = useTranslations('employer.profile');
    const tAuth = useTranslations('auth.employer');
    const tCommon = useTranslations('common');
    const tNav = useTranslations('employer_dashboard');
    const [profile, setProfile] = useState<EmployerProfileData | null>(null);
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function loadProfile() {
        if (!idToken) return;
        try {
            let loaded = await getEmployerProfile(idToken);
            const pending = sessionStorage.getItem('pendingEmployerProfile');
            if (pending) {
                loaded = await updateEmployerProfile(idToken, JSON.parse(pending));
                sessionStorage.removeItem('pendingEmployerProfile');
            }
            setProfile(loaded);
        } catch (err) {
            try {
                handleLegalWall(err, '/employer/profile');
            } catch {
                setError(tCommon('error'));
            }
        }
    }

    useEffect(() => { loadProfile(); }, [idToken]);

    async function handleSave(patch: EmployerProfilePatch) {
        if (!idToken) return;
        const updated = await updateEmployerProfile(idToken, patch);
        setProfile(updated);
        setEditing(false);
    }

    if (error) {
        return (
            <AppShell role="employer" title={tNav('nav.settings')}>
                <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3 px-4">
                    <p className="text-sm text-error">{error}</p>
                    <Button variant="outline" onClick={() => { setError(null); loadProfile(); }}>{tCommon('retry')}</Button>
                </main>
            </AppShell>
        );
    }
    if (!profile) {
        return (
            <AppShell role="employer" title={tNav('nav.settings')}>
                <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                    <PageSkeleton label={tCommon('loading')} />
                </main>
            </AppShell>
        );
    }

    return (
        <AppShell role="employer" title={tNav('nav.settings')}>
            <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <DashboardPanel>
                    <PanelHeader
                        title={profile.company_name ?? profile.full_name ?? t('fallback_company')}
                        action={!editing ? (
                            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('edit_button')}</Button>
                        ) : undefined}
                    />
                    <div className="p-6">
                        {editing ? (
                            <EmployerProfileForm initial={profile} onCancel={() => setEditing(false)} onSave={handleSave} />
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <Field label={t('field_email')} value={profile.email} />
                                <Field label={t('field_company')} value={profile.company_name ?? profile.full_name} />
                                <Field label={t('field_contact')} value={profile.contact_name} />
                                <Field label={t('field_phone')} value={profile.phone} />
                                <Field label={t('field_city')} value={profile.city} />
                                <Field label={t('field_service_area')} value={profile.service_area} />
                                <Field label={t('field_hiring_trades')} value={profile.hiring_trades.map((trade) => tAuth(`trades.${trade}`)).join(', ')} />
                                <Field label={t('field_job_types')} value={profile.typical_job_types.map((jobType) => tAuth(`job_types.${jobType.replace('-', '_')}`)).join(', ')} />
                                <Field label={t('field_company_size')} value={profile.company_size} />
                                <div className="md:col-span-2"><Field label={t('field_description')} value={profile.company_description} /></div>
                            </div>
                        )}
                    </div>
                </DashboardPanel>
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
    const [error, setError] = useState<string | null>(null);
    const [missingFields, setMissingFields] = useState<EmployerProfileField[]>([]);

    async function save() {
        setError(null);
        const missing = validateEmployerProfileFields({
            company_name: companyName, contact_name: contactName, phone,
            city, service_area: serviceArea, hiring_trades: hiringTrades, typical_job_types: typicalJobTypes,
        });
        setMissingFields(missing);
        if (missing.length > 0) {
            setError(t('errors.missing_summary', {
                fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
            }));
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
            const err = e as Record<string, unknown>;
            setError(typeof err.message === 'string' ? err.message : tCommon('error'));
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

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <LabeledField label={t('field_company')} error={missingFields.includes('company_name') ? t('errors.required') : undefined}>
                <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_contact')} error={missingFields.includes('contact_name') ? t('errors.required') : undefined}>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
            </LabeledField>
            <LabeledField label={t('field_phone')} error={missingFields.includes('phone') ? t('errors.required') : undefined}>
                <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            </LabeledField>
            <LabeledField label={t('field_city')} error={missingFields.includes('city') ? t('errors.required') : undefined}>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_service_area')} error={missingFields.includes('service_area') ? t('errors.required') : undefined}>
                <Input value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_company_size')}>
                <Select value={companySize} onChange={(e) => setCompanySize(e.target.value as CompanySize)}>
                    {COMPANY_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </Select>
            </LabeledField>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_hiring_trades')} error={missingFields.includes('hiring_trades') ? t('errors.required') : undefined}>
                    {TRADES.map((trade) => <CheckboxCard key={trade} checked={hiringTrades.includes(trade)} label={tAuth(`trades.${trade}`)} onChange={() => toggleTrade(trade)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_job_types')} error={missingFields.includes('typical_job_types') ? t('errors.required') : undefined}>
                    {JOB_TYPES.map((jobType) => <CheckboxCard key={jobType} checked={typicalJobTypes.includes(jobType)} label={tAuth(`job_types.${jobType.replace('-', '_')}`)} onChange={() => toggleJobType(jobType)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <LabeledField label={t('field_description')}>
                    <Textarea rows={3} value={companyDescription} onChange={(e) => setCompanyDescription(e.target.value)} />
                </LabeledField>
            </div>
            {error && <div className="md:col-span-2"><p className="text-sm text-error">{error}</p></div>}
            <div className="md:col-span-2 flex gap-2 justify-end">
                <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
                <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
            </div>
        </div>
    );
}

function LabeledField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</label>
            {children}
            {error && <p className="text-xs text-error">{error}</p>}
        </div>
    );
}

function Field({ label, value }: { label: string; value: string | null }) {
    return (
        <div>
            <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
            <p className="text-sm">{value || '-'}</p>
        </div>
    );
}

function CheckboxGroup({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
            {error && <p className="text-xs text-error">{error}</p>}
        </div>
    );
}
