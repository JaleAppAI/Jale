import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApplicationStageMessage } from '../../../lambda/lib/application-stage-notify';
import { FALLBACK_BODY_KEY } from '../../../lambda/whatsapp/lib/outbox';
import type { PreferredLanguage } from '../../../lambda/whatsapp/lib/onboarding-types';

/**
 * `scripts/seed-whatsapp-twilio-templates.mjs` is an ESM module whose
 * top-level `main()` talks to Secrets Manager and the Twilio Content API the
 * moment it is loaded, so it can never be imported here. Its definition
 * objects are self-contained literals, though, so they can be lifted out of
 * the source text and evaluated in isolation -- which gives real objects to
 * assert against instead of brittle substring matching. (The bodies are
 * written as concatenated string literals across several source lines, so a
 * raw-text comparison could not match the copy anyway.)
 */
const SCRIPT_PATH = join(__dirname, '../../../scripts/seed-whatsapp-twilio-templates.mjs');
const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

function literal<T>(name: string): T {
  const match = new RegExp(`const ${name} = ([\\s\\S]*?);\\n`).exec(SOURCE);
  if (!match) throw new Error(`${name} not found in ${SCRIPT_PATH}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]}`)() as T;
}

interface QuickReplyDefinition {
  language: PreferredLanguage;
  body: string;
  example: string[];
  actions: Array<{ title: string; id: string }>;
}
interface ListPickerDefinition {
  language: PreferredLanguage;
  body: string;
  button: string;
  items: Array<{ id: string; item: string; description: string }>;
}

const QUICK_REPLY_DEFINITIONS = literal<Record<string, QuickReplyDefinition>>('QUICK_REPLY_DEFINITIONS');
const HELP_MENU_LIST_DEFINITIONS = literal<Record<string, ListPickerDefinition>>('HELP_MENU_LIST_DEFINITIONS');
const FORCE_RECREATE = literal<Set<string>>('FORCE_RECREATE');
const WHATSAPP_APPROVAL_CATEGORY = literal<string>('WHATSAPP_APPROVAL_CATEGORY');

const APPLICATION_TEMPLATES: ReadonlyArray<[string, PreferredLanguage, 'details_requested' | 'hired']> = [
  ['application_update_es', 'es', 'details_requested'],
  ['application_update_en', 'en', 'details_requested'],
  ['application_hired_es', 'es', 'hired'],
  ['application_hired_en', 'en', 'hired'],
];

