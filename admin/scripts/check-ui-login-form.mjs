// The admin sign-in form's decisions (src/lib/login-flow.ts): when the
// "Trust this browser" box shows, what the sign-in POST carries, and where
// each answer from /api/session leads. The form (AdminLoginForm.tsx) holds the
// state and calls these. The browser never remembers a device itself: the
// server decides (K1.2).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminRoot, compileAdminSources } from './lib/check-harness.mjs';
import { ACCESS_TOKEN, ID_TOKEN, fakeDevice, fakePost, fakeSession } from './fixtures/fe3-login.mjs';

const { load } = compileAdminSources({
  name: 'fe3-login-form',
  sources: ['src/lib/login-flow.ts', 'src/components/AdminLoginForm.tsx'],
  fakes: {
    'next/link': 'scripts/fakes/next-link.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
  },
});
const flow = await load('src/lib/login-flow.ts');

const STEPS = ['credentials', 'new-password', 'mfa-setup', 'mfa'];
const SESSION_FAILED = 'Admin session could not be established.';
const TRUST_EXPIRED = 'For your security, enter a code from your authenticator app again.';

// --- The trust box: the code step only, and only while the server allows trust.
for (const step of STEPS) {
  assert.equal(flow.showTrustCheckbox(step, true), step === 'mfa', `${step} with trust on`);
  assert.equal(flow.showTrustCheckbox(step, false), false, `${step} with trust off`);
}
assert.equal(flow.TRUST_BROWSER_LABEL, 'Trust this browser for 7 days');
assert.equal(
  flow.TRUST_BROWSER_HELP,
  "You won't be asked for a code on this browser for 7 days. Don't use this on a shared computer.",
);
assert.equal(flow.DEVICE_TRUST_EXPIRED_NOTICE, TRUST_EXPIRED);
assert.equal(flow.SESSION_FAILED_MESSAGE, SESSION_FAILED);

// --- The POST body: K1.2's shape, in its order.
const tokens = { idToken: ID_TOKEN, accessToken: ACCESS_TOKEN };
assert.equal(
  JSON.stringify(flow.buildSessionBody(tokens, { step: 'mfa', trustChecked: true, deviceTrustEnabled: true })),
  JSON.stringify({ idToken: ID_TOKEN, accessToken: ACCESS_TOKEN, trustDevice: true }),
);
for (const [step, trustChecked, deviceTrustEnabled] of [
  ['mfa', false, true],
  ['mfa', true, false],
  ['mfa-setup', true, true],
  ['credentials', true, true],
  ['new-password', true, true],
]) {
  assert.equal(
    flow.buildSessionBody(tokens, { step, trustChecked, deviceTrustEnabled }).trustDevice,
    false,
    `${step}, ticked=${trustChecked}, trust on=${deviceTrustEnabled}: a box that was not on screen cannot trust`,
  );
}

const run = (answer, { step = 'mfa', trustChecked = false, search = '' } = {}) => {
  const device = fakeDevice();
  const { bodies, post } = fakePost(answer);
  const next = flow.completeSignIn({
    session: fakeSession(),
    device,
    choice: { step, trustChecked, deviceTrustEnabled: true },
    search,
    post,
  });
  return next.then((value) => ({ next: value, device, bodies }));
};

// --- Success: the POST carries both tokens and the choice; next is followed.
{
  const { next, device, bodies } = await run(
    { kind: 'ok', status: 200, data: { ok: true } },
    { trustChecked: true, search: '?next=%2Fsecurity%3Fcategory%3Dadmin_access' },
  );
  assert.deepEqual(bodies, [{ idToken: ID_TOKEN, accessToken: ACCESS_TOKEN, trustDevice: true }]);
  assert.deepEqual(next, { kind: 'navigate', href: '/security?category=admin_access' });
  assert.deepEqual(device.calls, [], 'a sign-in that worked keeps the cached device');
}

