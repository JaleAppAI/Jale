// Test-only stand-in for amazon-cognito-identity-js in the FE-1 checks: it
// records the pool it was built for and the sign-out call, in order, into
// globalThis.__adminCheck.signOutLog.
export class CognitoUserPool {
  constructor({ UserPoolId, ClientId }) {
    const check = (globalThis.__adminCheck ??= {});
    if (check.cognitoThrows) throw new Error('Invalid UserPoolId format.');
    (check.signOutLog ??= []).push(['pool', UserPoolId, ClientId]);
  }

  getCurrentUser() {
    const check = globalThis.__adminCheck;
    if (check.cognitoNoUser) return null;
    return { signOut: () => { check.signOutLog.push(['sdk-signOut']); } };
  }
}
