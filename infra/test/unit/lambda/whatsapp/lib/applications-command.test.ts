// infra/test/unit/lambda/whatsapp/lib/applications-command.test.ts
//
// The `aplicaciones` command (sprint 23). Everything here runs against a
// single mocked `client.query`, matched by SQL SHAPE rather than call index,
// following the conventions in conversation-router.test.ts.
//
// templates.ts is left UNMOCKED on purpose: the copy assertions below are the
// point, so asserting against a mock would prove nothing.
import {
  APPLICATIONS_LIST_LIMIT,
  anyNeedsDetails,
  buildApplicationsList,
  loadWorkerApplications,
  parseApplicationsMenuPick,
  sendApplicationsList,
  sendApplicationsListRows,
  type ApplicationSummary,
  type ApplicationsContext,
  type ApplicationsDeps,
} from '../../../../../lambda/whatsapp/lib/applications-command';
import { t } from '../../../../../lambda/whatsapp/lib/templates';

const mockQuery = jest.fn();
const client: any = { query: mockQuery };

const WORKER_ID = 'bbbbbbbb-0000-0000-0000-00000000000b';
const APP_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const APP_B = 'cccccccc-0000-0000-0000-00000000000c';
const NOW_MS = 1_756_000_000_000;

function row(overrides: Partial<{
  id: string;
  title: string | null;
  status: string;
  needs_details: boolean;
  company_name: string | null;
}> = {}) {
  return {
    id: APP_A,
    title: 'Painter',
    status: 'pending',
    needs_details: false,
    company_name: 'RM Construction',
    ...overrides,
  };
}

function summary(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    applicationId: APP_A,
    jobTitle: 'Painter',
    companyName: 'RM Construction',
    status: 'pending',
    needsDetails: false,
    ...overrides,
  };
}

function makeCtx(stateContext: Record<string, unknown> = {}): ApplicationsContext {
  return {
    conversationId: 'conv-1',
    workerId: WORKER_ID,
    lang: 'es',
    stateContext,
  };
}

function makeDeps(ctx: ApplicationsContext): ApplicationsDeps & { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    queueReplyText: async (_c, _sid, _to, body) => { replies.push(body); },
    // Mirrors the processor's real updater: persist AND mutate in place, so a
    // later read of ctx.stateContext in the same turn sees the patch.
    updateStateContext: async (_c, _id, patch) => { Object.assign(ctx.stateContext, patch); },
    nowMs: () => NOW_MS,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('loadWorkerApplications', () => {
  it('scopes to the worker in SQL and orders needs-details first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });

    await loadWorkerApplications(client, WORKER_ID);

    const [sql, params] = mockQuery.mock.calls[0];
    // jobapp_whatsapp_select is USING (true) (028) -- this predicate, not
    // RLS, is what keeps one worker out of another's applications.
    expect(sql).toMatch(/WHERE ja\.worker_id = \$1/);
    expect(params).toEqual([WORKER_ID]);
    expect(sql).toMatch(/ORDER BY \(ja\.details_requested_at IS NOT NULL AND ja\.details_completed_at IS NULL\) DESC/);
    expect(sql).toMatch(/ja\.applied_at DESC/);
    expect(sql).toMatch(new RegExp(`LIMIT ${APPLICATIONS_LIST_LIMIT}`));
  });

  it('reads the company through employer_display_name, as the LAST expression of the only statement', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });

    await loadWorkerApplications(client, WORKER_ID);

    // 031's definer function flips a transaction-local employer_profiles read
    // flag until COMMIT. It is inert for jale_whatsapp (no table grant), but
    // this module still issues exactly ONE query so nothing can follow it.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/employer_display_name\(j\.employer_id\) AS company_name/);
  });

  it('folds the legacy reviewed/rejected spellings to the current vocabulary', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    await loadWorkerApplications(client, WORKER_ID);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHEN 'reviewed' THEN 'contacted'/);
    expect(sql).toMatch(/WHEN 'rejected' THEN 'not_interested'/);
  });

  it('degrades a null title/company rather than rendering "null"', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({ title: null, company_name: null })],
      rowCount: 1,
    });

    const rows = await loadWorkerApplications(client, WORKER_ID);

    expect(rows[0].jobTitle).toBe('');
    expect(rows[0].companyName).toBe('Jale');
  });
});

