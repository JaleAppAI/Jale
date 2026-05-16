export const runtime = 'nodejs';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JaleApp.AI Privacy Policy</title>
  </head>
  <body>
    <main>
      <h1>JaleApp.AI Privacy Policy</h1>
      <p>JaleApp.AI collects information users provide when creating and managing their accounts, including mobile phone numbers used for account verification and authentication SMS messages.</p>
      <p>JaleApp.AI uses mobile phone numbers to send requested one-time passcodes, sign-in verification codes, and account authentication messages.</p>
      <p>JaleApp.AI does not sell, rent, or share mobile phone numbers or SMS opt-in consent data with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties except as necessary to provide messaging services.</p>
      <p>SMS Terms: <a href="https://www.jaleapp.ai/terms">https://www.jaleapp.ai/terms</a></p>
      <p>Full Privacy Policy: <a href="https://www.jaleapp.ai/legal/privacy">https://www.jaleapp.ai/legal/privacy</a></p>
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
