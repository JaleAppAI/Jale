'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { notFound } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import EmployerAuthForm, { EmployerBrandPanel, settleInviteAccept, type EmployerInvite } from '@/components/auth/EmployerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';
import { ApiError } from '@/lib/api/errors';
import { lookupInvite } from '@/lib/api/team';
import { clearEmployerMembershipCache } from '@/lib/employer-membership-store';
import { clearPendingInvite, readPendingInvite, storePendingInvite } from '@/lib/employer-profile-flush';
import { isTeamManagementEnabled } from '@/lib/feature-flags';

export const dynamic = 'force-dynamic';

/** A lookup failure's copy, inside `auth.employer.invite`. */
type LookupFailure = 'not_found' | 'expired' | 'revoked' | 'used' | 'busy' | 'generic';

/** The answers that settle the invite for good: the stored copy is dropped with them. */
const FINAL_FAILURES: ReadonlySet<LookupFailure> = new Set(['not_found', 'expired', 'revoked', 'used']);

function lookupFailure(err: unknown): LookupFailure {
    if (!(err instanceof ApiError)) return 'generic';
    switch (err.code) {
        case 'invite_not_found': return 'not_found';
        case 'invite_expired': return 'expired';
        case 'invite_revoked': return 'revoked';
        case 'invite_used': return 'used';
        case 'busy': return 'busy';
        default: return 'generic';
    }
}

type View =
    | { status: 'loading' }
    | { status: 'ready'; invite: EmployerInvite }
    | { status: 'failed'; reason: LookupFailure };

/**
 * Takes the token out of the address bar, whatever else happens next, and
 * hands it back. The whole query goes: nothing else belongs on this page's
 * address. `replaceState(null, …)`: Next's history patch syncs its router to
 * the new URL only for a state that is not already its own.
 */
function takeTokenFromAddress(): string | null {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token')?.trim() || null;
    if (url.search) window.history.replaceState(null, '', url.pathname);
    return token;
}

/**
 * `/{locale}/auth/employer/invite?token=…` (Phase 3): the link in an invite
 * email.
 *
 * On arrival the token leaves the address bar before the lookup goes out
 * (the layout also sets `referrer: no-referrer`). The public lookup names the
 * company and the invited address. A valid invite is stored as
 * `{ token, email }` in sessionStorage, so a reload, which no longer has the
 * token in its address, finds it there, and the employer form opens in
 * invite mode:
 *   - a new account signs up as a foreman, its confirm carrying the token;
 *   - an existing account (`existingAccount`) signs in, then accepts.
 * A dead invite (404, 410) clears the stored copy and says why.
 *
 * With the team flag off the route does not exist (Phase 2 had none): it
 * answers not-found, reads nothing and asks nothing.
 */
export default function EmployerInvitePage() {
    if (!isTeamManagementEnabled()) notFound();
    return <InviteScreen />;
}

