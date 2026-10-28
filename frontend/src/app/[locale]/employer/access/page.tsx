'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { notFound, useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { isLegalWallError, isMembershipBlockedError, type MembershipBlockedReason } from '@/lib/api';
import { ApiError, classifyError, errorMessageKey, type ErrorKind } from '@/lib/api/errors';
import { getMembership, startCompany } from '@/lib/api/team';
import {
    ACCESS_PAGE_PATH,
    clearEmployerMembershipCache,
    resetAccessRedirectGuard,
    takeAccessRedirect,
} from '@/lib/employer-membership-store';
import { isTeamManagementEnabled } from '@/lib/feature-flags';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/** Same frame as the legal wall: centred under the global header, no app shell. */
const FRAME = 'flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-10';
const CARD = 'w-full max-w-md anim-fade-in space-y-6 p-8 md:p-10';

/** The backend's limit (employer-membership.ts COMPANY_NAME_MAX). */
const COMPANY_NAME_MAX = 120;

const NAME_INPUT_ID = 'access-company-name';
const START_ERROR_ID = 'access-company-name-error';

type StartError = 'invalid_company_name' | 'busy' | 'generic';

/** The URL's reason, or null when it named none (the screen then waits for membership). */
function parseReason(raw: string | null): MembershipBlockedReason | null {
    return raw === 'suspended' || raw === 'removed' || raw === 'no_organization' ? raw : null;
}

/**
 * `/employer/access` (Phase 3): an employer login the company's account
 * refuses. `useRequireAuth().handleLegalWall` sends a `MembershipBlockedError`
 * here as `?reason=suspended|removed|no_organization[&invite=1]`, or with no
 * query at all when the 403 named no status.
 *
 * On arrival the page drops the cached membership and re-reads it: GET
 * `/employer/team/membership` always names the status and whether a re-invite
 * is waiting. Until it answers, a URL with a reason paints that reason; one
 * without paints the loading card, and if the read then fails for any reason
 * other than "blocked", an error card with Retry. An active answer (an invite
 * was accepted meanwhile) goes to the dashboard -- at most once per page load
 * (`takeAccessRedirect`), so a route that keeps answering 403 cannot bounce
 * the login between the two screens forever.
 *
 * `no_organization` also offers "start my own company". A 409
 * `already_member` there means an invite accept landed first: membership is
 * re-read and the login goes to the dashboard, with no error.
 *
 * With the team flag off the route does not exist (Phase 2 had none), so it
 * answers not-found and makes no request.
 */
export default function EmployerAccessPage() {
    if (!isTeamManagementEnabled()) notFound();
    return <AccessScreen />;
}

