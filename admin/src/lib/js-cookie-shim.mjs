// Webpack alias target for js-cookie.
//
// amazon-cognito-identity-js@6.x imports { get, remove } from 'js-cookie' as
// named ESM exports, but no version of js-cookie actually exports them that
// way. The admin app never uses CookieStorage (only CognitoUser /
// CognitoUserPool / AuthenticationDetails are imported), so these are no-ops
// that exist solely to satisfy webpack's static named-export check.
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
