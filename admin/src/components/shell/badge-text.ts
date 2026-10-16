/** The nav badge shows at most two digits. */
export const INBOX_BADGE_CAP = 99;

/** "7", "99", then "99+". */
export function inboxBadgeText(n: number): string {
  return n > INBOX_BADGE_CAP ? `${INBOX_BADGE_CAP}+` : String(Math.floor(n));
}

/** The full number for screen readers: "120 waiting". */
export function inboxBadgeSrText(n: number): string {
  return `${Math.floor(n)} waiting`;
}
