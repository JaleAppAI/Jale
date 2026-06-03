export const runtime = 'nodejs';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JaleApp.AI SMS Opt-In</title>
    <style>
      :root {
        --jale-blue-50: #eaf2ff;
        --jale-blue-500: #0179ff;
        --jale-blue-600: #0064d6;
        --jale-blue-900: #181855;
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
        max-width: 790px;
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

      ol,
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
        <div class="badge">SMS opt-in for JaleApp.AI</div>
      </div>

      <div class="hero">
        <h1>SMS opt-in</h1>
        <p class="lead">This page shows how workers consent to receive JaleApp.AI SMS account verification messages.</p>
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
            <span>Consent</span>
            <strong>User-requested authentication only</strong>
          </div>
        </div>

        <div class="content">
          <section>
            <h2>Call to action</h2>
            <p>Workers opt in to receive JaleApp.AI SMS authentication messages when they actively request a one-time passcode.</p>
            <p>JaleApp.AI sends SMS account verification messages only after the worker initiates account creation, sign-in, account verification, or WhatsApp onboarding and requests a verification code.</p>
          </section>

          <section>
            <h2>Web account verification</h2>
            <ol>
              <li>The worker enters their mobile phone number during JaleApp.AI worker account creation, sign-in, or account verification.</li>
              <li>Before requesting the code, the worker is informed that JaleApp.AI sends SMS account verification messages, message frequency varies by account activity, and message and data rates may apply.</li>
              <li>The worker actively requests a one-time passcode.</li>
              <li>JaleApp.AI sends the SMS verification code for account authentication.</li>
            </ol>
          </section>

          <section>
            <h2>WhatsApp onboarding</h2>
            <ol>
              <li>The worker starts onboarding by sending "Hello" or "Hola" to JaleApp.AI on WhatsApp.</li>
              <li>During onboarding, the worker provides their mobile phone number and requests account verification.</li>
              <li>JaleApp.AI sends the SMS one-time passcode only after the worker initiates authentication.</li>
            </ol>
          </section>

          <section>
            <h2>SMS disclosures</h2>
            <div class="notice">
              <p>Message frequency varies by account activity.</p>
              <p><strong>Message and data rates may apply.</strong></p>
              <p>Reply <strong>HELP</strong> for help.</p>
              <p>Reply <strong>STOP</strong> to opt out.</p>
            </div>
          </section>

          <section>
            <h2>Consent scope</h2>
            <p>SMS consent is collected directly for JaleApp.AI account verification messages and is not bundled with marketing consent.</p>
            <p>JaleApp.AI does not send marketing or promotional SMS under this account verification campaign.</p>
            <p><strong>Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes.</strong></p>
          </section>

          <section>
            <h2>Related documents</h2>
            <div class="links">
              <a class="link-button" href="https://www.jaleapp.ai/terms">SMS Terms</a>
              <a class="link-button secondary" href="https://www.jaleapp.ai/privacypolicy">Privacy Policy</a>
            </div>
          </section>
        </div>
      </article>

      <p class="footer">JaleApp.AI is a bilingual job platform for workers and employers. This page is public so SMS campaign reviewers can verify the opt-in call to action.</p>
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
