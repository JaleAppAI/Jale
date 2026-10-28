'use client';
import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useEmployerMembership, type EmployerMembership } from '@/hooks/useEmployerMembership';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { AppShell } from '@/components/layout/AppShell';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { BadgeList } from '@/components/ui/badge-list';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { FactsCard } from '@/components/ui/facts-card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { ProfileSkeleton } from '@/components/ui/profile-skeleton';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { DigestSettingsPanel } from '@/components/employer/DigestSettingsPanel';
import {
    updateEmployerProfile,
    type CompanySize,
    type EmployerJobType,
    type EmployerProfileData,
    type EmployerProfilePatch,
    type EmployerTrade,
} from '@/lib/api/employer';
import { validateEmployerProfileFields, type EmployerProfileField } from '@/lib/employer-profile-form';
import { loadEmployerProfileWithPendingFlush } from '@/lib/employer-profile-flush';
import { isTeamManagementEnabled } from '@/lib/feature-flags';

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

/**
 * Since Phase 3 both the GET and the PATCH answer with the caller's `role` and
 * the company's name (`companyName`, the owner's `company_name`); a foreman's
 * own row carries no company fields. Optional: an API from before omits them.
 * The page replaces its data with the PATCH response, so both survive a save.
 */
type EmployerProfileView = EmployerProfileData & {
    role?: 'owner' | 'foreman';
    companyName?: string | null;
};

/** The fields a foreman may change (the API refuses any other with 403 owner_required). */
const FOREMAN_FIELDS: readonly EmployerProfileField[] = ['contact_name', 'phone'];

/**
 * Whose settings these are, for the company fields: `'owner'` edits them,
 * anyone else (`'foreman'`, or `null` while that is not known) sees them
 * read-only.
 *
 * - `membership` null is the team flag off: Phase 2, every login the owner.
 * - `ready` is the membership's role.
 * - `blocked` is never the owner (the hook has already routed it away).
 * - Otherwise (`loading`, `error`) the profile's own `role`, which the same
 *   response carries; failing that, an `error`'s billing role (an unknown one
 *   counting as the owner, as the nav does), and `loading` stays unknown.
 */
function companyRole(
    membership: EmployerMembership | null,
    profileRole: EmployerProfileView['role'],
): 'owner' | 'foreman' | null {
    if (membership === null) return 'owner';
    if (membership.status === 'ready') return membership.role;
    if (membership.status === 'blocked') return null;
    if (profileRole === 'owner' || profileRole === 'foreman') return profileRole;
    if (membership.status === 'error') return membership.billingRole ?? 'owner';
    return null;
}

export default function EmployerProfilePage() {
    // A component choice on a build-time flag, not a conditional hook: with the
    // team flag off the membership hook never runs and the page is Phase 2's.
    return isTeamManagementEnabled() ? <TeamAwareProfilePage /> : <ProfilePage membership={null} />;
}

function TeamAwareProfilePage() {
    const membership = useEmployerMembership();
    return <ProfilePage membership={membership} />;
}