function AccessScreen() {
    const t = useTranslations('employer_access');
    const tCommon = useTranslations('common');
    const searchParams = useSearchParams();
    const router = useRouter();
    const { logout } = useAuth();
    const { idToken, handleLegalWall } = useRequireAuth({ role: 'employer' });

    const [reason, setReason] = useState<MembershipBlockedReason | null>(() => parseReason(searchParams.get('reason')));
    const [hasInvite, setHasInvite] = useState(() => searchParams.get('invite') === '1');
    const [companyName, setCompanyName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [startError, setStartError] = useState<StartError | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    // A membership read that failed for a reason other than "blocked", while
    // the URL named no reason: the error card, with Retry (M4).
    const [loadError, setLoadError] = useState<ErrorKind | null>(null);
    const [attempt, setAttempt] = useState(0);
    const nameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!idToken) return;
        let live = true;
        // Whatever the answer, the cached one is stale: it is why we are here.
        clearEmployerMembershipCache();
        getMembership(idToken).then(
            () => {
                if (!live) return;
                if (takeAccessRedirect()) {
                    router.replace('/employer/dashboard');
                } else {
                    // Already bounced once this page load: stay, with sign-out.
                    setReason((current) => current ?? 'suspended');
                }
            },
            (err: unknown) => {
                if (!live) return;
                if (isMembershipBlockedError(err)) {
                    // A real blocked state: a later recovery may redirect again.
                    resetAccessRedirectGuard();
                    setReason(err.reason);
                    setHasInvite(err.hasInvite);
                } else {
                    // Any other failure (offline, a 500, a second `busy`) says
                    // nothing about the membership: a reason the URL named
                    // stays; with none, the error card offers Retry rather
                    // than guessing "paused".
                    setLoadError(classifyError(err).kind);
                }
            },
        );
        return () => {
            live = false;
        };
    }, [idToken, router, attempt]);

    const retryMembership = () => {
        setLoadError(null);
        setAttempt((n) => n + 1);
    };

    const goToDashboard = () => {
        clearEmployerMembershipCache();
        resetAccessRedirectGuard();
        router.replace('/employer/dashboard');
    };

    /** After a 409 already_member: false only when membership says the login is blocked after all. */
    const goToDashboardUnlessBlocked = async (token: string): Promise<boolean> => {
        try {
            await getMembership(token);
        } catch (err) {
            if (isMembershipBlockedError(err)) {
                setReason(err.reason);
                setHasInvite(err.hasInvite);
                return false;
            }
            // The 409 already said a membership exists; the re-read failing
            // for another reason does not undo that.
        }
        goToDashboard();
        return true;
    };

    const handleStart = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!idToken || submitting) return;
        const name = companyName.trim();
        if (name.length < 1 || name.length > COMPANY_NAME_MAX) {
            setStartError('invalid_company_name');
            nameInputRef.current?.focus();
            return;
        }
        setStartError(null);
        setSubmitting(true);
        try {
            await startCompany(idToken, name);
            clearEmployerMembershipCache();
            resetAccessRedirectGuard();
            // `submitting` stays true: the button stays disabled until the
            // navigation unmounts this page.
            router.replace('/employer/profile');
            return;
        } catch (err) {
            if (isLegalWallError(err)) {
                handleLegalWall(err, legalReturnPath());
                return;
            }
            if (err instanceof ApiError && err.code === 'already_member') {
                // An invite accept landed first: that company is theirs now.
                if (await goToDashboardUnlessBlocked(idToken)) return;
                setSubmitting(false);
                return;
            }
            setStartError(
                err instanceof ApiError && (err.code === 'invalid_company_name' || err.code === 'busy')
                    ? err.code
                    : 'generic',
            );
            setSubmitting(false);
        }
    };

    const handleSignOut = async () => {
        setSigningOut(true);
        clearEmployerMembershipCache();
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    };

    const signOutButton = (
        <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleSignOut}
            loading={signingOut}
            loadingLabel={tCommon('loading')}
        >
            {t('sign_out')}
        </Button>
    );

    if (reason === null && loadError !== null) {
        return (
            <main className={FRAME}>
                <DashboardPanel as="div" className={CARD}>
                    <div>
                        <h1 className="mb-2 text-xl font-extrabold leading-[1.3] tracking-[-0.02em] text-[var(--jale-ink)]">
                            {tCommon('error_state.title')}
                        </h1>
                        <p className="text-sm text-[var(--jale-ink-2)]">{tCommon(errorMessageKey(loadError))}</p>
                    </div>
                    <Button type="button" className="w-full" onClick={retryMembership}>
                        {tCommon('retry')}
                    </Button>
                    {signOutButton}
                </DashboardPanel>
            </main>
        );
    }

    if (reason === null) {
        return (
            <main className={FRAME}>
                <CenteredCardSkeleton title />
            </main>
        );
    }

    return (
        <main className={FRAME}>
            <DashboardPanel as="div" className={CARD}>
                <div>
                    <h1 className="mb-2 text-xl font-extrabold leading-[1.3] tracking-[-0.02em] text-[var(--jale-ink)]">
                        {t(`${reason}.title`)}
                    </h1>
                    <p className="text-sm text-[var(--jale-ink-2)]">{t(`${reason}.body`)}</p>
                </div>

                {reason === 'removed' && hasInvite ? (
                    <InlineFeedback tone="info">{t('removed.has_invite')}</InlineFeedback>
                ) : null}

                {reason === 'no_organization' ? (
                    <form className="space-y-3 border-t border-[var(--jale-divider)] pt-6" onSubmit={handleStart} noValidate>
                        <h2 className="text-base font-bold text-[var(--jale-ink)]">{t('no_organization.start_title')}</h2>
                        <div className="space-y-1.5">
                            <label htmlFor={NAME_INPUT_ID} className="block text-sm font-semibold text-[var(--jale-ink)]">
                                {t('no_organization.start_name')}
                            </label>
                            <Input
                                ref={nameInputRef}
                                id={NAME_INPUT_ID}
                                name="companyName"
                                autoComplete="organization"
                                maxLength={COMPANY_NAME_MAX}
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                aria-invalid={startError === 'invalid_company_name' || undefined}
                                aria-describedby={startError ? START_ERROR_ID : undefined}
                            />
                        </div>
                        {startError ? (
                            <InlineFeedback tone="danger" onDismiss={() => setStartError(null)}>
                                <span id={START_ERROR_ID}>{t(`errors.${startError}`)}</span>
                            </InlineFeedback>
                        ) : null}
                        <Button type="submit" className="w-full" loading={submitting} loadingLabel={tCommon('loading')}>
                            {t('no_organization.start_submit')}
                        </Button>
                    </form>
                ) : null}

                {signOutButton}
            </DashboardPanel>
        </main>
    );
}

/**
 * This screen, with its query and WITHOUT a locale: `legalReturnUrl` goes
 * through next-intl's router, which adds the locale itself (the address bar's
 * `/en/employer/access` became `/en/en/…`, a 404).
 */
function legalReturnPath(): string {
    return `${ACCESS_PAGE_PATH}${typeof window === 'undefined' ? '' : window.location.search}`;
}
