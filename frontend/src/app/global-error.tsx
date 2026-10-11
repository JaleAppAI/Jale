'use client';

import './globals.css';
import { SUPPORT_CONTACT } from '@/lib/support-contact';

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
 *
 * "Report a problem" cannot open here (it needs the providers that just
 * failed), so the page names the other ways to reach the team instead: the
 * support address the legal pages publish and the WhatsApp keyword. Static
 * text, no form.
 */
const helpStyle = {
    margin: '0.75rem 0 0',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: 'var(--jale-ink-2, #5b6480)',
} as const;
const mailStyle = {
    color: 'var(--jale-blue-700, #0050ad)',
    fontWeight: 600,
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    wordBreak: 'break-all',
} as const;
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
                        lang="es"
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

                    <p style={{ ...helpStyle, marginTop: '1.5rem' }}>
                        Need help? Email{' '}
                        <a href={`mailto:${SUPPORT_CONTACT.email}`} style={mailStyle}>
                            {SUPPORT_CONTACT.email}
                        </a>{' '}
                        or send “{SUPPORT_CONTACT.whatsappKeyword}” to Jale on WhatsApp.
                    </p>
                    <p lang="es" style={helpStyle}>
                        ¿Necesitas ayuda? Escribe a{' '}
                        <a href={`mailto:${SUPPORT_CONTACT.email}`} style={mailStyle}>
                            {SUPPORT_CONTACT.email}
                        </a>{' '}
                        o envía «{SUPPORT_CONTACT.whatsappKeyword}» a Jale por WhatsApp.
                    </p>
                </div>
            </body>
        </html>
    );
}