// --- device_trust_expired: drop the cached device, explain, start again.
{
  const { next, device } = await run(
    { kind: 'error', status: 401, data: { error: 'device_trust_expired' } },
    { step: 'credentials' },
  );
  assert.deepEqual(device.calls, ['clear'], 'the SDK forgets this browser as a device');
  assert.deepEqual(next, { kind: 'restart', reason: { message: TRUST_EXPIRED, tone: 'notice' } });
}

// --- Every other failure: the existing message, start again, device kept.
for (const [label, answer] of [
  ['invalid token', { kind: 'error', status: 401, data: { error: 'invalid_admin_token' } }],
  ['server error', { kind: 'error', status: 500, data: null }],
  ['unreachable', { kind: 'network' }],
  ['post threw', new Error('offline')],
  ['the trust code on another status', { kind: 'error', status: 400, data: { error: 'device_trust_expired' } }],
  ['an odd redirect', { kind: 'redirecting' }],
]) {
  const { next, device } = await run(answer);
  assert.deepEqual(next, { kind: 'restart', reason: { message: SESSION_FAILED, tone: 'error' } }, label);
  assert.deepEqual(device.calls, [], `${label}: the cached device stays`);
}

// --- next: hostile values land on the home page (safeNextPath).
for (const search of ['?next=%2F%2Fevil.example', '?next=https%3A%2F%2Fevil.example', '?next=%2F%5Cevil.example', '']) {
  const { next } = await run({ kind: 'ok', status: 200, data: { ok: true } }, { search });
  assert.deepEqual(next, { kind: 'navigate', href: '/' }, `next from "${search}"`);
}

// --- The device adapter calls the SDK's own method on the user, or fails loudly.
{
  const calls = [];
  const user = { clearCachedDeviceKeyAndPassword() { calls.push(this); } };
  flow.cachedDeviceOf(user).clearCachedDeviceKeyAndPassword();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], user, 'called on the user itself');
  assert.throws(() => flow.cachedDeviceOf({}).clearCachedDeviceKeyAndPassword(), /cannot clear its cached device/);
}
// The installed SDK has that method (its typings may omit it).
{
  const sdk = await import('amazon-cognito-identity-js');
  assert.equal(typeof sdk.CognitoUser.prototype.clearCachedDeviceKeyAndPassword, 'function');
}

// --- The step reducer.
{
  let state = flow.initialLoginState();
  assert.deepEqual([state.step, state.email, state.trustBrowser, state.submitting], ['credentials', '', false, false]);
  state = flow.loginReducer(state, { type: 'email_changed', email: 'admin-a@example.test' });
  state = flow.loginReducer(state, { type: 'submit_started' });
  assert.equal(state.submitting, true);
  state = flow.loginReducer(state, { type: 'new_password_required' });
  assert.deepEqual([state.step, state.prompt, state.submitting], ['new-password', 'Replace the temporary password to continue.', false]);
  state = flow.loginReducer(state, { type: 'totp_setup_started' });
  assert.deepEqual(
    [state.step, state.prompt],
    ['mfa-setup', 'Add Jale Admin to your authenticator app, then enter the six-digit code.'],
  );
  state = flow.loginReducer(state, { type: 'trust_changed', checked: true });
  assert.equal(state.trustBrowser, false, 'the box cannot be ticked at authenticator setup');
  state = flow.loginReducer(state, { type: 'code_required', challenge: 'totp' });
  assert.deepEqual([state.step, state.prompt, state.trustBrowser], ['mfa', 'From your authenticator app.', false]);
  state = flow.loginReducer(state, { type: 'trust_changed', checked: true });
  assert.equal(state.trustBrowser, true);
  state = flow.loginReducer(state, { type: 'submit_failed', message: 'Invalid code received for user' });
  assert.deepEqual([state.step, state.trustBrowser, state.error, state.submitting], ['mfa', true, 'Invalid code received for user', false]);
  state = flow.loginReducer(state, { type: 'restarted', reason: { message: TRUST_EXPIRED, tone: 'notice' } });
  assert.deepEqual(
    [state.step, state.email, state.trustBrowser, state.notice, state.error, state.submitting],
    ['credentials', 'admin-a@example.test', false, TRUST_EXPIRED, undefined, false],
    'starting again keeps the email only',
  );
  state = flow.loginReducer(state, { type: 'submit_started' });
  assert.equal(state.notice, undefined, 'the notice clears on the next try');
  state = flow.loginReducer(state, { type: 'code_required', challenge: 'other' });
  assert.deepEqual([state.prompt, state.trustBrowser], ['Enter your MFA code.', false], 'the box starts unticked every time');
  state = flow.loginReducer(state, { type: 'restarted', reason: { message: SESSION_FAILED, tone: 'error' } });
  assert.deepEqual([state.step, state.error, state.notice], ['credentials', SESSION_FAILED, undefined]);
  state = flow.loginReducer(state, { type: 'restarted' });
  assert.deepEqual([state.step, state.error, state.notice], ['credentials', undefined, undefined]);
}

