import 'dotenv/config';
import http from 'node:http';
import Stripe from 'stripe';

const secret = process.env.SPIKE_WEBHOOK_SIGNING_SECRET;
const accountId = process.env.SPIKE_CONNECTED_ACCOUNT_ID;
if (!secret?.startsWith('whsec_')) throw new Error('SPIKE_WEBHOOK_SIGNING_SECRET missing');
if (!accountId) throw new Error('SPIKE_CONNECTED_ACCOUNT_ID missing');

const platformRequired = new Set([
  'checkout.session.completed',
  'payment_intent.succeeded',
  'transfer.created',
]);
const connectRequired = new Set(['account.updated', 'payout.created']);
const platformSeen = new Set<string>();
const connectSeen = new Set<string>();
const safeEvidence: Array<{ id: string; type: string; scope: string; account?: string }> = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks);
      const signature = String(req.headers['stripe-signature'] ?? '');
      const evt = Stripe.webhooks.constructEvent(raw, signature, secret);
      const isConnect = req.url === '/connect-webhook';
      if (isConnect) {
        if (evt.account !== accountId) throw new Error('connected-account event scope mismatch');
        connectSeen.add(evt.type);
      } else {
        platformSeen.add(evt.type);
      }
      safeEvidence.push({ id: evt.id, type: evt.type, scope: isConnect ? 'connect' : 'platform', account: evt.account });
      console.log('verified event', safeEvidence.at(-1)); // safe IDs/types only; never log raw bodies
      res.writeHead(200).end('ok');
    } catch (err) {
      // Log the failure reason (message only — never the raw body/signature) so a
      // signing-secret mismatch or scope error is visible instead of silently 400ing.
      console.log('REJECTED request', { url: req.url, reason: err instanceof Error ? err.message : 'unknown' });
      res.writeHead(400).end('invalid signature or scope');
    }
  });
});

// Bind explicitly to IPv4 127.0.0.1: on Windows `localhost` may resolve to IPv6 ::1,
// which would silently drop stripe-CLI forwards. Forward with --forward-to 127.0.0.1:4242.
server.listen(4242, '127.0.0.1', () => {
  console.log('Listening for 180s on 127.0.0.1:4242. Run the real proof actions from the operator terminal.');
  setTimeout(() => {
    const missing = [
      ...[...platformRequired].filter((type) => !platformSeen.has(type)),
      ...[...connectRequired].filter((type) => !connectSeen.has(type)),
    ];
    console.log('Safe evidence:', safeEvidence);
    console.log(missing.length === 0 ? 'WEBHOOK PROOF: PASS' : `WEBHOOK PROOF: FAIL missing=${missing.join(',')}`);
    server.close();
    process.exit(missing.length === 0 ? 0 : 1);
  }, 180_000);
});
