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

  // THE contract of this suite. The seeded Content body is what a worker sees
  // OUTSIDE WhatsApp's 24h session window; `__fallback_body` (built by
  // buildApplicationStageMessage) is what they see inside it. If the two
  // diverge, the same notification reads differently depending on when it
  // arrives, and nothing else in the codebase would catch it. The expected
  // string is derived from the real function, so the two cannot drift.
  it.each(APPLICATION_TEMPLATES)(
    '%s body is byte-identical to the fallback body once {{n}} are substituted',
    (name, lang, kind) => {
      const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';
      const jobTitle = 'Electricista Comercial';
      const companyName = 'Acme Concrete LLC';
      const url = `https://jaleapp.ai/${lang}/worker/applications/${APPLICATION_ID}`;

      const { body: expected } = buildApplicationStageMessage(lang, {
        kind,
        jobTitle,
        companyName,
        applicationId: APPLICATION_ID,
        url,
      });

      const substituted = QUICK_REPLY_DEFINITIONS[name].body
        .replace(/\{\{1\}\}/g, jobTitle)
        .replace(/\{\{2\}\}/g, companyName)
        .replace(/\{\{3\}\}/g, `app-${APPLICATION_ID}`)
        .replace(/\{\{4\}\}/g, url);

      expect(substituted).toBe(expected);
    },
  );

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
