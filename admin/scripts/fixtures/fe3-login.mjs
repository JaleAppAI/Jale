// Test-only stand-ins for the sign-in checks (check-ui-login-form.mjs) and the
// FE-3 gallery. Never imported by src.
export const ID_TOKEN = 'id-token-fixture';
export const ACCESS_TOKEN = 'access-token-fixture';

/** A Cognito session as the form receives it: two tokens. */
export function fakeSession() {
  return {
    getIdToken: () => ({ getJwtToken: () => ID_TOKEN }),
    getAccessToken: () => ({ getJwtToken: () => ACCESS_TOKEN }),
  };
}

/** The SDK's cached device for this user; records each clear. */
export function fakeDevice() {
  const calls = [];
  return { calls, clearCachedDeviceKeyAndPassword() { calls.push('clear'); } };
}

/** A post() that records each body and answers with `answer` (or throws it). */
export function fakePost(answer) {
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { bodies, post };
}
