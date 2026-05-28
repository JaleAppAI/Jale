export const runtime = 'nodejs';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JaleApp.AI SMS Terms</title>
    <style>
      :root {
        --jale-blue-50: #eaf2ff;
        --jale-blue-500: #0179ff;
        --jale-blue-600: #0064d6;
        --jale-blue-900: #181855;
        --jale-teal-500: #21c3a4;
        --jale-paper: #e3eaf2;
        --jale-paper-2: #f4f6fa;
        --jale-card: #fbfcff;
        --jale-divider: #d8dde6;
        --jale-ink: #181855;
        --jale-ink-2: #5b6480;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background-color: var(--jale-paper);
        background-image: radial-gradient(circle, #6b7da4 0.7px, transparent 0.7px);
        background-size: 28px 28px;
        color: var(--jale-ink);
        font-family: Lexend, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.6;
      }

      a {
        color: var(--jale-blue-600);
        font-weight: 700;
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.18em;
      }

      .shell {
        margin: 0 auto;
        max-width: 980px;
        padding: 28px 18px 52px;
      }

      .topbar {
        align-items: center;
        display: flex;
        justify-content: space-between;
        margin-bottom: 44px;
      }

      .wordmark {
        color: var(--jale-blue-500);
        display: inline-flex;
        font-size: 1.55rem;
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1;
        text-decoration: none;
      }

      .badge {
        background: var(--jale-blue-50);
        border: 1px solid var(--jale-divider);
        border-radius: 999px;
        color: var(--jale-blue-900);
        font-size: 0.78rem;
        font-weight: 700;
        padding: 7px 12px;
      }

      .hero {
        display: grid;
        gap: 20px;
        margin-bottom: 26px;
      }

      h1 {
        font-size: clamp(2.15rem, 6vw, 4.65rem);
        letter-spacing: -0.055em;
        line-height: 0.95;
        margin: 0;
        max-width: 760px;
      }

      .lead {
        color: var(--jale-ink-2);
        font-size: clamp(1.02rem, 2.2vw, 1.24rem);
        font-weight: 500;
        margin: 0;
        max-width: 730px;
      }

      .panel {
        background: var(--jale-card);
        border: 1px solid var(--jale-divider);
        border-radius: 8px;
        box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 14px 38px rgba(24,24,85,.08);
        margin-top: 18px;
        overflow: hidden;
      }

      .summary {
        background: var(--jale-blue-900);
        color: #f8fbff;
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        padding: 22px;
      }

      .summary span {
        color: #cfe0ff;
        display: block;
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin-bottom: 4px;
      }

      .summary strong {
        display: block;
        font-size: 0.96rem;
      }

      .content {
        display: grid;
        gap: 26px;
        padding: 28px;
      }

      section {
        max-width: 760px;
      }

      h2 {
        font-size: 1rem;
        letter-spacing: -0.015em;
        line-height: 1.25;
        margin: 0 0 8px;
      }

      p {
        margin: 0 0 10px;
      }

      ul {
        margin: 10px 0 0;
        padding-left: 1.15rem;
      }

      li + li {
        margin-top: 7px;
      }

      .notice {
        background: var(--jale-paper-2);
        border: 1px solid var(--jale-divider);
        border-radius: 8px;
        padding: 16px;
      }

      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .link-button {
        align-items: center;
        background: var(--jale-blue-500);
        border-radius: 999px;
        color: #f8fbff;
        display: inline-flex;
        font-size: 0.9rem;
        min-height: 40px;
        padding: 9px 15px;
        text-decoration: none;
      }

      .link-button.secondary {
        background: var(--jale-blue-50);
        color: var(--jale-blue-900);
      }

      .footer {
        color: var(--jale-ink-2);
        font-size: 0.84rem;
        margin-top: 18px;
      }

      @media (max-width: 720px) {
        .topbar {
          align-items: flex-start;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 32px;
        }

        .summary {
          grid-template-columns: 1fr;
        }

        .content {
          padding: 20px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="topbar">
        <a class="wordmark" href="https://www.jaleapp.ai/" aria-label="Go to JaleApp.AI home">Jale</a>
        <div class="badge">SMS terms for JaleApp.AI</div>
      </div>

      <div class="hero">
        <h1>SMS terms and conditions</h1>
        <p class="lead">JaleApp.AI sends authentication messages to workers who request account verification or sign-in access.</p>
      </div>

      <article class="panel">
        <div class="summary">
          <div>
            <span>Program</span>
            <strong>JaleApp.AI account verification</strong>
          </div>
          <div>
            <span>Message type</span>
            <strong>One-time passcodes and sign-in codes</strong>
          </div>
          <div>
            <span>Frequency</span>
            <strong>Varies by account activity</strong>
          </div>
        </div>

        <div class="content">
          <section>
            <h2>Program description</h2>
            <p>JaleApp.AI SMS messages are used for account verification and authentication, including one-time passcodes and sign-in verification codes for JaleApp.AI worker accounts.</p>
            <p>These messages are transactional security messages. They are not marketing or promotional messages.</p>
          </section>

          <section>
            <h2>Consent to receive SMS messages</h2>
            <p>Workers consent to receive JaleApp.AI authentication text messages when they enter their mobile phone number during worker account creation, sign-in, or account verification and request a one-time passcode.</p>
            <p>JaleApp.AI sends a text message only after the user initiates the verification or sign-in flow.</p>
          </section>

          <section>
            <h2>Message frequency and charges</h2>
            <p>Message frequency varies based on account activity. A worker may receive one or more messages when requesting account verification or signing in.</p>
            <p><strong>Message and data rates may apply.</strong> Carriers are not liable for delayed or undelivered messages.</p>
          </section>

          <section>
            <h2>Help and opt-out instructions</h2>
            <div class="notice">
              <p>Reply <strong>HELP</strong> for help.</p>
              <p>Reply <strong>STOP</strong> to opt out of SMS messages.</p>
              <p>For support, contact <a href="mailto:support@jaleapp.ai">support@jaleapp.ai</a>.</p>
            </div>
          </section>

          <section>
            <h2>Related documents</h2>
            <div class="links">
              <a class="link-button" href="https://www.jaleapp.ai/privacypolicy">Privacy Policy</a>
              <a class="link-button secondary" href="https://www.jaleapp.ai/legal/terms">Full Terms and Conditions PDF</a>
            </div>
          </section>
        </div>
      </article>

      <p class="footer">JaleApp.AI is a bilingual job platform for workers and employers. These SMS terms apply to account verification and authentication messages.</p>
    </main>
  </body>
</html>`;

export async function GET() {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'index, follow',
    },
  });
}
