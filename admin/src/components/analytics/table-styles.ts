// One table look for every analytics table (Tailwind classes, token colours).
export const TABLE = 'w-full border-collapse text-sm';
export const TH = 'whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-[var(--jale-ink-2)]';
export const TH_NUM = `${TH} text-right`;
export const TD = 'whitespace-nowrap border-t border-[var(--jale-divider)] px-3 py-2';
export const TD_NUM = `${TD} text-right tabular-nums`;
// Long text (names, reasons, causes) wraps instead of widening the table.
export const TD_WRAP = 'min-w-56 whitespace-normal border-t border-[var(--jale-divider)] px-3 py-2 [overflow-wrap:anywhere]';
export const SUB = 'block text-xs font-normal text-[var(--jale-ink-2)]';
