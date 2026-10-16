'use client';

/**
 * Last resort: the root layout itself failed. This replaces it, so it brings
 * its own <html> and <body>, uses no providers and imports no stylesheet.
 * Inline styles with the light-theme token values as fallbacks keep it
 * readable even if the stylesheet never loaded. Logs nothing.
 */
const page = {
  margin: 0,
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1rem',
  backgroundColor: 'var(--jale-shell, #eef2f7)',
  color: 'var(--jale-ink, #181855)',
  fontFamily: "var(--font-lexend, 'Lexend'), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} as const;

const button = {
  marginTop: '1.25rem',
  height: '2.75rem',
  padding: '0 1.25rem',
  border: 0,
  borderRadius: '9999px',
  backgroundColor: 'var(--jale-blue-500, #0064d6)',
  color: '#ffffff',
  font: 'inherit',
  fontSize: '0.875rem',
  fontWeight: 600,
  cursor: 'pointer',
} as const;

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={page}>
        <main style={{ width: '100%', maxWidth: '24rem', textAlign: 'center' }}>
          <div role="alert">
            <p style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>Something went wrong</p>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', lineHeight: 1.5, color: 'var(--jale-ink-2, #5b6480)' }}>
              The admin console hit an error it could not recover from. Try again, or reload the page.
            </p>
          </div>
          <button type="button" onClick={reset} style={button}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
