'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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

    if (error) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error}</p></main>;
    if (!profile) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-muted">{tCommon('loading')}</p></main>;

    return (
        <main className="mx-auto max-w-5xl px-4 py-10">
            <h1 className="text-[1.4rem] md:text-[1.7rem] font-bold tracking-[-0.03em] leading-[1.2] mb-6">{t('title')}</h1>
            <Card className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold">{profile.company_name ?? profile.full_name ?? t('fallback_company')}</h2>
                    {!editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('edit_button')}</Button>}
                </div>
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
            </Card>
        </main>
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

    async function save() {
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
            <LabeledField label={t('field_company')}>
                <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_contact')}>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
            </LabeledField>
            <LabeledField label={t('field_phone')}>
                <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            </LabeledField>
            <LabeledField label={t('field_city')}>
                <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_service_area')}>
                <Input value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} />
            </LabeledField>
            <LabeledField label={t('field_company_size')}>
                <Select value={companySize} onChange={(e) => setCompanySize(e.target.value as CompanySize)}>
                    {COMPANY_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </Select>
            </LabeledField>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_hiring_trades')}>
                    {TRADES.map((trade) => <CheckboxCard key={trade} checked={hiringTrades.includes(trade)} label={tAuth(`trades.${trade}`)} onChange={() => toggleTrade(trade)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <CheckboxGroup label={t('field_job_types')}>
                    {JOB_TYPES.map((jobType) => <CheckboxCard key={jobType} checked={typicalJobTypes.includes(jobType)} label={tAuth(`job_types.${jobType.replace('-', '_')}`)} onChange={() => toggleJobType(jobType)} />)}
                </CheckboxGroup>
            </div>
            <div className="md:col-span-2">
                <LabeledField label={t('field_description')}>
                    <Textarea rows={3} value={companyDescription} onChange={(e) => setCompanyDescription(e.target.value)} />
                </LabeledField>
            </div>
            <div className="md:col-span-2 flex gap-2 justify-end">
                <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
                <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
            </div>
        </div>
    );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</label>
            {children}
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

function CheckboxGroup({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>{label}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
        </div>
    );
}
