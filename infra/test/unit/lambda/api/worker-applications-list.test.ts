import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-applications-list';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveTradeAlias } from '../../../../lambda/lib/trade-canonical';
import { normalizeProfession } from '../../../../lambda/lib/profession';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
// The 060 trade_aliases cache. Mocked (never `{ virtual: true }` -- this is a
// real module) so the post-COMMIT canonicalisation pass can be counted: what
// matters is that it fires ONCE per distinct free-text trade and that a
// failure is swallowed.
jest.mock('../../../../lambda/lib/trade-canonical');
// Mocked ONLY so one test can make the canonicalisation loop fail OUTSIDE the
// resolver. Every other test gets the real implementation back in beforeEach
// (auto-mocked it would return undefined, which the memo keys off -- and the
// memo tests below would silently stop exercising anything).
jest.mock('../../../../lambda/lib/profession');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveTradeAlias = resolveTradeAlias as jest.Mock;
const mockNormalizeProfession = normalizeProfession as jest.Mock;
const realNormalizeProfession: (raw: string) => string =
  jest.requireActual('../../../../lambda/lib/profession').normalizeProfession;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

describe('worker-applications-list', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    // resetAllMocks() above wiped the implementation; give the real one back
    // so normalization is genuine everywhere except where a test overrides it.
    mockNormalizeProfession.mockImplementation(realNormalizeProfession);
  });
  afterAll(() => { process.env = env; });

  it('returns 200 with applications including job_status, under the internal-id RLS context', async () => {
    const row = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'closed',
    };
    // 091 engine inputs -- selected, used, and STRIPPED from the response.
    const engineInputs = {
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    };
    const derived = {
      details_status: 'not_requested', stage: 'apply',
      details_requested_at: null, details_completed_at: null,
      remaining_count: 0,
      remaining: {
        prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
        counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
        complete: true,
      },
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ ...row, ...engineInputs }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    // `applications` is byte-for-byte what it always was; paging added
    // `next_cursor` BESIDE it, which is what keeps the response backward
    // compatible for a client that has never heard of a cursor.
    expect(JSON.parse(res.body)).toEqual({
      applications: [{ ...row, ...derived }],
      next_cursor: null,
      // Beside the page, and empty when nothing needs the worker.
      attention: { details_requested: [], unacknowledged_hires: [] },
    });

    // The 070 policy is keyed on app.current_internal_user_id — without this
    // call, closed jobs silently vanish from the list again.
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-internal-id');

    const listSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;
    // paused is a billing signal — never exposed to workers (spec).
    expect(listSql).toContain("CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status");
    // Company name comes from the 031 definer function; the users join is
    // gone (no RLS policy lets a worker read an employer's users row).
    expect(listSql).toContain('employer_display_name(j.employer_id) AS company_name');
    expect(listSql).not.toContain('JOIN users');
  });

  it('returns 409 when the internal-id lookup finds no user row', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalled();
  });

  describe('application stages (091)', () => {
    const BASE = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'active',
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    };

    async function row(over: Record<string, unknown> = {}) {
      mockQuery.mockImplementation((q: string) => {
        if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
        if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ ...BASE, ...over }] });
        return Promise.resolve({ rows: [] });
      });
      const res = await handler(ev);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).applications[0];
    }

    const listSql = () =>
      mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;

    it('selects the stage columns, the job requirements and a JOB-SCOPED have_docs, and keeps employer_display_name last', async () => {
      await row();
      const sql = listSql();
      expect(sql).toContain('a.prompt_answers');
      expect(sql).toContain('a.details_requested_at');
      expect(sql).toContain('a.details_completed_at');
      expect(sql).toContain('j.required_fields');
      expect(sql).toContain('j.certification_requirements');
      expect(sql).toContain('j.pre_application_prompts');
      expect(sql).toContain('AND wd.job_id = a.job_id');
      expect(sql).toContain('AS have_docs');
      // The 031 definer function flips a transaction-local employer_profiles
      // read flag until COMMIT -- this must stay the last query touching it.
      expect(sql).toContain('employer_display_name(j.employer_id) AS company_name');
      const after = mockQuery.mock.calls.slice(
        mockQuery.mock.calls.findIndex(([q]) => String(q).includes('employer_display_name')) + 1,
      );
      expect(after.every(([q]) => !String(q).includes('employer_profiles'))).toBe(true);
    });

    it('strips every raw engine input from the response rows', async () => {
      const r = await row({ application_answers: { a: 1 }, prompt_answers: { p1: 'x' }, have_docs: ['resume'] });
      for (const key of [
        'application_answers', 'prompt_answers', 'have_docs',
        'required_fields', 'optional_fields', 'required_docs', 'optional_docs',
        'certification_requirements', 'pre_application_prompts',
      ]) {
        expect(r[key]).toBeUndefined();
      }
    });

    it('reports requested with a remaining_count summing all four buckets', async () => {
      const r = await row({
        status: 'details_requested',
        details_requested_at: '2026-09-01T00:00:00Z',
        pre_application_prompts: [{ id: 'p1', text: 'A' }, { id: 'p2', text: 'B' }],
        prompt_answers: { p1: 'yes' },
        required_fields: ['work_authorization'],
        required_docs: ['resume'],
      });
      expect(r.details_status).toBe('requested');
      expect(r.stage).toBe('details');
      expect(r.details_requested_at).toBe('2026-09-01T00:00:00Z');
      // 1 prompt + 1 field + 0 certs + 1 doc
      expect(r.remaining_count).toBe(3);
      expect(r.remaining.counts).toEqual({ prompts: 1, fields: 1, certifications: 0, docs: 1 });
    });

    it('reports complete from details_completed_at', async () => {
      const r = await row({
        details_requested_at: '2026-09-01T00:00:00Z',
        details_completed_at: '2026-09-02T00:00:00Z',
        required_fields: ['work_authorization'],
      });
      expect(r.details_status).toBe('complete');
      expect(r.details_completed_at).toBe('2026-09-02T00:00:00Z');
      // remaining still reports the outstanding item; the timestamp wins.
      expect(r.remaining_count).toBe(1);
    });

    it('never promotes a not-yet-requested application to complete', async () => {
      const r = await row();
      expect(r.details_status).toBe('not_requested');
      expect(r.remaining.complete).toBe(true);
    });
  });

  // Sprint 24 (095): the worker's "You've been hired" celebration. The modal
  // fires once and the banner is dismissible, and BOTH pieces of state live on
  // the row (hired_seen_at / hired_ack_at) so they hold across devices -- which
  // is why this list, not localStorage, is what the browser reads them from.
  describe('hire celebration (095)', () => {
    /** The 095 columns and the job facts the celebration repeats. */
    const HIRE_COLUMNS = {
      hired_at: new Date('2026-09-04T15:30:00.000Z'),
      hired_seen_at: null,
      hired_ack_at: null,
      job_start_date: '2026-09-15',
      job_location: 'El Paso, TX 79901',
      job_city: 'El Paso',
      job_state: 'TX',
      job_pay: '$22-$26/hour',
      job_pay_min: 22,
      job_pay_max: 26,
      job_pay_interval: 'hourly',
      job_shift_schedule: 'Lunes a viernes, 7am-3pm',
      job_trade_category: 'electrician',
      job_trade_category_other: null,
    };
    const BASE = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'active',
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
      ...HIRE_COLUMNS,
    };

    async function row(over: Record<string, unknown> = {}) {
      mockQuery.mockImplementation((q: string) => {
        if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
        if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ ...BASE, ...over }] });
        return Promise.resolve({ rows: [] });
      });
      const res = await handler(ev);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).applications[0];
    }

    const listSql = () =>
      mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;

    it('selects the three 095 columns and the job facts, and keeps employer_display_name last', async () => {
      await row();
      const sql = listSql();
      // COALESCE, not a bare a.hired_at: a worker hired in the window between
      // migration 095 and this code deploy has a NULL hired_at (nothing wrote
      // it yet) and must still get their celebration. updated_at is NOT NULL
      // (003), so the projected value is never null.
      expect(sql).toContain('COALESCE(a.hired_at, a.updated_at) AS hired_at');
      expect(sql).toContain('a.hired_seen_at');
      expect(sql).toContain('a.hired_ack_at');
      // jobs.start_date is a DATE. `pg` parses a DATE into a JS Date at LOCAL
      // midnight, which JSON.stringify then emits as a full ISO timestamp --
      // and, west of UTC, as the PREVIOUS day. to_char keeps it the calendar
      // day the employer picked, in every timezone.
      expect(sql).toContain("to_char(j.start_date, 'YYYY-MM-DD') AS job_start_date");
      for (const alias of [
        'j.location AS job_location', 'j.city AS job_city', 'j.state AS job_state',
        'j.pay AS job_pay', 'j.pay_min AS job_pay_min', 'j.pay_max AS job_pay_max',
        'j.pay_interval AS job_pay_interval', 'j.shift_schedule AS job_shift_schedule',
        'j.trade_category AS job_trade_category',
        'j.trade_category_other AS job_trade_category_other',
      ]) {
        expect(sql).toContain(alias);
      }
      // The 031 trap: employer_display_name flips a transaction-local GUC that
      // widens employer_profiles reads until COMMIT, so nothing may follow it.
      const after = mockQuery.mock.calls.slice(
        mockQuery.mock.calls.findIndex(([q]) => String(q).includes('employer_display_name')) + 1,
      );
      expect(after.every(([q]) => !String(q).includes('employer_profiles'))).toBe(true);
    });

    it('attaches hire to a hired row, with the job facts the celebration shows', async () => {
      const r = await row({ status: 'hired' });
      expect(r.hire).toEqual({
        hired_at: '2026-09-04T15:30:00.000Z',
        seen_at: null,
        acknowledged_at: null,
        start_date: '2026-09-15',
        location: 'El Paso, TX',
        // Raw pay fields: the browser's formatPay(job, t) renders the line.
        pay: '$22-$26/hour',
        pay_min: 22,
        pay_max: 26,
        pay_interval: 'hourly',
        shift_schedule: 'Lunes a viernes, 7am-3pm',
        // The 023 enum token, raw. A standard category needs no cache round
        // trip, so canonical_* stay null and the client translates the token.
        trade: { category: 'electrician', other: null, canonical_en: null, canonical_es: null },
        // employer_display_name returned a real name.
        company: 'Acme',
      });
      // No free text, so the 060 cache was never touched.
      expect(mockResolveTradeAlias).not.toHaveBeenCalled();
    });

    it('reports seen and acknowledged from the row, so the modal cannot re-fire on another device', async () => {
      const r = await row({
        status: 'hired',
        hired_seen_at: new Date('2026-09-04T16:00:00.000Z'),
        hired_ack_at: new Date('2026-09-05T09:00:00.000Z'),
      });
      expect(r.hire.seen_at).toBe('2026-09-04T16:00:00.000Z');
      expect(r.hire.acknowledged_at).toBe('2026-09-05T09:00:00.000Z');
    });

    // THE regression this feature could most easily cause: nine new columns in
    // the SELECT, leaking into every row of a list every worker loads.
    it('adds NOTHING to a non-hired row: no hire key, and every 095/job column stripped', async () => {
      for (const status of ['pending', 'contacted', 'talking', 'details_requested', 'not_interested']) {
        const r = await row({ status });
        expect(r.hire).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(r, 'hire')).toBe(false);
        for (const key of Object.keys(HIRE_COLUMNS)) {
          expect(Object.prototype.hasOwnProperty.call(r, key)).toBe(false);
        }
      }
    });

    it('strips the raw 095 and job columns from a HIRED row too -- only `hire` publishes them', async () => {
      const r = await row({ status: 'hired' });
      for (const key of Object.keys(HIRE_COLUMNS)) {
        expect(Object.prototype.hasOwnProperty.call(r, key)).toBe(false);
      }
      // ...and the rest of the row is exactly what it was before this feature.
      expect(Object.keys(r).sort()).toEqual([
        'application_id', 'applied_at', 'company_name', 'details_completed_at',
        'details_requested_at', 'details_status', 'hire', 'job_id', 'job_status',
        'job_title', 'remaining', 'remaining_count', 'stage', 'status',
      ]);
    });

    it('publishes the structured pay columns raw and never a synthesised string', async () => {
      const r = await row({ status: 'hired', job_pay: null });
      // No server-side fallback: an empty jobs.pay is null on the wire, and
      // the bounds go out for the client's own i18n formatter to render.
      expect(r.hire.pay).toBeNull();
      expect(r.hire.pay_min).toBe(22);
      expect(r.hire.pay_max).toBe(26);
      expect(r.hire.pay_interval).toBe('hourly');
    });

    it('nulls every job fact the job does not carry, and still celebrates', async () => {
      const r = await row({
        status: 'hired',
        job_start_date: null, job_location: '   ', job_city: null, job_state: null,
        job_pay: null, job_pay_min: null, job_pay_max: null, job_pay_interval: null,
        job_shift_schedule: null,
        job_trade_category: null, job_trade_category_other: null,
        company_name: 'Empleador',
      });
      expect(r.hire).toEqual({
        hired_at: '2026-09-04T15:30:00.000Z',
        seen_at: null, acknowledged_at: null,
        start_date: null, location: null, shift_schedule: null,
        pay: null, pay_min: null, pay_max: null, pay_interval: null,
        // A job with no trade, and the 031 sentinel screened off.
        trade: { category: null, other: null, canonical_en: null, canonical_es: null },
        company: null,
      });
      // The list's OWN top-level field keeps the legacy 031 fallback: every
      // other consumer of this endpoint still reads it.
      expect(r.company_name).toBe('Empleador');
    });

    // -- the free-text trade canonicalisation pass -----------------------
    // `jobs.trade_category = 'other'` means the employer typed the trade
    // themselves ("Welder", "soldadura", "Welders"). The 060 trade_aliases
    // cache is what turns that into a bilingual label, and only THIS handler
    // can read it -- `application-hire-view.ts` is pure and holds no client.
    //
    // The pass runs after the COMMIT: 031's employer_display_name flips a
    // transaction-local employer_profiles read flag that COMMIT closes, and
    // there is no reason to hold that window open for extra round trips.
    describe('free-text trade canonicalisation (060 trade_aliases)', () => {
      /** Several rows at once, so the memo can be observed. */
      async function rows(...overs: Record<string, unknown>[]) {
        mockQuery.mockImplementation((q: string) => {
          if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
          if (q.includes('FROM job_applications')) {
            return Promise.resolve({
              rows: overs.map((over, i) => ({ ...BASE, application_id: `a${i + 1}`, ...over })),
            });
          }
          return Promise.resolve({ rows: [] });
        });
        const res = await handler(ev);
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body).applications;
      }

      const OTHER = { status: 'hired', job_trade_category: 'other', job_trade_category_other: 'Welder' };

      it('resolves a free-text trade once and surfaces both canonical labels', async () => {
        mockResolveTradeAlias.mockResolvedValue({
          trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null,
        });
        const [r] = await rows(OTHER);
        expect(r.hire.trade).toEqual({
          category: 'other', other: 'Welder', canonical_en: 'Welder', canonical_es: 'Soldador',
        });
        // The Spanish label is the whole point: the worker-facing copy is
        // Spanish-first and the employer typed English.
        expect(r.hire.trade.canonical_es).toBe('Soldador');
        expect(mockResolveTradeAlias).toHaveBeenCalledTimes(1);
        expect(mockResolveTradeAlias).toHaveBeenCalledWith(expect.any(Object), 'Welder');
      });

      it('memoizes by the NORMALIZED key: one query for many rows saying the same thing', async () => {
        mockResolveTradeAlias.mockResolvedValue({
          trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null,
        });
        // normalizeProfession() lowercases, strips accents and collapses
        // whitespace, so all three of these are one cache key -- and hired
        // rows are rare enough that one query per DISTINCT text is fine.
        const list = await rows(
          OTHER,
          { ...OTHER, job_trade_category_other: 'welder' },
          { ...OTHER, job_trade_category_other: '  WELDER  ' },
        );
        expect(mockResolveTradeAlias).toHaveBeenCalledTimes(1);
        for (const r of list) expect(r.hire.trade.canonical_es).toBe('Soldador');
      });

      it('queries once PER DISTINCT free text, not once per hired row', async () => {
        mockResolveTradeAlias.mockImplementation((_c: unknown, raw: string) => Promise.resolve(
          raw.toLowerCase().startsWith('weld')
            ? { trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null }
            : { trade_key: 'roofer', canonical_en: 'Roofer', canonical_es: 'Techador', trade_category: null },
        ));
        const [a, b, c] = await rows(
          OTHER,
          { ...OTHER, job_trade_category_other: 'Roofer' },
          OTHER,
        );
        expect(mockResolveTradeAlias).toHaveBeenCalledTimes(2);
        expect(a.hire.trade.canonical_es).toBe('Soldador');
        expect(b.hire.trade.canonical_es).toBe('Techador');
        expect(c.hire.trade.canonical_es).toBe('Soldador');
      });

      it('leaves the canonicals null on a cache MISS, keeping the employer text', async () => {
        mockResolveTradeAlias.mockResolvedValue(null);
        const [r] = await rows({ ...OTHER, job_trade_category_other: 'Rope access tech' });
        expect(r.hire.trade).toEqual({
          category: 'other', other: 'Rope access tech', canonical_en: null, canonical_es: null,
        });
      });

      // THE reason this pass exists in a celebration path at all: it must
      // never be able to fail the request.
      it('FAILS OPEN when the lookup throws: nulls, a 200, and one log line', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockResolveTradeAlias.mockRejectedValue(new Error('permission denied for table trade_aliases'));
        try {
          const list = await rows(OTHER, { ...OTHER, job_trade_category_other: 'Roofer' });
          for (const r of list) {
            expect(r.hire.trade.canonical_en).toBeNull();
            expect(r.hire.trade.canonical_es).toBeNull();
            // The employer's own words survive, so the client still has
            // something to print.
            expect(r.hire.trade.other).not.toBeNull();
          }
          // Logged ONCE, not once per row: a role that lost the grant would
          // otherwise flood CloudWatch on every list load.
          expect(warn).toHaveBeenCalledTimes(1);
        } finally {
          warn.mockRestore();
        }
      });

      // The resolver's own try/catch cannot cover the loop AROUND it, so the
      // pass is wrapped too. Without that outer guard this is a 500 -- raised
      // AFTER the COMMIT, on a fully built response, for a missing label.
      it('FAILS OPEN when the loop itself throws, outside the resolver', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // Thrown where no resolver-level catch can see it.
        mockNormalizeProfession.mockImplementation(() => {
          throw new TypeError('normalizeProfession exploded');
        });
        try {
          const list = await rows(OTHER, { ...OTHER, job_trade_category_other: 'Roofer' });
          // A 200 with the celebration intact -- `rows` asserts the status.
          for (const r of list) {
            expect(r.hire.trade.canonical_en).toBeNull();
            expect(r.hire.trade.canonical_es).toBeNull();
            expect(r.hire.trade.other).not.toBeNull();
            // Everything that does NOT depend on this pass is untouched.
            expect(r.hire.hired_at).toBe('2026-09-04T15:30:00.000Z');
            expect(r.hire.company).toBe('Acme');
          }
          // The whole pass aborts on the first throw, so it is one line for
          // the request, not one per row.
          expect(warn).toHaveBeenCalledTimes(1);
          // It never got as far as a query.
          expect(mockResolveTradeAlias).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      });

      it('never touches the cache for a standard enum category or a blank free text', async () => {
        await rows(
          { status: 'hired', job_trade_category: 'drywall', job_trade_category_other: null },
          // 'other' with nothing typed: there is nothing to resolve, and
          // resolveTradeAlias would answer null anyway -- so no round trip.
          { status: 'hired', job_trade_category: 'other', job_trade_category_other: '   ' },
          { status: 'hired', job_trade_category: null, job_trade_category_other: null },
        );
        expect(mockResolveTradeAlias).not.toHaveBeenCalled();
      });

      it('never resolves a NON-hired row, whatever trade the job carries', async () => {
        const list = await rows(
          { status: 'pending', job_trade_category: 'other', job_trade_category_other: 'Welder' },
          { status: 'contacted', job_trade_category: 'other', job_trade_category_other: 'Welder' },
        );
        for (const r of list) expect(r.hire).toBeUndefined();
        expect(mockResolveTradeAlias).not.toHaveBeenCalled();
      });
    });
  });

  /*
   * PAGING.
   *
   * The list used to be a hard `LIMIT 200` with no way to ask for the rest: a
   * worker with more applications than that simply could not reach the older
   * ones, and every single load paid for two hundred rows plus their engine
   * columns whether or not anyone scrolled.
   *
   * Keyset on (applied_at, id) DESC, exactly like public-jobs-list: an OFFSET
   * would skip or repeat rows whenever an application changed underneath the
   * reader. The response stays backward compatible -- `applications` is the
   * same array it always was -- with `next_cursor` added beside it.
   */
  describe('paging', () => {
    const ID_A = '11111111-1111-4111-8111-111111111111';
    const ID_B = '22222222-2222-4222-8222-222222222222';

    /** The columns every row needs to survive the shaper. */
    const base = (id: string, appliedAt: string) => ({
      application_id: id, job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: appliedAt, cursor_applied_at: appliedAt, job_status: 'active',
      application_answers: {}, prompt_answers: {},
      details_requested_at: null, details_completed_at: null,
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    });

    /** Captured (sql, params) of the applications SELECT. */
    let listCall: { sql: string; params: unknown[] };

    function serve(rows: unknown[]) {
      mockQuery.mockImplementation((q: string, params: unknown[]) => {
        if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
        // The PAGE statement, not the attention summary beside it -- both
        // read job_applications, and only one of them is paged.
        if (q.includes('FROM job_applications') && !q.includes('details_requested_at IS NOT NULL')) {
          listCall = { sql: q, params: params ?? [] };
          return Promise.resolve({ rows });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    const eventWith = (queryStringParameters: Record<string, string> | null) => ({
      requestContext: { authorizer: { claims: { sub: 'w' } } },
      queryStringParameters,
    } as unknown as APIGatewayProxyEvent);

    /** The row limit the SQL was given -- always one MORE than asked for, so
     *  "is there another page" costs no second query. */
    const sqlLimit = () => listCall.params[listCall.params.length - 1];

    it('asks for 50 rows by default and reports no next page', async () => {
      serve([base(ID_A, '2026-09-10T10:00:00Z')]);

      const res = await handler(eventWith(null));

      expect(sqlLimit()).toBe(51);
      const body = JSON.parse(res.body);
      expect(body.applications).toHaveLength(1);
      expect(body.next_cursor).toBeNull();
    });

    it('caps a greedy limit at 100 and falls back on a nonsense one', async () => {
      serve([]);
      await handler(eventWith({ limit: '500' }));
      expect(sqlLimit()).toBe(101);

      await handler(eventWith({ limit: '0' }));
      expect(sqlLimit()).toBe(51);

      await handler(eventWith({ limit: 'many' }));
      expect(sqlLimit()).toBe(51);
    });

    it('hands back a cursor when there is another page, and only the page itself', async () => {
      // Asked for 2, answered with 3: the extra row is the "there is more"
      // signal and must never reach the client.
      serve([
        base(ID_A, '2026-09-10T10:00:00.123456Z'),
        base(ID_B, '2026-09-09T09:00:00.000000Z'),
        base('33333333-3333-4333-8333-333333333333', '2026-09-08T08:00:00.000000Z'),
      ]);

      const res = await handler(eventWith({ limit: '2' }));

      const body = JSON.parse(res.body);
      expect(body.applications.map((a: { application_id: string }) => a.application_id)).toEqual([ID_A, ID_B]);
      // Built from the LAST row of the page, at full Postgres precision.
      expect(Buffer.from(body.next_cursor, 'base64').toString('utf-8'))
        .toBe(`2026-09-09T09:00:00.000000Z|${ID_B}`);
    });

    it('resumes strictly after the cursor row', async () => {
      serve([base(ID_B, '2026-09-09T09:00:00Z')]);
      const cursor = Buffer.from(`2026-09-10T10:00:00.123456Z|${ID_A}`, 'utf-8').toString('base64');

      const res = await handler(eventWith({ cursor, limit: '2' }));

      expect(res.statusCode).toBe(200);
      // The tuple comparison, not two ANDed columns: a plain `applied_at <`
      // would drop every row that shares the cursor's timestamp.
      expect(listCall.sql).toContain('(a.applied_at, a.id) <');
      expect(listCall.params).toEqual(['2026-09-10T10:00:00.123456Z', ID_A, 3]);
      expect(JSON.parse(res.body).next_cursor).toBeNull();
    });

    it('refuses a malformed cursor rather than ignoring it', async () => {
      serve([]);

      // Silently dropping it would quietly serve page 1 forever, which reads
      // as an infinite list of the same rows.
      const res = await handler(eventWith({ cursor: 'not-a-cursor' }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_cursor');
    });

    it('never publishes the cursor column on a row', async () => {
      serve([base(ID_A, '2026-09-10T10:00:00Z')]);

      const res = await handler(eventWith(null));

      const [application] = JSON.parse(res.body).applications;
      expect(application).not.toHaveProperty('cursor_applied_at');
    });
  });


  /*
   * THE ATTENTION SUMMARY.
   *
   * Paging the list created a hole the banners fell into: the worker's home
   * and applications pages computed "an employer is waiting for your details"
   * and "you were hired" from the rows they happened to have loaded, so a
   * details request or an unacknowledged hire on application 51 was never
   * shown at all -- and the multi-banner printed an unhedged count of a
   * fraction of the list.
   *
   * The two questions are asked of ALL of the worker's applications, in the
   * same RLS-scoped transaction, and answered beside the page rather than
   * inside it. The rows are few by construction (an employer has to be waiting
   * on this worker, or have hired them without the hire being acknowledged),
   * which is what makes the extra statement cheap.
   */
  describe('attention summary', () => {
    const ENGINE = {
      application_answers: {}, prompt_answers: {},
      required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
      certification_requirements: null, pre_application_prompts: [], have_docs: [],
    };

    /** A row the page itself returns -- ordinary, needing nothing. */
    const pageRow = {
      application_id: 'page-1', job_id: 'j-page', job_title: 'Page job', company_name: 'Acme',
      status: 'pending', applied_at: 'ts-1', cursor_applied_at: 'ts-1', job_status: 'active',
      details_requested_at: null, details_completed_at: null,
      ...ENGINE,
    };

    /** Application 51: an employer is waiting on it, and the page never has it. */
    const awaitingDetails = {
      application_id: 'old-details', job_id: 'j-old', job_title: 'Old job', company_name: 'Older Co',
      status: 'pending', applied_at: 'ts-old', cursor_applied_at: 'ts-old', job_status: 'active',
      details_requested_at: '2026-09-01T00:00:00Z', details_completed_at: null,
      ...ENGINE,
      // One unanswered required field, so the engine agrees it is still owed.
      required_fields: ['phone'],
    };

    /** ...and one hired long enough ago to be off the page too. */
    const unackedHire = {
      application_id: 'old-hire', job_id: 'j-hire', job_title: 'Hire job', company_name: 'Hiring Co',
      status: 'hired', applied_at: 'ts-hire', cursor_applied_at: 'ts-hire', job_status: 'active',
      details_requested_at: null, details_completed_at: null,
      hired_at: '2026-09-02T00:00:00Z', hired_seen_at: null, hired_ack_at: null,
      job_start_date: '2026-09-10', job_location: 'El Paso, TX', job_city: 'El Paso', job_state: 'TX',
      job_pay: null, job_pay_min: 25, job_pay_max: 30, job_pay_interval: 'hourly',
      job_shift_schedule: null, job_trade_category: 'drywall', job_trade_category_other: null,
      ...ENGINE,
    };

    /** Captured (sql, params) of each statement, by kind. */
    let attentionCall: { sql: string; params: unknown[] } | null;

    function serve(page: unknown[], attention: unknown[]) {
      attentionCall = null;
      mockQuery.mockImplementation((q: string, params: unknown[]) => {
        const sql = String(q);
        if (sql.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
        if (sql.includes('details_requested_at IS NOT NULL')) {
          attentionCall = { sql, params: params ?? [] };
          return Promise.resolve({ rows: attention });
        }
        if (sql.includes('FROM job_applications')) return Promise.resolve({ rows: page });
        return Promise.resolve({ rows: [] });
      });
    }

    const ev2 = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

    it('reports what needs the worker even when it is off the page', async () => {
      serve([pageRow], [awaitingDetails, unackedHire]);

      const res = await handler(ev2);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // The page is untouched -- the summary is beside it, not inside it.
      expect(body.applications.map((a: { application_id: string }) => a.application_id)).toEqual(['page-1']);
      expect(body.attention.details_requested).toEqual([
        {
          application_id: 'old-details',
          job_id: 'j-old',
          job_title: 'Old job',
          company_name: 'Older Co',
          remaining_count: 1,
        },
      ]);
      const [hire] = body.attention.unacknowledged_hires;
      expect(hire.application_id).toBe('old-hire');
      expect(hire.job_title).toBe('Hire job');
      expect(hire.company_name).toBe('Hiring Co');
      // The whole celebration payload, the same shape the list row carries.
      expect(hire.hire).toMatchObject({
        hired_at: '2026-09-02T00:00:00.000Z',
        acknowledged_at: null,
        start_date: '2026-09-10',
        pay_min: 25,
      });
    });

    it('asks only for the rows that can need anything, and bounds them', async () => {
      serve([], []);

      await handler(ev2);

      expect(attentionCall).not.toBeNull();
      // Both halves of "needs the worker", and nothing else.
      expect(attentionCall!.sql).toContain('details_completed_at IS NULL');
      expect(attentionCall!.sql).toContain("a.status = 'hired'");
      expect(attentionCall!.sql).toContain('a.hired_ack_at IS NULL');
      // Bounded: an unbounded scan is what paging exists to avoid.
      expect(attentionCall!.params).toEqual([100]);
    });

    it('leaves a details request that is already satisfied out of it', async () => {
      // Requested, but nothing is actually outstanding -- `details_status`
      // says 'complete', and a banner asking for nothing is worse than none.
      serve([], [{ ...awaitingDetails, required_fields: [], application_answers: {} }]);

      const res = await handler(ev2);

      expect(JSON.parse(res.body).attention.details_requested).toEqual([]);
    });

    it('is empty, not absent, when nothing needs the worker', async () => {
      serve([pageRow], []);

      const res = await handler(ev2);

      expect(JSON.parse(res.body).attention).toEqual({
        details_requested: [],
        unacknowledged_hires: [],
      });
    });
  });

});