describe('seed-whatsapp-twilio-templates.mjs — sprint 23 application templates', () => {
  it('defines exactly the four application_* templates', () => {
    expect(Object.keys(QUICK_REPLY_DEFINITIONS).sort()).toEqual(
      APPLICATION_TEMPLATES.map(([name]) => name).sort(),
    );
  });

  it.each(APPLICATION_TEMPLATES)('%s declares the language it is seeded under', (name, lang) => {
    expect(QUICK_REPLY_DEFINITIONS[name].language).toBe(lang);
  });

  // ── The body rules, after the 2026-09-04 resubmission (D6) ──
  //
  // TWO contracts live here now, and both are load-bearing:
  //
  //  1. BYTE-IDENTITY with the renderer's fallback body. The seeded Content
  //     body is what a worker sees OUTSIDE WhatsApp's 24h session window;
  //     `__fallback_body` (built by buildApplicationStageMessage) is what they
  //     see inside it. If the two diverge, one notification reads two
  //     different ways depending on when the employer happened to trigger it,
  //     and nothing else in the codebase would catch it.
  //  2. The META SHAPE rules the first submission was rejected or
  //     recategorised on: no variable at the start or end, a fixed
  //     transactional opening, only the indices the renderer fills, and no
  //     promotional register. These are new in sprint 24 (D6) and are the
  //     reason the copy on BOTH sides changed.
  //
  // The two together are what make the D6 rewrite safe: (2) fixes the copy
  // for Meta, and (1) forces the renderer to move with it rather than leaving
  // in-window workers on the old promotional wording.
  const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';

  function rendererMessage(lang: PreferredLanguage, kind: 'details_requested' | 'hired') {
    return buildApplicationStageMessage(lang, {
      kind,
      jobTitle: 'Electricista Comercial',
      companyName: 'Acme Concrete LLC',
      applicationId: APPLICATION_ID,
      url: `https://jaleapp.ai/${lang}/worker/applications/${APPLICATION_ID}`,
    });
  }

  it.each(APPLICATION_TEMPLATES)(
    '%s is the template name the renderer asks the sender for',
    (name, lang, kind) => {
      expect(rendererMessage(lang, kind).contentTemplate).toBe(name);
    },
  );

  // Contract 1. The expected string is DERIVED from the real function, so the
  // two sides cannot drift: editing either the template copy or
  // buildApplicationStageMessage without the other fails right here.
  it.each(APPLICATION_TEMPLATES)(
    '%s body is byte-identical to the fallback body once {{n}} are substituted',
    (name, lang, kind) => {
      const { body: expected, contentVariables } = rendererMessage(lang, kind);

      const substituted = QUICK_REPLY_DEFINITIONS[name].body
        .replace(/\{\{1\}\}/g, contentVariables['1'])
        .replace(/\{\{2\}\}/g, contentVariables['2'])
        .replace(/\{\{3\}\}/g, contentVariables['3'])
        .replace(/\{\{4\}\}/g, contentVariables['4']);

      expect(substituted).toBe(expected);
      // ...and the fallback the sender actually transmits is that same string,
      // not a second copy of it built somewhere else.
      expect(contentVariables[FALLBACK_BODY_KEY]).toBe(expected);
    },
  );

  // The one contract that survives from the byte-identical era, and the one
  // the task text names explicitly: every {{n}} the template uses must be a
  // key the renderer actually fills. A template referencing {{5}} is a Twilio
  // 400 on every send; one referencing {{2}} where the renderer means the job
  // title is a message that names the wrong thing to the worker.
  it.each(APPLICATION_TEMPLATES)(
    '%s only references variables the renderer supplies (numbering and meaning)',
    (name, lang, kind) => {
      const { contentVariables } = rendererMessage(lang, kind);
      const supplied = new Set(
        Object.keys(contentVariables).filter((key) => /^\d+$/.test(key)),
      );
      // The renderer's contract, pinned so a reordering there is caught here.
      expect([...supplied].sort()).toEqual(['1', '2', '3', '4']);

      const definition = QUICK_REPLY_DEFINITIONS[name];
      const referenced = [
        definition.body,
        ...definition.actions.map((action) => action.id),
      ].flatMap((text) => [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => match[1]));
      expect(referenced.length).toBeGreaterThan(0);
      for (const index of referenced) expect(supplied.has(index)).toBe(true);

      // MEANING, not just numbering. The renderer side is pinned first:
      // 1 = job title, 2 = company, 3 = the app-<uuid> reference the button
      // parser expects, 4 = the worker's stage-2 URL.
      expect(contentVariables['1']).toBe('Electricista Comercial');
      expect(contentVariables['2']).toBe('Acme Concrete LLC');
      expect(contentVariables['3']).toBe(`app-${APPLICATION_ID}`);
      expect(contentVariables['4']).toBe(
        `https://jaleapp.ai/${lang}/worker/applications/${APPLICATION_ID}`,
      );
      // ...and the approval sample at each index must be a value OF THAT KIND,
      // or Meta reviews the template against samples that contradict the copy.
      expect(definition.example).toHaveLength(4);
      expect(definition.example[2]).toMatch(/^app-[0-9a-f-]{36}$/);
      expect(definition.example[3]).toContain(`/${lang}/worker/applications/`);
      expect(definition.example[0]).not.toContain('://');
      expect(definition.example[1]).not.toContain('://');
    },
  );

  // Meta rejected an earlier revision with "Variables can't be at the start
  // or end of the template". Both ends, both languages, every template.
  it.each(APPLICATION_TEMPLATES)('%s never starts or ends with a variable', (name) => {
    const body = QUICK_REPLY_DEFINITIONS[name].body;
    expect(body).not.toMatch(/^\s*\{\{\d+\}\}/);
    expect(body).not.toMatch(/\{\{\d+\}\}\s*$/);
    // Not merely "not at index 0": the opening must be real fixed text a
    // reviewer can read, which is also what keeps the category defensible.
    expect(body.indexOf('{{')).toBeGreaterThan(15);
  });

  // The fixed opening, pinned per template. This is the half of the D6 change
  // Meta actually reads: a UTILITY template has to announce itself as an
  // update about something the recipient already did.
  it.each([
    ['application_update_en', 'Application update for {{1}}:'],
    ['application_update_es', 'Actualizacion de tu aplicacion para {{1}}:'],
    ['application_hired_en', 'Application status update for {{1}}:'],
    ['application_hired_es', 'Actualizacion del estado de tu aplicacion para {{1}}:'],
  ])('%s opens with its fixed transactional lead-in', (name, opening) => {
    expect(QUICK_REPLY_DEFINITIONS[name].body.startsWith(opening)).toBe(true);
  });

  // D6: Meta reclassified application_hired_* and application_update_es to
  // MARKETING on 2026-09-04, and a MARKETING template cannot carry a
  // transactional notification outside the session window. The wording is the
  // only lever this repo has over that classification, so the promotional
  // register is banned by test rather than by good intentions.
  const PROMOTIONAL_PHRASES = [
    'good news', 'great news', 'buenas noticias', 'excelentes noticias',
    'opportunity', 'oportunidad',
    "don't miss", 'dont miss', 'no te lo pierdas',
    'congratulations', 'felicidades', 'enhorabuena',
    'exciting', 'emocionante',
    'hurry', 'apurate', 'act now', 'aprovecha',
    'limited time', 'tiempo limitado',
    'free', 'gratis',
  ];
  it.each(APPLICATION_TEMPLATES)('%s carries no promotional register', (name) => {
    const body = QUICK_REPLY_DEFINITIONS[name].body.toLowerCase();
    for (const phrase of PROMOTIONAL_PHRASES) {
      expect(body).not.toContain(phrase);
    }
    // An exclamation mark is the cheapest MARKETING signal there is.
    expect(body).not.toContain('!');
  });

  it.each(APPLICATION_TEMPLATES)('%s leaves no unsubstituted placeholder behind', (name) => {
    // Every {{n}} in the seeded body must be one of the four the sender fills;
    // an unknown index is a Twilio 400 that __fallback_body cannot rescue.
    const indexes = [...QUICK_REPLY_DEFINITIONS[name].body.matchAll(/\{\{(\d+)\}\}/g)]
      .map((m) => m[1]);
    for (const index of indexes) {
      expect(['1', '2', '3', '4']).toContain(index);
    }
  });

  // Only the update pair is actionable. `application_hired_*` is
  // informational, and a quick-reply Content with an empty action list is
  // rejected by Twilio -- which is why createQuickReplyContent sends those two
  // as `twilio/text` instead.
  it.each(['application_update_es', 'application_update_en'])(
    '%s carries exactly the two quick-reply button ids the parser understands',
    (name) => {
      expect(QUICK_REPLY_DEFINITIONS[name].actions.map((a) => a.id)).toEqual([
        'application:start:{{3}}',
        'application:later:{{3}}',
      ]);
      // Both labels are real, distinct, and localized -- a blank title is a
      // button the worker cannot identify.
      const titles = QUICK_REPLY_DEFINITIONS[name].actions.map((a) => a.title);
      expect(titles.every((title) => title.trim().length > 0)).toBe(true);
      expect(new Set(titles).size).toBe(2);
    },
  );

  it.each(['application_hired_es', 'application_hired_en'])('%s carries no buttons', (name) => {
    expect(QUICK_REPLY_DEFINITIONS[name].actions).toEqual([]);
  });

  it('sends button-less definitions as twilio/text, not an empty quick-reply', () => {
    expect(SOURCE).toContain("'twilio/quick-reply'");
    expect(SOURCE).toContain("'twilio/text'");
    expect(SOURCE).toMatch(/definition\.actions\.length > 0/);
  });
});

