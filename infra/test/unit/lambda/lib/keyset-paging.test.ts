import { decodeCursor, encodeCursor, parseLimit } from '../../../../lambda/lib/keyset-paging';

/**
 * The paging primitives both list endpoints now share.
 *
 * They were copied into each one, which is how a validator ends up accepting
 * three slightly different things; these are the rules that have to hold
 * wherever they are used.
 */
describe('keyset-paging', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  describe('cursors', () => {
    it('round-trips a timestamp at full database precision', () => {
      // MICROSECONDS. A cursor truncated to a JS Date's milliseconds no longer
      // compares strictly-less than the row that produced it, so that row
      // comes back at the top of the next page -- forever.
      const at = '2026-09-10 10:00:00.123456+00';
      expect(decodeCursor(encodeCursor(at, ID))).toEqual({ at, id: ID });
    });

    it('refuses anything it cannot trust', () => {
      // Client-supplied strings, every one of them.
      expect(decodeCursor('not-base64-at-all')).toBeNull();
      expect(decodeCursor(Buffer.from('no-separator').toString('base64'))).toBeNull();
      expect(decodeCursor(Buffer.from(`|${ID}`).toString('base64'))).toBeNull();
      expect(decodeCursor(Buffer.from('2026-09-10T10:00:00Z|').toString('base64'))).toBeNull();
      // A timestamp that is not one, and an id that is not a uuid: both would
      // otherwise reach the database inside a `::timestamptz`/`::uuid` cast.
      expect(decodeCursor(Buffer.from(`whenever|${ID}`).toString('base64'))).toBeNull();
      expect(decodeCursor(Buffer.from('2026-09-10T10:00:00Z|1; DROP').toString('base64'))).toBeNull();
    });

    it('reads the id from the LAST separator', () => {
      // `lastIndexOf`, not `split`: the id half never contains a '|', so
      // taking the last one is what keeps it whole whatever precedes it. A
      // sort value that did contain one would fail `Date.parse` below rather
      // than quietly swallow half the id.
      const crafted = Buffer.from(`2026-09-10T10:00:00Z|extra|${ID}`, 'utf-8').toString('base64');
      expect(decodeCursor(crafted)).toBeNull();
      expect(decodeCursor(encodeCursor('2026-09-10T10:00:00Z', ID))).toEqual({
        at: '2026-09-10T10:00:00Z',
        id: ID,
      });
    });
  });

  describe('limits', () => {
    const bounds = { defaultLimit: 50, maxLimit: 100 };

    it('takes a sane limit as asked', () => {
      expect(parseLimit('25', bounds)).toBe(25);
    });

    it('caps a greedy one', () => {
      expect(parseLimit('5000', bounds)).toBe(100);
    });

    it('falls back rather than refusing nonsense', () => {
      // A bad `?limit=` is not worth an error page in front of a list; the cap
      // is what protects the database.
      for (const raw of [undefined, '', '0', '-5', 'many', '1.5', 'NaN', 'Infinity']) {
        expect(parseLimit(raw, bounds)).toBe(50);
      }
    });
  });
});
