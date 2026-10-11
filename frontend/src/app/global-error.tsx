'use client';

import './globals.css';

/**
 * Last-resort boundary: catches errors thrown by the ROOT layout itself, which
 * is the one place `[locale]/error.tsx` cannot reach. Because the layout failed,
 * this component has to supply its own `<html>` and `<body>` -- and it has no
 * providers, so no `NextIntlClientProvider`, no locale and no `useTranslations`.
 *
 * That is why the copy is hardcoded in BOTH languages rather than translated:
 * there is no way to know which locale the user was on, and showing a key path
 * or an English-only sentence to a Spanish-speaking worker is worse than showing
 * two short lines.
 *
 * Styling is inline for the same reason the copy is static: if the stylesheet
 * import above failed to load, this page still has to be readable. The token
 * `var(..., fallback)` pairs render correctly with the stylesheet and degrade to
 * the literal light-theme values without it. The dark theme deliberately does
 * not apply here -- the init script lives in the layout that just failed.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <html lang="en">
            <body
                style={{
                    margin: 0,
                    minHeight: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '2rem 1rem',
                    backgroundColor: 'var(--jale-paper, #e3eaf2)',
                    color: 'var(--jale-ink, #181855)',
                    fontFamily:
                        "'Lexend', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                    WebkitFontSmoothing: 'antialiased',
                }}
            >
                <div role="alert" style={{ width: '100%', maxWidth: '24rem', textAlign: 'center' }}>
                    <p
                        style={{
                            margin: '0 0 1.5rem',
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            letterSpacing: '-0.03em',
                            lineHeight: 1,
                            color: 'var(--jale-blue-500, #0179FF)',
                        }}
                    >
                        Jale
                    </p>

                    <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600 }}>
                        Something went wrong. Please reload the page.
                    </p>
                    <p
                        style={{
                            margin: '0.5rem 0 0',
                            fontSize: '0.875rem',
                            color: 'var(--jale-ink-2, #5b6480)',
                        }}
                    >
                        Algo salió mal. Por favor recarga la página.
                    </p>

                    <button
                        type="button"
                        onClick={reset}
                        style={{
                            marginTop: '1.5rem',
                            minHeight: 44,
                            padding: '0 1.25rem',
                            borderRadius: 9999,
                            border: 'none',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            fontSize: '0.875rem',
                            fontWeight: 600,
                            color: '#ffffff',
                            backgroundColor: 'var(--jale-blue-500, #0179FF)',
                        }}
                    >
                        Reload / Recargar
                    </button>
                </div>
            </body>
        </html>
    );
}
