const ISSUER = 'Jale Admin';

export function buildOtpauthUri(secret: string, accountLabel: string): string {
  const label = encodeURIComponent(`${ISSUER}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(ISSUER)}`;
}