describe('buildApplicationsList', () => {
  it('numbers rows as "N) title - company - status" and marks needs-details rows', () => {
    const body = buildApplicationsList('es', [
      summary({ applicationId: APP_A, status: 'contacted', needsDetails: true }),
      summary({ applicationId: APP_B, jobTitle: 'Concrete', status: 'pending' }),
    ]);

    expect(body).toContain(t('applications_header', 'es'));
    expect(body).toContain('1) Painter - RM Construction - En revision - Faltan datos');
    expect(body).toContain('2) Concrete - RM Construction - Enviada');
  });

  it('appends the footer ONLY when at least one row is selectable', () => {
    const withGap = buildApplicationsList('es', [summary({ needsDetails: true })]);
    const withoutGap = buildApplicationsList('es', [summary({ needsDetails: false })]);

    expect(withGap).toContain(t('applications_footer', 'es'));
    expect(withoutGap).not.toContain(t('applications_footer', 'es'));
  });

  it('renders English status words for an en conversation', () => {
    const body = buildApplicationsList('en', [summary({ status: 'talking', needsDetails: true })]);
    expect(body).toContain('1) Painter - RM Construction - In conversation - Details needed');
    expect(body).toContain(t('applications_footer', 'en'));
  });

  it('passes an unknown status through untranslated rather than dropping the row', () => {
    const body = buildApplicationsList('es', [summary({ status: 'some_future_status' })]);
    expect(body).toContain('1) Painter - RM Construction - some_future_status');
  });
});

describe('sendApplicationsList', () => {
  it('arms the one-shot menu with EVERY listed id, in display order', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);
    mockQuery.mockResolvedValueOnce({
      rows: [row({ id: APP_A, needs_details: true }), row({ id: APP_B })],
      rowCount: 2,
    });

    const result = await sendApplicationsList(client, ctx, 'SM1', '+15550000', deps);

    // Non-selectable ids are stored too: picking a finished row must produce
    // its specific explanation, not "unknown number".
    expect(result.ids).toEqual([APP_A, APP_B]);
    expect(ctx.stateContext.applications_menu).toEqual({ ids: [APP_A, APP_B], at: NOW_MS });
    expect(result.anyNeedsDetails).toBe(true);
  });

  it('sends applications_none and CLEARS any stale menu when the worker has none', async () => {
    const ctx = makeCtx({ applications_menu: { ids: [APP_A], at: 1 } });
    const deps = makeDeps(ctx);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await sendApplicationsList(client, ctx, 'SM1', '+15550000', deps);

    expect(deps.replies).toEqual([t('applications_none', 'es')]);
    expect(ctx.stateContext.applications_menu).toBeNull();
    expect(result).toEqual({ ids: [], anyNeedsDetails: false });
  });

  it('sendApplicationsListRows does not re-run the SELECT', async () => {
    const ctx = makeCtx();
    const deps = makeDeps(ctx);

    await sendApplicationsListRows(
      client, ctx, [summary({ needsDetails: true })], 'SM1', '+15550000', deps,
    );

    expect(mockQuery).not.toHaveBeenCalled();
    expect(deps.replies).toHaveLength(1);
  });
});

describe('anyNeedsDetails', () => {
  it('is true only when the employer is actually waiting on something', () => {
    expect(anyNeedsDetails([summary(), summary({ needsDetails: true })])).toBe(true);
    expect(anyNeedsDetails([summary(), summary()])).toBe(false);
    expect(anyNeedsDetails([])).toBe(false);
  });
});

describe('parseApplicationsMenuPick', () => {
  const menu = { applications_menu: { ids: [APP_A, APP_B], at: NOW_MS } };

  it('resolves a 1-based digit against the armed menu', () => {
    expect(parseApplicationsMenuPick(menu, '1')).toBe(APP_A);
    expect(parseApplicationsMenuPick(menu, ' 2 ')).toBe(APP_B);
  });

  it('stands down while a pending_picker owns the reply', () => {
    // A disambiguation/chats/close-reason pick is a structured flow that owns
    // the worker's next message; the menu must not race it for a digit.
    expect(parseApplicationsMenuPick({ ...menu, pending_picker: ['x'] }, '1')).toBeNull();
  });

  it('returns null for no menu, an out-of-range number, and non-digit text', () => {
    expect(parseApplicationsMenuPick({}, '1')).toBeNull();
    expect(parseApplicationsMenuPick(null, '1')).toBeNull();
    expect(parseApplicationsMenuPick({ applications_menu: { ids: [] } }, '1')).toBeNull();
    expect(parseApplicationsMenuPick(menu, '3')).toBeNull();
    expect(parseApplicationsMenuPick(menu, '0')).toBeNull();
    expect(parseApplicationsMenuPick(menu, '1 aceptar')).toBeNull();
    expect(parseApplicationsMenuPick(menu, undefined)).toBeNull();
  });

  it('ignores a corrupt menu whose ids are not strings', () => {
    expect(parseApplicationsMenuPick({ applications_menu: { ids: [42] } }, '1')).toBeNull();
    expect(parseApplicationsMenuPick({ applications_menu: { ids: 'nope' } }, '1')).toBeNull();
  });
});
