export const runtime = 'nodejs';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JaleApp.AI Privacy Policy</title>
    <style>
      :root {
        --jale-blue-50: #eaf2ff;
        --jale-blue-500: #0064d6;
        --jale-blue-600: #0064d6;
        --jale-blue-900: #181855;
        --jale-teal-50: #e3faf4;
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
        background: var(--jale-teal-50);
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
        max-width: 770px;
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

      .notice strong {
        color: var(--jale-blue-900);
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
        <div class="badge">Privacy policy for JaleApp.AI</div>
      </div>

      <div class="hero">
        <h1>Privacy policy</h1>
        <p class="lead">This page summarizes how JaleApp.AI handles mobile information and SMS consent for account verification messages.</p>
      </div>

      <article class="panel">
        <div class="summary">
          <div>
            <span>Information collected</span>
            <strong>Account details and mobile phone numbers</strong>
          </div>
          <div>
            <span>SMS purpose</span>
            <strong>One-time passcodes and account authentication</strong>
          </div>
          <div>
            <span>Consent data</span>
            <strong>Not shared for marketing</strong>
          </div>
        </div>

        <div class="content">
          <section>
            <h2>Information JaleApp.AI collects</h2>
            <p>JaleApp.AI collects information users provide when creating and managing their accounts, including names, account contact information, profile details, and mobile phone numbers used for account verification and authentication SMS messages.</p>
            <p>For worker accounts, JaleApp.AI may also collect job-search profile information needed to support account onboarding and job platform features.</p>
          </section>

          <section>
            <h2>How mobile information is used</h2>
            <p>JaleApp.AI uses mobile phone numbers to send requested one-time passcodes, sign-in verification codes, and account authentication messages.</p>
            <p>JaleApp.AI sends these SMS messages when a user provides a mobile phone number during worker account creation, sign-in, or account verification and requests a verification code.</p>
          </section>

          <section>
            <h2>SMS consent and data sharing</h2>
            <div class="notice">
              <p><strong>Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes.</strong></p>
              <p><strong>JaleApp.AI does not sell, rent, or share mobile phone numbers or SMS opt-in consent data with third parties or affiliates for marketing or promotional purposes.</strong></p>
              <p>Text messaging originator opt-in data and consent will not be shared with third parties or affiliates for marketing or promotional purposes.</p>
            </div>
          </section>

          <section>
            <h2>Service providers</h2>
            <p>JaleApp.AI may use service providers to operate the platform, deliver authentication messages, host documents, protect accounts, and provide customer support. These providers are used to deliver the requested service and are not permitted to use mobile opt-in consent data for their own marketing.</p>
          </section>

          <section>
            <h2>User choices</h2>
            <ul>
              <li>Reply <strong>STOP</strong> to opt out of SMS messages.</li>
              <li>Reply <strong>HELP</strong> for help.</li>
              <li>Contact <a href="mailto:support@jaleapp.ai">support@jaleapp.ai</a> for support or privacy questions.</li>
            </ul>
          </section>

          <section>
            <h2>Related documents</h2>
            <div class="links">
              <a class="link-button" href="https://www.jaleapp.ai/terms">SMS Terms</a>
              <a class="link-button secondary" href="https://www.jaleapp.ai/legal/privacy">Full Privacy Policy PDF</a>
            </div>
          </section>
        </div>
      </article>

      <p class="footer">JaleApp.AI is a bilingual job platform for workers and employers. This privacy summary is provided for public SMS compliance review and links to the full policy.</p>
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
