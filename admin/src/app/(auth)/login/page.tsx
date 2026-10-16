import { AdminLoginForm } from '@/components/AdminLoginForm';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { getAdminClientAuthConfig } from '@/lib/auth';
import { isDeviceTrustEnabled } from '@/lib/server/device-trust';

/**
 * Admin sign-in (prototype "Login"): one centred card, no configuration.
 * Only `reason` is read here; the form reads `next` itself after sign-in.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const expired = reason === 'expired';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <section
        aria-labelledby="sign-in-title"
        className="flex w-full max-w-[420px] flex-col gap-5 rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-8 shadow-[var(--shadow-card)]"
      >
        <div>
          <p className="text-[40px] font-extrabold leading-none tracking-[-0.02em] text-[var(--jale-ink)]">Jale</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <h1 id="sign-in-title" className="text-2xl font-extrabold tracking-[-0.02em] text-[var(--jale-ink)]">
              Admin sign-in
            </h1>
            <span className="inline-flex rounded-full bg-[var(--jale-blue-50)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--jale-blue-700)]">
              Code required
            </span>
          </div>
        </div>
        {expired ? <InlineFeedback tone="info">Your session ended. Sign in again to continue.</InlineFeedback> : null}
        <AdminLoginForm authConfig={getAdminClientAuthConfig()} deviceTrustEnabled={isDeviceTrustEnabled()} />
      </section>
      <p className="text-xs text-[var(--jale-ink-2)]">For Jale staff only. Every sign-in is logged.</p>
    </div>
  );
}