function ProfilePage({ membership }: { membership: EmployerMembership | null }) {
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
    } = usePageData<EmployerProfileView>({
        fetcher: ({ token, signal }) => loadEmployerProfileWithPendingFlush(token, signal),
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
    /*
     * Phase 3: only the owner edits the company. Anyone else sees its name,
     * read-only, from the membership (or the profile's `companyName`), never
     * from their own row's company fields -- and none of the others.
     */
    const companyReadOnly = companyRole(membership, profile?.role) !== 'owner';
    const sharedCompanyName = membership?.status === 'ready'
        ? membership.companyName
        : profile?.companyName ?? null;
    const companyLabel = companyReadOnly
        ? sharedCompanyName || t('fallback_company')
        : profile
            ? profile.company_name ?? profile.full_name ?? t('fallback_company')
            : t('fallback_company');

    /*
     * The facts card's chip-valued facts, already translated.
     *
     * `BadgeList` renders NO element for an empty list -- just the bare
     * `emptyLabel` text -- so it cannot carry the tile's muted styling itself;
     * each tile reads the length here instead.
     */
    const hiringTradeLabels = (profile?.hiring_trades ?? []).map((trade) => tAuth(`trades.${trade}`));
    const jobTypeLabels = (profile?.typical_job_types ?? []).map((jobType) =>
        tAuth(`job_types.${jobType.replace('-', '_')}`),
    );

    return (
        <AppShell role="employer" title={tNav('nav.settings')} actions={<PostJobButton />}>
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {showSkeleton ? (
                    /* Same archetype, geometry AND props as `loading.tsx`, so the
                       route-level skeleton and this one are the same picture — the
                       handover from server render to client fetch costs no visible
                       swap. Seven tiles (four company, three contact), two chip
                       facts, the description paragraph. */
                    <ProfileSkeleton sections={[4, 3, 2]} />
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
                            <PanelHeader
                                leading={<InitialsAvatar name={companyLabel} fallback="E" size={36} square />}
                                title={companyLabel}
                                action={
                                    editing ? null : (
                                        <Button variant="outline" size="sm" onClick={startEditing}>
                                            {t('edit_button')}
                                        </Button>
                                    )
                                }
                            />

                            {editing ? (
                                <div className="anim-fade-in px-5 py-5">
                                    <EmployerProfileForm
                                        initial={profile}
                                        readOnlyCompany={companyReadOnly ? companyLabel : null}
                                        onCancel={() => setEditing(false)}
                                        onSave={handleSave}
                                    />
                                </div>
                            ) : (
                                <div className="anim-fade-in">
                                    {/* Its own padded block: `FactsCard` owns the card
                                        body's `p-5 md:p-6`, so a padded wrapper around
                                        both would double the card's inset. */}
                                    {saved ? (
                                        <div className="px-5 pt-4">
                                            <InlineFeedback tone="success" onDismiss={() => setSaved(false)}>
                                                {tCommon('feedback.saved')}
                                            </InlineFeedback>
                                        </div>
                                    ) : null}
                                    {/* The section labels are deliberately NOT the words of
                                        any tile inside them ("Company details" over a
                                        "Company" tile): `FactsCard` styles an `h3` section
                                        label and a `dt` tile label identically, so a
                                        repeated word renders as the same eyebrow twice. */}
                                    <FactsCard>
                                        {companyReadOnly ? (
                                            <FactsCard.Section label={t('section_company')}>
                                                <FactsCard.Tiles>
                                                    <FactsCard.Tile label={t('field_company')} muted={!sharedCompanyName}>
                                                        {sharedCompanyName || t('empty_company')}
                                                    </FactsCard.Tile>
                                                </FactsCard.Tiles>
                                                <p className="mt-3 text-xs text-[var(--jale-ink-2)]">
                                                    {t('foreman_company_hint')}
                                                </p>
                                            </FactsCard.Section>
                                        ) : (
                                            <FactsCard.Section label={t('section_company')}>
                                                <FactsCard.Tiles>
                                                    <FactsCard.Tile
                                                        label={t('field_company')}
                                                        muted={!profile.company_name && !profile.full_name}
                                                    >
                                                        {profile.company_name || profile.full_name || t('empty_company')}
                                                    </FactsCard.Tile>
                                                    <FactsCard.Tile
                                                        label={t('field_company_size')}
                                                        muted={!profile.company_size}
                                                    >
                                                        {/* The sizes are ranges ("11-50"), so the tabular
                                                            figures earn their place -- but only on a range. */}
                                                        {profile.company_size ? (
                                                            <span className="tabular-nums">{profile.company_size}</span>
                                                        ) : (
                                                            t('empty_company_size')
                                                        )}
                                                    </FactsCard.Tile>
                                                    <FactsCard.Tile label={t('field_city')} muted={!profile.city}>
                                                        {profile.city || t('empty_city')}
                                                    </FactsCard.Tile>
                                                    <FactsCard.Tile
                                                        label={t('field_service_area')}
                                                        muted={!profile.service_area}
                                                    >
                                                        {profile.service_area || t('empty_service_area')}
                                                    </FactsCard.Tile>
                                                </FactsCard.Tiles>
                                            </FactsCard.Section>
                                        )}

                                        <FactsCard.Section label={t('section_contact')}>
                                            <FactsCard.Tiles>
                                                <FactsCard.Tile
                                                    label={t('field_contact')}
                                                    muted={!profile.contact_name}
                                                >
                                                    {profile.contact_name || t('empty_contact')}
                                                </FactsCard.Tile>
                                                {/* Never empty: the account IS an email address. */}
                                                <FactsCard.Tile label={t('field_email')}>
                                                    <span data-private>{profile.email}</span>
                                                </FactsCard.Tile>
                                                <FactsCard.Tile label={t('field_phone')} muted={!profile.phone}>
                                                    {/* `tabular-nums` only wraps an actual number. */}
                                                    {profile.phone ? (
                                                        <span data-private className="tabular-nums">{profile.phone}</span>
                                                    ) : (
                                                        t('empty_phone')
                                                    )}
                                                </FactsCard.Tile>
                                            </FactsCard.Tiles>
                                        </FactsCard.Section>

                                        {/* The hiring facts and the description are the
                                            company's, so a non-owner does not see them.
                                            Two conditionals, not one fragment: FactsCard
                                            counts its direct children as sections.

                                            `align="start"` because a tile's label sits ABOVE
                                            its value: right-aligned chips would drift off the
                                            label naming them. */}
                                        {companyReadOnly ? null : (
                                            <FactsCard.Section label={t('section_hiring')}>
                                                <FactsCard.Tiles>
                                                    <FactsCard.Tile
                                                        label={t('field_hiring_trades')}
                                                        muted={hiringTradeLabels.length === 0}
                                                    >
                                                        <BadgeList
                                                            items={hiringTradeLabels}
                                                            emptyLabel={t('empty_hiring_trades')}
                                                            tone="info"
                                                            align="start"
                                                        />
                                                    </FactsCard.Tile>
                                                    <FactsCard.Tile
                                                        label={t('field_job_types')}
                                                        muted={jobTypeLabels.length === 0}
                                                    >
                                                        <BadgeList
                                                            items={jobTypeLabels}
                                                            emptyLabel={t('empty_job_types')}
                                                            align="start"
                                                        />
                                                    </FactsCard.Tile>
                                                </FactsCard.Tiles>
                                            </FactsCard.Section>
                                        )}

                                        {/* Kept even when empty, unlike a job's description:
                                            this is the employer's OWN profile, and
                                            "Description / No description added" is the
                                            prompt to write one. Muted so the placeholder
                                            does not read as a fact. */}
                                        {companyReadOnly ? null : (
                                            <FactsCard.Section label={t('field_description')}>
                                                <FactsCard.Text muted={!profile.company_description}>
                                                    {profile.company_description || t('empty_description')}
                                                </FactsCard.Text>
                                            </FactsCard.Section>
                                        )}
                                    </FactsCard>
                                </div>
                            )}
                        </DashboardPanel>

                        {/* This route IS the employer's settings screen — the
                            nav's "Settings" tab points here, and the shell is
                            titled with `nav.settings` above. The digest panel
                            owns its own fetch and its own error surface rather
                            than joining the profile's `usePageData` call: a
                            failed notification read must not take the profile
                            down with it, and vice versa. */}
                        <DigestSettingsPanel />
                    </div>
                )}
            </main>
        </AppShell>
    );
}

function EmployerProfileForm(props: {
    initial: EmployerProfileData;
    /**
     * The company's name, shown read-only, when the reader is not the owner:
     * then only the contact name and phone are fields, and only they are sent.
     * Null is the owner's form, unchanged.
     */
    readOnlyCompany: string | null;
    onCancel: () => void;
    onSave: (patch: EmployerProfilePatch) => Promise<void>;
}) {
    const contactOnly = props.readOnlyCompany !== null;
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
        }).filter((field) => !contactOnly || FOREMAN_FIELDS.includes(field));
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
            await props.onSave(contactOnly ? {
                contact_name: contactName.trim(),
                phone: phone.trim(),
            } : {
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

    const feedbackBlock = feedback && (
        <div className="md:col-span-2">
            <InlineFeedback tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                {feedback.text}
            </InlineFeedback>
        </div>
    );
    const actions = (
        <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
            <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
            <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
        </div>
    );
    const contactFields = (
        <>
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
        </>
    );

    if (contactOnly) {
        return (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Not a field: the company is the owner's to change. */}
                <div className="flex flex-col gap-1.5 md:col-span-2">
                    <p className={labelClasses}>{t('field_company')}</p>
                    <p className="text-sm font-semibold text-[var(--jale-ink)]">{props.readOnlyCompany}</p>
                    <p className="text-xs text-[var(--jale-ink-2)]">{t('foreman_company_hint')}</p>
                </div>
                {contactFields}
                {feedbackBlock}
                {actions}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <LabeledField
                label={t('field_company')}
                htmlFor={`${fieldId}-company`}
                error={missingFields.includes('company_name') ? requiredError : undefined}
            >
                <Input id={`${fieldId}-company`} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </LabeledField>
            {contactFields}
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
            {feedbackBlock}
            {actions}
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
