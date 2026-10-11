// Fake for aws-jwt-verify in the admin check scripts: verify() defers to
// globalThis.__adminCheck.verifyToken(token), which returns claims or throws.
export const CognitoJwtVerifier = {
  create(config) {
    const check = (globalThis.__adminCheck ??= {});
    check.verifierConfig = config;
    return {
      verify: async (token) => {
        if (typeof check.verifyToken !== 'function') {
          throw new Error('fake verifier: no verifyToken configured');
        }
        return check.verifyToken(token);
      },
    };
  },
};
