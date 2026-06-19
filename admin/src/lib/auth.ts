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