function InviteScreen() {
    const t = useTranslations('auth.employer');
    const { isAuthenticated, isLoading: authLoading, userType } = useAuth();
    const [view, setView] = useState<View>({ status: 'loading' });
    // "Use another account" on the one-click join: show the sign-in form.
    const [showForm, setShowForm] = useState(false);
    // Read once per mount, and kept across StrictMode's second effect run: by
    // then the address no longer has the token.
    const tokenRef = useRef<string | null | undefined>(undefined);

    // A layout effect, so the address is cleaned before the first paint.
    useLayoutEffect(() => {
        if (tokenRef.current === undefined) {
            tokenRef.current = takeTokenFromAddress() ?? readPendingInvite()?.token ?? null;
        }
        const token = tokenRef.current;
        const controller = new AbortController();
        const lookup = token
            ? lookupInvite(token, controller.signal)
            : Promise.reject(new ApiError(404, 'invite_not_found'));
        lookup.then(
            (found) => {
                if (controller.signal.aborted || !token) return;
                const email = found.email.trim().toLowerCase();
                storePendingInvite({ token, email });
                setView({
                    status: 'ready',
                    invite: {
                        token,
                        email,
                        companyName: found.companyName,
                        contactName: found.contactName,
                        existingAccount: found.existingAccount,
                    },
                });
            },
            (err: unknown) => {
                if (controller.signal.aborted) return;
                const reason = lookupFailure(err);
                // A busy or failed lookup may work on a retry; keep the token for it.
                if (FINAL_FAILURES.has(reason)) clearPendingInvite();
                setView({ status: 'failed', reason });
            },
        );
        return () => controller.abort();
    }, []);

    // Also while the session is being restored: the screen depends on it.
    if (view.status === 'loading' || authLoading) {
        return (
            <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
                <CenteredCardSkeleton title card={false} />
            </AuthShell>
        );
    }

    if (view.status === 'failed') {
        return (
            <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
                <div className="anim-fade-in flex w-full flex-col gap-6">
                    <InlineFeedback tone={view.reason === 'busy' || view.reason === 'generic' ? 'danger' : 'info'}>
                        {t(`invite.${view.reason}`)}
                    </InlineFeedback>
                    <Link
                        href="/auth/employer"
                        className="self-start text-sm font-semibold text-[var(--jale-blue-700)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                        {t('sign_in')}
                    </Link>
                </div>
            </AuthShell>
        );
    }

    // An existing account already signed in on this browser joins in one
    // click, with the session it has.
    const joinWithSession = view.invite.existingAccount && isAuthenticated && userType === 'employer' && !showForm;

    return (
        <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
            {joinWithSession ? (
                <JoinWithSession invite={view.invite} onUseAnotherAccount={() => setShowForm(true)} />
            ) : (
                <EmployerAuthForm mode="invite" invite={view.invite} />
            )}
        </AuthShell>
    );
}

/**
 * The invite for a signed-in employer: accept with the current session's id
 * token, with no sign-in and no `setTokens`. The session's email is not
 * known to be the invite's, so `invite_used` is the `used` copy here rather
 * than a redirect. A refusal (`invite_email_mismatch` for another account
 * above all) shows its copy; "use another account" shows the sign-in form,
 * whose sign-in replaces this session.
 *
 * Copy (no new strings): the heading and body are the rejoin ones; the join
 * button is `legal.accept_cta` ("Continue"), and "use another account" is
 * `auth.employer.signin_link` ("Sign in"), the closest existing keys.
 */
function JoinWithSession({ invite, onUseAnotherAccount }: { invite: EmployerInvite; onUseAnotherAccount: () => void }) {
    const t = useTranslations('auth.employer');
    const tLegal = useTranslations('legal');
    const tCommon = useTranslations('common');
    const { getValidIdTokenOrNull } = useAuth();
    const router = useRouter();
    const [joining, setJoining] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);

    const join = async () => {
        if (joining) return;
        setJoining(true);
        setRefusal(null);
        const idToken = await getValidIdTokenOrNull();
        if (!idToken) {
            // The session could not be renewed: sign in instead.
            onUseAnotherAccount();
            return;
        }
        const outcome = await settleInviteAccept(idToken, invite.token, false);
        switch (outcome.kind) {
            case 'joined':
                clearEmployerMembershipCache();
                router.replace('/employer/dashboard');
                return; // `joining` stays: the button stays disabled until the navigation.
            case 'blocked':
                clearEmployerMembershipCache();
                router.replace(outcome.path);
                return;
            case 'legal_wall':
                router.replace('/legal/accept');
                return;
            case 'refused':
                setRefusal(outcome.key);
                setJoining(false);
        }
    };

    const copy = { companyName: invite.companyName, email: invite.email };
    return (
        <div className="flex w-full flex-col">
            <div className="anim-fade-in mb-8 flex flex-col gap-2">
                <h1 className="text-[clamp(1.6rem,3vw,1.9rem)] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
                    {t('invite.title', { companyName: invite.companyName })}
                </h1>
                <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{t('invite.rejoin_body', copy)}</p>
            </div>
            <div className="anim-fade-in flex flex-col gap-4">
                {refusal ? <InlineFeedback tone="danger">{t(refusal)}</InlineFeedback> : null}
                <Button type="button" className="w-full" size="lg" onClick={join} loading={joining} loadingLabel={tCommon('loading')}>
                    {tLegal('accept_cta')}
                </Button>
                <Button type="button" variant="outline" className="w-full" onClick={onUseAnotherAccount} disabled={joining}>
                    {t('signin_link')}
                </Button>
            </div>
        </div>
    );
}
