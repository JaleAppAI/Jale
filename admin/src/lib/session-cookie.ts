export const ADMIN_SESSION_COOKIE = 'jale_admin_id_token_v2';

/**
 * The request header the proxy sets to the requested path and query (always
 * overwriting a client value); requireAdminSession() reads it to build the
 * sign-in redirect's `next` (contract K1.3).
 */
export const ADMIN_NEXT_HEADER = 'x-admin-next';
