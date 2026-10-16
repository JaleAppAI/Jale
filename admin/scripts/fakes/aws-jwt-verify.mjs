// Fake for aws-jwt-verify in the admin check scripts: verify() defers to
// globalThis.__adminCheck.verifyToken(token, config), which returns claims or
// throws. `config` is the verifier's own ({ userPoolId, tokenUse, clientId }),
// so a check can answer an ID token and an access token differently. Every
// verifier's config is kept on verifierConfigs; verifierConfig is the last.
export const CognitoJwtVerifier = {
  create(config) {
    const check = (globalThis.__adminCheck ??= {});
    check.verifierConfig = config;
    (check.verifierConfigs ??= []).push(config);
    return {
      verify: async (token) => {
        if (typeof check.verifyToken !== 'function') {
          throw new Error('fake verifier: no verifyToken configured');
        }
        return check.verifyToken(token, config);
      },
    };
  },
};