describe('seed-whatsapp-twilio-templates.mjs — help menu recreation', () => {
  // A Twilio Content resource is IMMUTABLE, so the skip-if-present rule the
  // other definitions use would keep serving the pre-sprint-23 menu forever
  // once a SID is stored. Both list pickers must therefore be force-recreated.
  it('force-recreates both help menu list pickers', () => {
    expect([...FORCE_RECREATE].sort()).toEqual(['help_menu_list_en', 'help_menu_list_es']);
  });

  it('force-recreates nothing else (a needless recreate burns a Content resource)', () => {
    for (const name of FORCE_RECREATE) {
      expect(HELP_MENU_LIST_DEFINITIONS[name]).toBeDefined();
    }
  });

  it.each(['help_menu_list_es', 'help_menu_list_en'])(
    '%s offers the command:applications row',
    (name) => {
      const items = HELP_MENU_LIST_DEFINITIONS[name].items;
      const applications = items.find((item) => item.id === 'command:applications');
      expect(applications).toBeDefined();
      // parseCommandPayload (flows.ts) is what receives this id.
      expect(applications!.item.trim().length).toBeGreaterThan(0);
      expect(applications!.description.trim().length).toBeGreaterThan(0);
    },
  );

  it('keeps the applications row directly after jobs, matching the help_menu text fallback', () => {
    for (const name of ['help_menu_list_es', 'help_menu_list_en']) {
      const ids = HELP_MENU_LIST_DEFINITIONS[name].items.map((item) => item.id);
      expect(ids.indexOf('command:applications')).toBe(ids.indexOf('command:jobs') + 1);
    }
  });

  it('localizes the applications row label per language', () => {
    expect(HELP_MENU_LIST_DEFINITIONS.help_menu_list_es.items
      .find((i) => i.id === 'command:applications')!.item).toBe('Aplicaciones');
    expect(HELP_MENU_LIST_DEFINITIONS.help_menu_list_en.items
      .find((i) => i.id === 'command:applications')!.item).toBe('Applications');
  });
});

