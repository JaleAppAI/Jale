import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApplicationStageMessage } from '../../../lambda/lib/application-stage-notify';
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
  // The byte-identical-to-the-fallback-body assertion that used to live here
  // is GONE, deliberately. Meta recategorised three of the four templates to
  // MARKETING while they were pending, which makes them unsendable in the
  // only window that matters, and the promotional-sounding openings the
  // fallback bodies carry ("Good news:", "Buenas noticias:") are what invited
  // that. The renderer (lambda/lib/application-stage-notify.ts) is not this
  // lane's to edit, so the template copy and the in-window fallback copy now
  // diverge BY DESIGN: the template is the Meta-approved, strictly
  // transactional wording, and the fallback is what a worker sees inside an
  // open session where Meta polices nothing.
  //
  // What replaces it is the contract that still has to hold -- the VARIABLE
  // NUMBERING AND MEANING the renderer supplies, plus the structural rules
  // Meta rejects on -- checked below against the real function.
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