// --- Nothing in src remembers a device or reads the SDK's confirmation flag.
{
  const offenders = [];
  for (const entry of readdirSync(resolve(adminRoot, 'src'), { recursive: true })) {
    if (!/\.tsx?$/.test(String(entry))) continue;
    const source = readFileSync(resolve(adminRoot, 'src', String(entry)), 'utf8');
    if (/setDeviceStatusRemembered|userConfirmationNecessary/.test(source)) offenders.push(String(entry));
  }
  assert.deepEqual(offenders, [], 'the server alone decides whether a browser is trusted');
}

// --- The form: wired to login-flow and admin-fetch (source) -------------------------
// The sign-in POST is built by buildSessionBody and sent by admin-fetch,
// which adds the payload hash; a 401 there is a sign-in failure, not an
// expired session, so it never redirects.
const formSource = readFileSync(resolve(adminRoot, 'src/components/AdminLoginForm.tsx'), 'utf8');
assert.match(formSource, /adminFetchJson<[^>]*>\(\s*'\/api\/session'/, 'the sign-in POST goes through admin-fetch');
assert.match(formSource, /redirectOn401:\s*false/, 'a refused sign-in stays on the form');
assert.match(formSource, /completeSignIn\(/, 'the POST body and its answer come from login-flow');
assert.match(formSource, /cachedDeviceOf\(user\)/, 'an ended trust clears the device of this sign-in');
assert.doesNotMatch(formSource, /\bfetch\(/, 'no hand-rolled fetch');
assert.doesNotMatch(formSource, /JSON\.stringify\(\s*\{\s*idToken/, 'the body is not built by hand');
assert.match(formSource, /showTrust=\{showTrustCheckbox\(state\.step, deviceTrustEnabled\)\}/);
assert.match(formSource, /authConfig: AdminClientAuthConfig;\s*deviceTrustEnabled: boolean;/, '00-FE-INTERFACES §4 props');
assert.doesNotMatch(formSource, /\bAdminAuthConfig\b/, 'only the client auth config reaches the browser');
const successHandlers = [...formSource.matchAll(/onSuccess:\s*\(([^)]*)\)/g)].map((match) => match[1].trim());
assert.ok(successHandlers.length >= 2, 'both success paths are found');
for (const parameters of successHandlers) {
  assert.equal(parameters.split(',').length, 1, `onSuccess (${parameters}) reads the session only`);
}

// --- The form: rendered steps ---------------------------------------------------------
{
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const form = await load('src/components/AdminLoginForm.tsx');
  const noop = () => {};
  const count = (html, pattern) => (html.match(pattern) ?? []).length;
  const backButton = /<button(?=[^>]*type="button")[^>]*>[\s\S]*?Back to sign in/;

  // The first step: email and password, no box, no configuration.
  const first = renderToStaticMarkup(createElement(form.AdminLoginForm, {
    authConfig: { userPoolId: '<admin-pool-id>', clientId: '<admin-client-id>' },
    deviceTrustEnabled: true,
  }));
  assert.match(first, /<h2[^>]*>Sign in<\/h2>/);
  assert.match(first, /<label[^>]*for="login-email"[^>]*>Work email<\/label>/);
  // React keeps some attribute names camelCase (autoComplete, inputMode, minLength, spellCheck): match those case-insensitively.
  assert.match(first, /<input(?=[^>]*id="login-email")(?=[^>]*type="email")(?=[^>]*autocomplete="username")[^>]*>/i);
  assert.match(first, /<label[^>]*for="login-password"[^>]*>Password<\/label>/);
  assert.match(first, /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?Continue/);
  assert.doesNotMatch(first, /type="checkbox"|Back to sign in/);
  assert.doesNotMatch(first, /admin-pool-id|admin-client-id/, 'the pool and client ids are never printed');

  const mfa = (showTrust, trustBrowser = false) => renderToStaticMarkup(createElement(form.MfaCodeStep, {
    prompt: 'From your authenticator app.', code: '', showTrust, trustBrowser, submitting: false,
    onCodeChange: noop, onTrustChange: noop, onSubmit: noop, onBack: noop,
  }));
  // The code step with trust on: one box, unticked, labelled, described.
  const on = mfa(flow.showTrustCheckbox('mfa', true));
  assert.match(on, /<h2[^>]*>Enter your code<\/h2>/);
  assert.match(on, /From your authenticator app\./);
  assert.match(on, /<input(?=[^>]*id="login-code")(?=[^>]*autocomplete="one-time-code")(?=[^>]*inputmode="numeric")[^>]*>/i);
  assert.equal(count(on, /type="checkbox"/g), 1);
  assert.match(on, /<input(?=[^>]*type="checkbox")(?![^>]*checked)(?=[^>]*aria-describedby="login-trust-browser-help")[^>]*>/, 'unticked by default');
  assert.match(on, /Trust this browser for 7 days/);
  assert.match(on, /You won&#x27;t be asked for a code on this browser for 7 days\. Don&#x27;t use this on a shared computer\./);
  assert.match(on, /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?Verify and sign in/);
  assert.match(on, backButton);
  assert.match(mfa(true, true), /<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/);
  // Trust off: no box.
  assert.doesNotMatch(mfa(flow.showTrustCheckbox('mfa', false)), /type="checkbox"/);

  // First-time setup: QR as a data: image, the manual key, never a box.
  const setup = renderToStaticMarkup(createElement(form.TotpSetupStep, {
    prompt: 'Add Jale Admin to your authenticator app, then enter the six-digit code.',
    totpSecret: 'SETUPKEYFIXTURE', qrDataUrl: 'data:image/png;base64,AAAA', code: '', submitting: false,
    onCodeChange: noop, onSubmit: noop, onBack: noop,
  }));
  assert.doesNotMatch(setup, /type="checkbox"/, 'no device exists at first-time setup');
  assert.match(setup, /<code>SETUPKEYFIXTURE<\/code>/);
  assert.match(setup, /<img(?=[^>]*src="data:image\/png;base64,AAAA")(?=[^>]*alt="Scan this QR code with your authenticator app")[^>]*>/);
  assert.match(setup, /Finish authenticator setup/);
  assert.match(setup, backButton);

  const newPassword = renderToStaticMarkup(createElement(form.NewPasswordStep, {
    prompt: 'Replace the temporary password to continue.', newPassword: '', confirmNewPassword: '', submitting: false,
    onNewPasswordChange: noop, onConfirmChange: noop, onSubmit: noop, onBack: noop,
  }));
  assert.match(newPassword, /<input(?=[^>]*autocomplete="new-password")(?=[^>]*minlength="14")[^>]*>/i);
  assert.match(newPassword, /Set new password/);
  assert.match(newPassword, backButton);

  // The first step after a trust ended: the notice, the email kept.
  const notice = renderToStaticMarkup(createElement(form.CredentialsStep, {
    email: 'admin-a@example.test', password: '', submitting: false, notice: TRUST_EXPIRED,
    onEmailChange: noop, onPasswordChange: noop, onSubmit: noop,
  }));
  assert.match(notice, /For your security, enter a code from your authenticator app again\./);
  assert.match(notice, /value="admin-a@example\.test"/);
}

console.log('admin sign-in form checks passed');
