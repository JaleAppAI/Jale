// Test-only series for the FE-4 chart checks and the fixture gallery.
// Never imported by src/. Values are synthetic.

const n26 = (fn) => Array.from({ length: 26 }, (_, i) => fn(i));

// 26 weekly values that make value labels collide: huge and tiny neighbours,
// long labels, flat runs, spikes, gaps.
export const ADVERSARIAL_26 = {
  zigzag: n26((i) => (i % 2 === 0 ? 0 : 1_000_000)),
  flat: n26(() => 1_234_567),
  ramp: n26((i) => i + 1),
  spikes: [0, 0, 987_654, 0, 0, 0, 12, 0, 999_999, 999_998, 0, 0, 5, 0, 0, 0, 0, 876_543, 0, 0, 1, 0, 0, 0, 654_321, 0],
  gaps: n26((i) => (i % 3 === 1 ? null : 500 + ((i * 37) % 11) * 50_000)),
  sawtooth: n26((i) => (i % 4) * 333_333),
  plateauDrop: n26((i) => (i < 13 ? 88_888 : 88_887)),
};

// Three series that run close together (workers, verified workers, employers).
export const CONVERGING_3 = [
  n26((i) => 1000 + i * 10),
  n26((i) => 995 + i * 10),
  n26((i) => 1000 + i * 9),
];

// Week starts (Monday 00:00 UTC), oldest first, ending with the week of
// 2026-10-12: the current, partial week in every fixture.
export const WEEKS_26 = n26((i) => new Date(Date.UTC(2026, 3, 20) + i * 7 * 86_400_000).toISOString());
export const WEEKS_8 = WEEKS_26.slice(-8);