describe('seed-whatsapp-twilio-templates.mjs — WhatsApp approval submission', () => {
  // A Content resource that is never submitted is never approved, and an
  // unapproved template cannot be sent outside the 24h window -- which is
  // exactly when an employer-triggered stage notification goes out. The script
  // therefore has to submit, not merely create.
  it('submits application templates through the ApprovalRequests/whatsapp endpoint', () => {
    expect(SOURCE).toMatch(/\/ApprovalRequests\/whatsapp`/);
    expect(SOURCE).toMatch(/ensureWhatsAppApprovals\(\s*verifiedSecret\.templates/);
  });

  it('classifies all four as UTILITY (transactional updates about an existing application)', () => {
    expect(WHATSAPP_APPROVAL_CATEGORY).toBe('UTILITY');
    expect(SOURCE).toMatch(/category: WHATSAPP_APPROVAL_CATEGORY/);
  });

  // D6 (2026-09-04). Meta silently recategorised three of the four templates
  // to MARKETING while they were pending, and a MARKETING template cannot
  // carry a transactional notification outside the 24h window -- the only
  // window an employer-triggered notification ever lands in. With
  // allow_category_change false Meta must REJECT a template it disagrees
  // with, which is a visible, actionable failure instead of an approval that
  // silently does not work.
  it('forbids Meta from reclassifying the category (allow_category_change: false)', () => {
    expect(SOURCE).toMatch(/allow_category_change:\s*false/);
    // In the ApprovalRequests POST body, beside name and category -- not in a
    // comment and not on the Content create call, which has no such field.
    const approvalBody = /ApprovalRequests\/whatsapp`[\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\)/
      .exec(SOURCE)?.[1] ?? '';
    expect(approvalBody).toContain('name');
    expect(approvalBody).toContain('category: WHATSAPP_APPROVAL_CATEGORY');
    expect(approvalBody).toMatch(/allow_category_change:\s*false/);
  });

  it('submits only templates that have never been submitted, and never re-submits', () => {
    // Re-submitting a pending/approved/rejected template is a Twilio 4xx at
    // best and a lost approval at worst; the gate is the literal string Twilio
    // reports for a fresh Content resource.
    expect(SOURCE).toMatch(/status === 'unsubmitted'/);
    expect(SOURCE).toMatch(/json\?\.whatsapp\?\.status \?\? 'unsubmitted'/);
  });

  it.each(APPLICATION_TEMPLATES)('%s is a valid WhatsApp template name (lowercase, digits, underscores)', (name) => {
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  it('never submits the help-menu list pickers (session messages need no approval)', () => {
    expect(SOURCE).toMatch(/for \(const name of Object\.keys\(QUICK_REPLY_DEFINITIONS\)\)[\s\S]*?whatsappApprovalStatus/);
    expect(SOURCE).not.toMatch(/HELP_MENU_LIST_DEFINITIONS[\s\S]{0,200}ApprovalRequests/);
  });
});

describe('seed-whatsapp-twilio-templates.mjs — --recreate-application-templates', () => {
  // A Twilio Content resource is IMMUTABLE. The four application_* templates
  // are already created and pending, so the D6 copy rewrite cannot reach Meta
  // by editing them -- it needs four NEW resources whose SIDs replace the old
  // ones in the secret. The default run deliberately will not do that (it
  // skips a name whose stored SID is not `rejected`), hence an explicit flag.
  it('is an opt-in flag, not something the default run does', () => {
    expect(SOURCE).toContain('--recreate-application-templates');
    expect(SOURCE).toMatch(/process\.argv/);
  });

  it('creates NEW resources for exactly the four application_* names and submits them', () => {
    const block = /async function recreateApplicationTemplates\(([\s\S]*?)\n\}/.exec(SOURCE)?.[1];
    expect(block).toBeDefined();
    // Creates through the same quick-reply/text builder the default path uses,
    // so the twilio/text fallback for the button-less pair still applies.
    expect(block!).toContain('createQuickReplyContent');
    expect(block!).toContain('QUICK_REPLY_DEFINITIONS');
    // A new resource that is never submitted is a new resource that can never
    // be sent outside the session window -- the whole point of the exercise.
    expect(block!).toContain('ensureWhatsAppApprovals');
    // The secret is the only place the sender reads SIDs from.
    expect(block!).toMatch(/UpdateSecretCommand|persistTemplates/);
  });

  it('prints names, SIDs and statuses only -- never the secret', () => {
    // The secret carries authToken and every other template SID. Anything
    // that interpolates the parsed object into a log line, or stringifies it,
    // leaks credentials into an operator's terminal and their shell history.
    // The check is on the VALUE reaching a log call, not on the word
    // appearing in a message ("...referenced by the secret" is fine).
    expect(SOURCE).not.toMatch(
      /console\.(log|error)\([^;]*\$\{\s*(?:next|verified|current)?[Ss]ecret\b(?![A-Za-z_])/,
    );
    expect(SOURCE).not.toMatch(/console\.(log|error)\([^;]*JSON\.stringify\(/);
    expect(SOURCE).not.toMatch(/console\.(log|error)\([^;]*authToken/);
    expect(SOURCE).not.toMatch(/console\.(log|error)\([^;]*SecretString/);
  });
});

describe('seed-whatsapp-twilio-templates.mjs — --purge-stale', () => {
  // 2026-09-04 account state: repeated seed runs left 16 REJECTED
  // application_* copies and 12 UNSUBMITTED help_menu_list_* duplicates
  // behind. They are noise in every console listing and in every
  // --verify-templates run, and one of them is one mistyped SID away from
  // being served. Purging them is destructive, so the selection rule is
  // pinned here against a fixture list rather than trusted to a dry run.
  const isPurgeCandidate = literal<(
    resource: { sid: string; friendlyName: string; status: string },
    managedNames: Set<string>,
    referencedSids: Set<string>,
  ) => boolean>('isPurgeCandidate');

  const managed = new Set([
    ...Object.keys(QUICK_REPLY_DEFINITIONS),
    ...Object.keys(HELP_MENU_LIST_DEFINITIONS),
  ]);
  const referenced = new Set(['HX_live_update_en', 'HX_live_help_en', 'HX_live_employer']);

  function resource(friendlyName: string, status: string, sid = `HX${friendlyName}_${status}`) {
    return { sid, friendlyName, status };
  }

  it('purges a rejected copy of a managed template', () => {
    expect(isPurgeCandidate(resource('application_update_en', 'rejected'), managed, referenced))
      .toBe(true);
  });

  it('purges an unsubmitted duplicate of a managed template', () => {
    expect(isPurgeCandidate(resource('help_menu_list_es', 'unsubmitted'), managed, referenced))
      .toBe(true);
  });

  it.each(['approved', 'pending', 'received', 'paused', 'disabled'])(
    'never purges a %s resource, managed name or not',
    (status) => {
      expect(isPurgeCandidate(resource('application_hired_es', status), managed, referenced))
        .toBe(false);
    },
  );

  it.each([
    ['a rejected', 'rejected', 'HX_live_update_en'],
    ['an unsubmitted', 'unsubmitted', 'HX_live_help_en'],
  ])('never purges %s resource the secret still references', (_label, status, sid) => {
    // The referenced-SID guard is unconditional on purpose. A SID in the
    // secret is what the sender will hand Twilio on the next drain; deleting
    // it turns a template problem into a 21655 on every send.
    expect(isPurgeCandidate(
      resource('application_update_en', status, sid), managed, referenced,
    )).toBe(false);
  });

  it('never purges a resource this script does not manage', () => {
    // NEW_TEMPLATES entries are hardcoded live SIDs created by hand in the
    // Twilio console, and the account holds other people's Content too.
    for (const name of ['v2_onboarding_start_en', 'employer_message_invite_en', 'someone_elses']) {
      expect(isPurgeCandidate(resource(name, 'rejected'), managed, referenced)).toBe(false);
      expect(isPurgeCandidate(resource(name, 'unsubmitted'), managed, referenced)).toBe(false);
    }
  });

  it('selects exactly the stale rows out of a mixed account listing', () => {
    const listing = [
      ...Array.from({ length: 16 }, (_, i) => resource('application_update_es', 'rejected', `HXrej${i}`)),
      ...Array.from({ length: 12 }, (_, i) => resource('help_menu_list_en', 'unsubmitted', `HXuns${i}`)),
      resource('application_update_en', 'pending', 'HX_live_update_en'),
      resource('application_hired_en', 'approved', 'HXapproved'),
      resource('help_menu_list_en', 'unsubmitted', 'HX_live_help_en'),
      resource('employer_message_invite_en', 'approved', 'HX_live_employer'),
      resource('v2_onboarding_start_en', 'unsubmitted', 'HXunmanaged'),
    ];
    const purged = listing.filter((row) => isPurgeCandidate(row, managed, referenced));
    expect(purged).toHaveLength(28);
    expect(new Set(purged.map((row) => row.friendlyName)))
      .toEqual(new Set(['application_update_es', 'help_menu_list_en']));
  });

  it('defaults to a dry run and needs --apply to delete anything', () => {
    expect(SOURCE).toContain('--purge-stale');
    expect(SOURCE).toContain('--apply');
    const block = /async function purgeStaleTemplates\(([\s\S]*?)\n\}/.exec(SOURCE)?.[1];
    expect(block).toBeDefined();
    // The DELETE is reachable only behind the apply flag. Asserted as
    // ORDERING rather than as one spelling of the guard: the gate has to come
    // before the only call that destroys anything, whether it is written as
    // `if (apply)` around the loop or `if (!apply) return` in front of it.
    expect(block!).toContain('deleteContent');
    expect(block!).toMatch(/\bapply\b/);
    const gate = block!.search(/if\s*\(\s*!?\s*apply\s*\)/);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(block!.indexOf('deleteContent('));
    // A dry run must say so, so an operator can tell the two modes apart.
    expect(block!).toMatch(/Dry run/i);
    // Counts and names only: a listing dump would include every SID in the
    // account alongside the ones being removed.
    expect(block!).not.toMatch(/JSON\.stringify\(/);
  });

  it('reads status and category from the ContentAndApprovals listing, with paging', () => {
    expect(SOURCE).toContain('ContentAndApprovals');
    // Twilio pages this endpoint; a single-page read silently misses the tail
    // of a 40-resource account, which is exactly the situation here.
    expect(SOURCE).toMatch(/next_page_url/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 (2026-09-04): `--set-template <name>=<HX sid>`
//
// Luis created two new UTILITY quick-reply Content templates by hand in the
// Twilio Console for the job-card relabel (D8), so their SIDs exist nowhere in
// this repo. The runtime reads the job-card SID from `templates.job_alert_es` /
// `templates.job_alert_en`, and this script owns the only sanctioned write to
// that secret -- but it had no way to point an EXISTING key at an EXISTING SID.
//
// These tests drive the script's REAL source through `process.argv`. See
// `loadScript`: the module cannot be imported (jest is CommonJS here and a
// native dynamic import of an .mjs needs --experimental-vm-modules, which this
// repo's jest.config.js does not enable), so the file's own text is evaluated
// with `fetch`, `console` and the Secrets Manager import injected as
// parameters that shadow the globals. No network, no AWS, no real credentials.
// ─────────────────────────────────────────────────────────────────────────────

/** The only two lines `loadScript` rewrites; both are asserted to match. */
const SDK_IMPORT_LINE = /^import \{[^}]*\} from '@aws-sdk\/client-secrets-manager';$/m;
const RUN_CLI_CALL = /^runCli\(\);$/m;

interface FetchSpec { ok: boolean; status?: number; body?: unknown; text?: string }

// Obviously-fake credentials. Nothing here is a real account SID or token, and
// no test ever lets either reach a log line (asserted at the end of the block).
const FAKE_ACCOUNT_SID = 'ACtest0000000000000000000000000001';
const FAKE_AUTH_TOKEN = 'test-token';

// The two REAL ContentSids from the Twilio Console. ContentSids are not
// secrets; these are the values an operator will actually pass.
const JOB_ALERT_ES_V2 = 'HX9d11a813387caa21682983c546dc77c6';
const JOB_ALERT_EN_V2 = 'HX58e1aec8a1efc930a70ac3927a20b2d5';

const STORED_TEMPLATES = {
  job_alert_es: 'HX1111111111111111111111111111aaaa',
  job_alert_en: 'HX1111111111111111111111111111bbbb',
  employer_message_invite_en: 'HX1111111111111111111111111111cccc',
  // A NEW_TEMPLATES key whose STORED SID differs from the hardcoded one.
  // `--set-template` must leave it exactly as found: it goes through
  // writeAndVerifyTemplates, not mergeTemplates, precisely so a manual SID
  // correction cannot silently revert 24 SIDs it was never asked about.
  onboarding_trade_en: 'HX1111111111111111111111111111dddd',
};

const FAKE_SECRET = {
  accountSid: FAKE_ACCOUNT_SID,
  authToken: FAKE_AUTH_TOKEN,
  messagingServiceSid: 'MGtest0000000000000000000000000001',
  templates: STORED_TEMPLATES,
};

interface Harness {
  runCli: () => Promise<void>;
  send: jest.Mock;
  fetchMock: jest.Mock;
  logs: string[];
  errors: string[];
  storedSecret: () => any;
  updateCalls: () => any[];
  sendKinds: () => string[];
  fetchMethods: () => string[];
}

function loadScript(opts: {
  argv?: string[];
  secret?: object;
  fetchHandler?: (url: string) => FetchSpec;
}): Harness {
  // A silent no-match here would evaluate code that never runs and let every
  // assertion below pass against nothing.
  if (!SDK_IMPORT_LINE.test(SOURCE)) {
    throw new Error('loader out of date: @aws-sdk/client-secrets-manager import line not found');
  }
  if (!RUN_CLI_CALL.test(SOURCE)) {
    throw new Error('loader out of date: the `runCli();` entrypoint call was not found');
  }

  const body = SOURCE
    .replace(
      SDK_IMPORT_LINE,
      'const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = __sdk;',
    )
    .replace(RUN_CLI_CALL, '')
    + '\nreturn { runCli };';

  // A real read-after-write: the verify GetSecretValue reads back exactly what
  // UpdateSecret stored, so the persistence check is genuinely exercised.
  let stored = JSON.stringify(opts.secret ?? FAKE_SECRET);
  const updateCalls: any[] = [];
  const send = jest.fn(async (command: any) => {
    if (command.__kind === 'UpdateSecret') {
      updateCalls.push(command.input);
      stored = command.input.SecretString;
      return {};
    }
    return { SecretString: stored };
  });

  const sdk = {
    SecretsManagerClient: jest.fn(() => ({ send })),
    GetSecretValueCommand: jest.fn((input: any) => ({ __kind: 'GetSecretValue', input })),
    UpdateSecretCommand: jest.fn((input: any) => ({ __kind: 'UpdateSecret', input })),
  };

  const fetchMock = jest.fn(async (url: string) => {
    const spec = opts.fetchHandler?.(String(url)) ?? { ok: true, body: {} };
    return {
      ok: spec.ok,
      status: spec.status ?? (spec.ok ? 200 : 404),
      json: async () => spec.body ?? {},
      // Every non-ok branch in the script calls `res.text().catch(() => '')`.
      text: async () => spec.text ?? '',
    } as unknown as Response;
  });

  const logs: string[] = [];
  const errors: string[] = [];
  const consoleStub = {
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
    error: (...args: unknown[]) => { errors.push(args.map(String).join(' ')); },
  };

  // ARGS is computed at module top level, so argv must be in place while the
  // body evaluates -- which happens inside this try.
  const originalArgv = process.argv;
  process.argv = ['node', SCRIPT_PATH, ...(opts.argv ?? [])];
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('__sdk', 'fetch', 'console', body);
    const { runCli } = factory(sdk, fetchMock, consoleStub) as { runCli: () => Promise<void> };
    return {
      runCli,
      send,
      fetchMock,
      logs,
      errors,
      storedSecret: () => JSON.parse(stored),
      updateCalls: () => updateCalls,
      sendKinds: () => send.mock.calls.map(([command]: any[]) => command.__kind),
      fetchMethods: () => fetchMock.mock.calls.map(([, init]: any[]) => init?.method ?? 'GET'),
    };
  } finally {
    process.argv = originalArgv;
  }
}

/** Twilio Content + ApprovalRequests responses, keyed by ContentSid. */
function contentFetch(specs: Record<string, {
  exists?: boolean; friendlyName?: string; status?: string; category?: string;
}>) {
  return (url: string): FetchSpec => {
    const sid = /\/Content\/(HX[0-9a-f]+)/.exec(url)?.[1] ?? '';
    const spec = specs[sid];
    if (!spec || spec.exists === false) return { ok: false, status: 404 };
    if (url.endsWith('/ApprovalRequests')) {
      return {
        ok: true,
        body: { whatsapp: { status: spec.status ?? 'approved', category: spec.category ?? 'UTILITY' } },
      };
    }
    return { ok: true, body: { sid, friendly_name: spec.friendlyName ?? `${sid}_name` } };
  };
}

const BOTH_APPROVED = contentFetch({
  [JOB_ALERT_ES_V2]: { friendlyName: 'job_alert_es_v2' },
  [JOB_ALERT_EN_V2]: { friendlyName: 'job_alert_en_v2' },
});

describe('seed-whatsapp-twilio-templates.mjs — --set-template', () => {
  // A test that leaves process.exitCode at 1 makes the whole jest run exit
  // non-zero with every test green -- a phantom failure that is very hard to
  // trace back to here.
  const originalExitCode = process.exitCode;
  afterEach(() => { process.exitCode = originalExitCode; });

  it('points both job-card keys at the new SIDs, preserving every other key', async () => {
    const harness = loadScript({
      argv: [
        '--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`,
        '--set-template', `job_alert_en=${JOB_ALERT_EN_V2}`,
      ],
      fetchHandler: BOTH_APPROVED,
    });
    await harness.runCli();

    expect(harness.errors).toEqual([]);
    expect(process.exitCode).toBeFalsy();

    // Exactly the specified lines, in order, and NOTHING else: a stray line is
    // the leak surface this mode has to be trusted not to have.
    expect(harness.logs).toEqual([
      `job_alert_es\t${JOB_ALERT_ES_V2}\tjob_alert_es_v2\tapproved\tUTILITY`,
      `job_alert_en\t${JOB_ALERT_EN_V2}\tjob_alert_en_v2\tapproved\tUTILITY`,
      'updated templates.job_alert_es',
      'updated templates.job_alert_en',
    ]);

    // One write, and the merged map keeps every key it did not name --
    // including onboarding_trade_en, whose stored SID differs from the
    // hardcoded NEW_TEMPLATES value.
    expect(harness.updateCalls()).toHaveLength(1);
    expect(harness.storedSecret().templates).toEqual({
      ...STORED_TEMPLATES,
      job_alert_es: JOB_ALERT_ES_V2,
      job_alert_en: JOB_ALERT_EN_V2,
    });
    expect(harness.storedSecret().templates.onboarding_trade_en)
      .toBe(STORED_TEMPLATES.onboarding_trade_en);
    // The non-template halves of the secret survive untouched.
    expect(harness.storedSecret().authToken).toBe(FAKE_AUTH_TOKEN);
    expect(harness.storedSecret().messagingServiceSid).toBe(FAKE_SECRET.messagingServiceSid);

    // Read, write, then a read-BACK that proves it landed.
    expect(harness.sendKinds()).toEqual(['GetSecretValue', 'UpdateSecret', 'GetSecretValue']);

    // Never creates or deletes a Content resource, and never runs the default
    // seed: four reads (Content + ApprovalRequests per template) and no more.
    expect(harness.fetchMethods()).toEqual(['GET', 'GET', 'GET', 'GET']);
  });

  it('accepts the --set-template=name=sid spelling for a single pair', async () => {
    const harness = loadScript({
      argv: [`--set-template=job_alert_es=${JOB_ALERT_ES_V2}`],
      fetchHandler: BOTH_APPROVED,
    });
    await harness.runCli();

    expect(harness.errors).toEqual([]);
    expect(harness.logs).toEqual([
      `job_alert_es\t${JOB_ALERT_ES_V2}\tjob_alert_es_v2\tapproved\tUTILITY`,
      'updated templates.job_alert_es',
    ]);
    expect(harness.storedSecret().templates.job_alert_es).toBe(JOB_ALERT_ES_V2);
    // The key it was not asked about keeps its stored SID.
    expect(harness.storedSecret().templates.job_alert_en).toBe(STORED_TEMPLATES.job_alert_en);
  });

  // ── Refusals. Every one of these must leave the secret untouched. ──

  async function expectRefusal(opts: Parameters<typeof loadScript>[0], match: RegExp) {
    const harness = loadScript(opts);
    await harness.runCli();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatch(match);
    expect(process.exitCode).toBe(1);
    // The whole point: no UpdateSecret, ever, on a refusal path.
    expect(harness.updateCalls()).toEqual([]);
    expect(harness.sendKinds()).not.toContain('UpdateSecret');
    return harness;
  }

  it('rejects a name that is not a lowercase template identifier', async () => {
    await expectRefusal(
      { argv: ['--set-template', `Job_Alert_ES=${JOB_ALERT_ES_V2}`] },
      /Job_Alert_ES/,
    );
    await expectRefusal(
      { argv: ['--set-template', `1job_alert=${JOB_ALERT_ES_V2}`] },
      /1job_alert/,
    );
  });

  it('rejects a name that is not a key the runtime ever reads', async () => {
    // `job_alert_fr` looks plausible and is a key no sender will ever look up,
    // so the SID would sit in the secret doing nothing.
    await expectRefusal(
      { argv: ['--set-template', `job_alert_fr=${JOB_ALERT_ES_V2}`] },
      /job_alert_fr/,
    );
    // help_menu_list_* is created BY this script and is not in the runtime
    // interface, so it is not settable by hand either.
    await expectRefusal(
      { argv: ['--set-template', `help_menu_list_es=${JOB_ALERT_ES_V2}`] },
      /help_menu_list_es/,
    );
  });

  it.each([
    ['not an HX sid', 'MG9d11a813387caa21682983c546dc77c6'],
    ['too short', 'HX9d11a813'],
    ['non-hex characters', 'HX9d11a813387caa21682983c546dczzz'],
    ['uppercase hex', 'HX9D11A813387CAA21682983C546DC77C6'],
    ['empty', ''],
  ])('rejects a ContentSid that is %s', async (_label, sid) => {
    await expectRefusal({ argv: ['--set-template', `job_alert_es=${sid}`] }, /job_alert_es/);
  });

  it('rejects --set-template with no name=sid value', async () => {
    await expectRefusal({ argv: ['--set-template'] }, /--set-template/);
    // A following flag is a MISSING value, not a malformed name.
    await expectRefusal(
      { argv: ['--set-template', '--purge-stale'] },
      /--set-template/,
    );
  });

  it.each(['--purge-stale', '--recreate-application-templates'])(
    'refuses to combine --set-template with %s',
    async (flag) => {
      await expectRefusal(
        { argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`, flag] },
        /--set-template/,
      );
    },
  );

  it('still rejects an unknown flag alongside --set-template', async () => {
    await expectRefusal(
      { argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`, '--bogus'] },
      /unrecognized flag\(s\): --bogus/,
    );
  });

  it('rejects --allow-pending on its own', async () => {
    await expectRefusal({ argv: ['--allow-pending'] }, /--allow-pending/);
  });

  it('refuses a SID whose Content resource does not exist', async () => {
    const harness = await expectRefusal(
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: contentFetch({ [JOB_ALERT_ES_V2]: { exists: false } }),
      },
      new RegExp(JOB_ALERT_ES_V2),
    );
    // Still one tabular line, so an operator can see WHICH pair was bad.
    expect(harness.logs).toEqual([
      `job_alert_es\t${JOB_ALERT_ES_V2}\t-\tnot_found\t-`,
    ]);
  });

  it('refuses a pending SID unless --allow-pending is passed', async () => {
    const harness = await expectRefusal(
      {
        argv: [
          '--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`,
          '--set-template', `job_alert_en=${JOB_ALERT_EN_V2}`,
        ],
        fetchHandler: contentFetch({
          [JOB_ALERT_ES_V2]: { friendlyName: 'job_alert_es_v2', status: 'pending' },
          [JOB_ALERT_EN_V2]: { friendlyName: 'job_alert_en_v2', status: 'approved' },
        }),
      },
      /pending/,
    );
    // Both statuses are reported in ONE run: refusals are collected, not
    // fail-fast, so an operator does not have to re-run to see the second.
    expect(harness.logs).toEqual([
      `job_alert_es\t${JOB_ALERT_ES_V2}\tjob_alert_es_v2\tpending\tUTILITY`,
      `job_alert_en\t${JOB_ALERT_EN_V2}\tjob_alert_en_v2\tapproved\tUTILITY`,
    ]);
    // ...and the approved one is NOT written either. A partial write would
    // leave the secret half-relabelled with no record of which half.
    expect(harness.storedSecret().templates).toEqual(STORED_TEMPLATES);
  });

  it('writes a pending SID under --allow-pending, with a 63016 warning', async () => {
    const harness = loadScript({
      argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`, '--allow-pending'],
      fetchHandler: contentFetch({
        [JOB_ALERT_ES_V2]: { friendlyName: 'job_alert_es_v2', status: 'pending' },
      }),
    });
    await harness.runCli();

    expect(harness.errors).toEqual([]);
    expect(process.exitCode).toBeFalsy();
    expect(harness.logs).toHaveLength(3);
    expect(harness.logs[0])
      .toBe(`job_alert_es\t${JOB_ALERT_ES_V2}\tjob_alert_es_v2\tpending\tUTILITY`);
    // The warning has to say what will actually happen, not just "careful".
    expect(harness.logs[1]).toMatch(/^WARNING\b/);
    expect(harness.logs[1]).toContain('63016');
    expect(harness.logs[1]).toContain('job_alert_es');
    expect(harness.logs[2]).toBe('updated templates.job_alert_es');
    expect(harness.storedSecret().templates.job_alert_es).toBe(JOB_ALERT_ES_V2);
  });

  it('treats an unreadable approval status as not approved', async () => {
    // If the status cannot be read, the safe reading is "not approved":
    // writing an unapproved SID silently breaks every send.
    await expectRefusal(
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: (url) => (url.endsWith('/ApprovalRequests')
          ? { ok: false, status: 500 }
          : { ok: true, body: { friendly_name: 'job_alert_es_v2' } }),
      },
      /job_alert_es/,
    );
  });

  // ── The credential guard, across every path above ──

  it('never writes the account SID or auth token to stdout or stderr', async () => {
    const scenarios: Array<Parameters<typeof loadScript>[0]> = [
      // happy path
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: BOTH_APPROVED,
      },
      // pending, refused
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: contentFetch({ [JOB_ALERT_ES_V2]: { status: 'pending' } }),
      },
      // pending, allowed
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`, '--allow-pending'],
        fetchHandler: contentFetch({ [JOB_ALERT_ES_V2]: { status: 'pending' } }),
      },
      // 404
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: contentFetch({ [JOB_ALERT_ES_V2]: { exists: false } }),
      },
      // Twilio 5xx, whose error message interpolates the response body
      {
        argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`],
        fetchHandler: () => ({ ok: false, status: 500, text: 'upstream failure' }),
      },
      // bad input
      { argv: ['--set-template', 'job_alert_es=nope'] },
      { argv: ['--set-template', `job_alert_fr=${JOB_ALERT_ES_V2}`] },
      { argv: ['--set-template', `job_alert_es=${JOB_ALERT_ES_V2}`, '--purge-stale'] },
    ];

    for (const scenario of scenarios) {
      const harness = loadScript(scenario);
      await harness.runCli();
      process.exitCode = originalExitCode;
      const printed = [...harness.logs, ...harness.errors].join('\n');
      // The literal fixture values, not the word "authToken": a careless
      // message interpolates the VALUE.
      expect(printed).not.toContain(FAKE_AUTH_TOKEN);
      expect(printed).not.toContain(FAKE_ACCOUNT_SID);
      // The base64 Basic header is the other way a token escapes.
      expect(printed).not.toContain(
        Buffer.from(`${FAKE_ACCOUNT_SID}:${FAKE_AUTH_TOKEN}`).toString('base64'),
      );
      // Something was always reported -- silence would pass the checks above
      // while telling the operator nothing.
      expect(printed.length).toBeGreaterThan(0);
    }
  });

  // ── The allowlist and the runtime interface must not drift ──

  it('allows exactly the template keys the runtime declares in twilio.ts', () => {
    // The script copies this list because reading it from a .ts interface at
    // runtime is impossible, and unioning it with "keys already in the secret"
    // would let a typo that is already stored authorize itself. A hand-copied
    // list drifts silently, so the copy is pinned to its source here.
    const twilioSource = readFileSync(
      join(__dirname, '../../../lambda/whatsapp/lib/twilio.ts'), 'utf8',
    );
    const block = /templates\?:\s*\{([\s\S]*?)\n {2}\};/.exec(twilioSource)?.[1];
    expect(block).toBeDefined();
    const runtimeKeys = [...block!.matchAll(/^\s*([a-z][a-z0-9_]*)\?:\s*string;/gm)]
      .map((match) => match[1]);
    expect(runtimeKeys.length).toBeGreaterThan(30);

    const settable = literal<Set<string>>('SETTABLE_TEMPLATE_KEYS');
    expect([...settable].sort()).toEqual([...runtimeKeys].sort());
    // The job-card keys D8 exists to relabel, named explicitly.
    expect(settable.has('job_alert_es')).toBe(true);
    expect(settable.has('job_alert_en')).toBe(true);
    // Created by this script, absent from the runtime interface, not settable.
    expect(settable.has('help_menu_list_es')).toBe(false);
  });
});
