// Bundler alias target for js-cookie (see turbopack.resolveAlias in
// next.config.mjs; it was a webpack alias before the Next 16 upgrade).
//
// A no-op stand-in that keeps js-cookie out of the admin bundle. js-cookie's
// only importer is amazon-cognito-identity-js's CookieStorage, which the admin
// app never uses (only CognitoUser / CognitoUserPool / AuthenticationDetails
// are imported). Code that does reach CookieStorage gets these no-ops, so it
// stores no cookies. The methods are exported both as the default (what SDK
// 6.3.20 imports) and by name.
const api = {
  get: () => undefined,
  set: () => {},
  remove: () => {},
  withAttributes: (attrs) => ({ ...api, defaults: attrs }),
  withConverter: () => api,
};

export const get = api.get;
export const set = api.set;
export const remove = api.remove;
export const withAttributes = api.withAttributes;
export const withConverter = api.withConverter;
export default api;
