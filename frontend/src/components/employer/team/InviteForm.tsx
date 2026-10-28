'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { PanelHeader } from '@/components/ui/panel-header';
import type { TeamActionResult } from './types';
import { useNow } from './useNow';

/** The backend's contact-name limit (`invalid_contact_name` above it). */
const CONTACT_NAME_MAX = 120;

const EMAIL_ID = 'team-invite-email';
const NAME_ID = 'team-invite-name';
const ERROR_ID = 'team-invite-error';
const SEATS_FULL_ID = 'team-invite-seats-full';

/** Refusals about the email field; `invalid_contact_name` is the name's. Anything else is about neither. */
const EMAIL_CODES: ReadonlySet<string> = new Set(['invalid_email', 'email_in_use', 'already_member', 'invite_pending']);

type Field = 'email' | 'name' | null;

function fieldOf(code: string | undefined): Field {
    if (code === undefined) return null;
    if (EMAIL_CODES.has(code)) return 'email';
    return code === 'invalid_contact_name' ? 'name' : null;
}

/**
 * "Invite a foreman": email (required) and name (optional).
 *
 * The page sends the invite (with the page locale), toasts and refetches; this
 * form only validates that an email was typed, keeps the button busy, clears
 * itself on success, and shows a refusal inline. The refusal is linked with
 * `aria-describedby` to the field it is about (both when it is about neither),
 * and only that field is marked `aria-invalid`.
 *
 * - `seatsFull`: every seat is used or promised. Send is disabled and the
 *   remedy is shown (remove a member or revoke an invite).
 * - A rate limit (`retryAfterSeconds`) disables Send for that long; the error
 *   stays on screen (no dismiss) until the wait is over.
 */
export function InviteForm({
    onInvite,
    seatsFull = false,
}: {
    onInvite: (input: { email: string; contactName?: string }) => Promise<TeamActionResult>;
    seatsFull?: boolean;
}) {
    const t = useTranslations('employer_team');
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<{ message: string; field: Field } | null>(null);
    const [cooldownUntil, setCooldownUntil] = useState(0);
    const now = useNow([cooldownUntil]);
    const coolingDown = cooldownUntil > now;
    const emailRef = useRef<HTMLInputElement>(null);
    // A ref, not state: two clicks in one tick both see `submitting === false`.
    const inFlightRef = useRef(false);

    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (inFlightRef.current || seatsFull || cooldownUntil > Date.now()) return;
        const trimmedEmail = email.trim();
        if (!trimmedEmail) {
            setError({ message: t('errors.invalid_email'), field: 'email' });
            emailRef.current?.focus();
            return;
        }
        const trimmedName = name.trim();
        inFlightRef.current = true;
        setSubmitting(true);
        setError(null);
        try {
            const result = await onInvite(
                trimmedName ? { email: trimmedEmail, contactName: trimmedName } : { email: trimmedEmail },
            );
            if (result.ok) {
                setEmail('');
                setName('');
            } else {
                if (result.message) setError({ message: result.message, field: fieldOf(result.code) });
                if (result.retryAfterSeconds !== undefined) {
                    setCooldownUntil(Date.now() + result.retryAfterSeconds * 1000);
                }
            }
        } finally {
            inFlightRef.current = false;
            setSubmitting(false);
        }
    }

    const emailDescribedBy = error && error.field !== 'name' ? ERROR_ID : undefined;
    const nameDescribedBy = error && error.field !== 'email' ? ERROR_ID : undefined;
    const submitDescribedBy = [seatsFull ? SEATS_FULL_ID : null, coolingDown && error ? ERROR_ID : null]
        .filter(Boolean)
        .join(' ') || undefined;

    return (
        <DashboardPanel>
            <PanelHeader title={t('invite.title')} />
            <form className="space-y-4 px-5 py-4" onSubmit={handleSubmit} noValidate>
                {seatsFull ? (
                    <InlineFeedback tone="warning">
                        <span id={SEATS_FULL_ID}>{t('invite.seats_full')}</span>
                    </InlineFeedback>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                        <label htmlFor={EMAIL_ID} className="block text-sm font-semibold text-[var(--jale-ink)]">
                            {t('invite.email')}
                        </label>
                        <Input
                            ref={emailRef}
                            id={EMAIL_ID}
                            name="email"
                            type="email"
                            autoComplete="off"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            aria-invalid={error?.field === 'email' ? true : undefined}
                            aria-describedby={emailDescribedBy}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor={NAME_ID} className="block text-sm font-semibold text-[var(--jale-ink)]">
                            {t('invite.name')}
                        </label>
                        <Input
                            id={NAME_ID}
                            name="contactName"
                            autoComplete="off"
                            maxLength={CONTACT_NAME_MAX}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            aria-invalid={error?.field === 'name' ? true : undefined}
                            aria-describedby={nameDescribedBy}
                        />
                    </div>
                </div>
                {error ? (
                    <InlineFeedback tone="danger" onDismiss={coolingDown ? undefined : () => setError(null)}>
                        <span id={ERROR_ID}>{error.message}</span>
                    </InlineFeedback>
                ) : null}
                <Button
                    type="submit"
                    loading={submitting}
                    disabled={seatsFull || coolingDown}
                    aria-describedby={submitDescribedBy}
                >
                    {t('invite.submit')}
                </Button>
            </form>
        </DashboardPanel>
    );
}
