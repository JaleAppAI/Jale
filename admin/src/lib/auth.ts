export type AdminAuthConfig = {
  userPoolId: string;
  clientId: string;
  region: string;
  hostedDomain: string;
};

export function getAdminAuthConfig(): AdminAuthConfig {
  return {
    userPoolId: process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID ?? '',
    clientId: process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID ?? '',
    region: process.env.NEXT_PUBLIC_ADMIN_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    hostedDomain: process.env.NEXT_PUBLIC_ADMIN_HOSTED_DOMAIN ?? 'admin.jaleapp.ai',
  };
}

/**
 * Contract K1.1 (sprint 28): the only Cognito values that may reach a client
 * component (the login form and the shell's sign-out control). Server code
 * keeps using getAdminAuthConfig().
 */
export type AdminClientAuthConfig = { userPoolId: string; clientId: string };

export function getAdminClientAuthConfig(): AdminClientAuthConfig {
  const { userPoolId, clientId } = getAdminAuthConfig();
  return { userPoolId, clientId };
}
