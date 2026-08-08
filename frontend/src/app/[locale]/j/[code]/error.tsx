'use client';

import { ErrorState } from '@/components/ui/error-state';

// Catches anything getPublicJob() throws that is NOT a
// PublicJobNotFoundError (that case calls notFound() and never reaches this
// boundary). A 5xx from the API, a network failure, etc. land here instead of
// a blank/dead page.
//
// Still a valid client error boundary: `'use client'` above, a default export
// taking `{ error, reset }`. `ErrorState` is itself a client component, so
// rendering it here needs no bridge -- and using it means this page fails in
// the same words, in both locales, as every other failure in the app.
//
// `kind="server"` rather than `unknown`: everything that reaches this boundary
// came from the one fetch this route makes, and `server` is the only kind that
// is both retryable (so `reset` is offered) and honest about a page whose data
// call did not come back.
export default function PublicJobError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--jale-paper)] px-4 py-12">
      <div className="mx-auto w-full max-w-sm">
        {/* The wordmark utility, not a literal navy: `--jale-blue-900` does not
            flip in the dark theme, so navy-on-navy would erase it there. */}
        <p className="jale-wordmark text-center">Jale</p>
        <ErrorState kind="server" onRetry={reset} compact />
      </div>
    </div>
  );
}
