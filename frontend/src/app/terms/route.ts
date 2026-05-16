export const runtime = 'nodejs';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JaleApp.AI SMS Terms</title>
  </head>
  <body>
    <main>
      <h1>JaleApp.AI SMS Terms and Conditions</h1>
      <p>JaleApp.AI SMS messages are used for account verification and authentication, including one-time passcodes and sign-in verification codes for JaleApp.AI worker accounts.</p>
      <p>Message frequency varies based on account activity. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>
      <p>Reply HELP for help. Reply STOP to opt out.</p>
      <p>For support, contact support@jaleapp.ai.</p>
      <p>Privacy Policy: <a href="https://www.jaleapp.ai/privacypolicy">https://www.jaleapp.ai/privacypolicy</a></p>
      <p>Full Terms and Conditions: <a href="https://www.jaleapp.ai/legal/terms">https://www.jaleapp.ai/legal/terms</a></p>
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
