/**
 * Two initials from an email's local part: "ops-admin@…" -> "OA",
 * "pat@…" -> "PA". The email is the admin's identity (K1.5: no names).
 */
export function emailInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return '?';
}
