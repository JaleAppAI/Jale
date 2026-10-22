import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ACCESS_SURFACES,
  AUDIT_ACTOR_KINDS,
  AUDIT_CATEGORIES,
  AUDIT_PURPOSE_KINDS,
  AUDIT_RECORD_TYPES,
  CHANGE_SURFACES,
  SURFACE_PATTERN,
} from '../../../../../lambda/lib/audit/registry';

const INFRA = path.join(__dirname, '..', '..', '..', '..', '..');
const MIGRATION = fs.readFileSync(path.join(INFRA, 'db', 'migrations', '109_audit_storage.sql'), 'utf8');

/** The body of jale_audit.record_event, the function every record goes through. */
const RECORD_EVENT = (() => {
  const start = MIGRATION.indexOf('CREATE FUNCTION jale_audit.record_event(');
  const end = MIGRATION.indexOf('$fn$;', start);
  if (start < 0 || end < 0) throw new Error('109: jale_audit.record_event not found');
  return MIGRATION.slice(start, end);
})();

function quotedList(afterPattern: RegExp): string[] {
  const match = RECORD_EVENT.match(afterPattern);
  if (!match) throw new Error(`record_event: ${afterPattern} not found`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('audit code lists match record_event', () => {
  it('categories', () => {
    const declaration = RECORD_EVENT.match(/c_categories CONSTANT TEXT := ([\s\S]*?);/)![1];
    const alternatives = declaration.replace(/'\s*'/g, '').match(/\^\(([^)]*)\)\$/)![1].split('|');
    expect([...AUDIT_CATEGORIES].sort()).toEqual(alternatives.sort());
  });

  it('record types', () => {
    expect([...AUDIT_RECORD_TYPES].sort()).toEqual(quotedList(/v_record_type NOT IN \(([\s\S]*?)\)/).sort());
  });

  it('purpose kinds', () => {
    expect([...AUDIT_PURPOSE_KINDS].sort()).toEqual(quotedList(/v_purpose_kind NOT IN \(([\s\S]*?)\)/).sort());
  });

  it('actor kinds', () => {
    expect([...AUDIT_ACTOR_KINDS].sort()).toEqual(quotedList(/v_actor_kind NOT IN \(([\s\S]*?)\)/).sort());
  });
});

describe('the request surface registry', () => {
  it('lists the handlers, categories and record type of each surface', () => {
    const table = Object.fromEntries(Object.entries(ACCESS_SURFACES).map(([surface, entry]) => [
      surface, [entry.handlers.join(','), [...entry.categories].sort().join(','), entry.recordType],
    ]));
    expect(table).toEqual({
      'employer.worker_profile': ['api/employer-worker-profile.ts', 'application_answers,contact_details,profile,trust_assessments', 'job_application'],
      'employer.worker_documents': ['api/employer-worker-docs.ts', 'documents', 'worker_document'],
      'employer.worker_posts': ['api/employer-worker-posts.ts', 'posts', 'worker_post'],
      'employer.job_applicants': ['api/employer-job-applicants.ts', 'application_answers,contact_details,profile', 'job_application'],
      'employer.job_candidates': ['api/employer-job-candidates.ts', 'contact_details,profile,trust_assessments', 'user'],
      'employer.applicants_overview': ['api/employer-applicants-overview.ts', 'application_answers,documents,profile,trust_assessments', 'job_application'],
      'employer.inbox': ['api/employer-inbox.ts', 'conversations', 'job_conversation'],
      'employer.conversations_list': ['api/employer-conversations-list.ts', 'conversations', 'job_conversation'],
      'employer.conversation_detail': ['api/employer-conversations-detail.ts', 'conversations', 'job_conversation'],
      'employer.conversation_create': ['api/employer-conversations-create.ts', 'conversations', 'job_conversation'],
      'employer.conversation_send': ['api/employer-conversations-send.ts', 'conversations', 'job_conversation'],
      'employer.conversation_update': ['api/employer-conversations-update.ts', 'conversations', 'job_conversation'],
      'worker.application_defaults': ['api/worker-application-defaults-get.ts', 'saved_application_details', null],
      'worker.vault': ['api/worker-documents-list.ts', 'documents', 'worker_document'],
      'worker.application_details': ['api/worker-application-details.ts', 'application_answers,saved_application_details', 'job_application'],
    });
  });

  it('names existing handler modules, each under one surface', () => {
    const seen = new Set<string>();
    for (const entry of Object.values(ACCESS_SURFACES)) {
      for (const handler of entry.handlers) {
        expect(fs.existsSync(path.join(INFRA, 'lambda', handler))).toBe(true);
        expect(seen.has(handler)).toBe(false);
        seen.add(handler);
      }
    }
  });

  it('uses only surface codes the records accept, with no duplicates', () => {
    const all = [...Object.keys(ACCESS_SURFACES), ...CHANGE_SURFACES];
    for (const surface of all) {
      expect(surface).toMatch(SURFACE_PATTERN);
      expect(surface.length).toBeLessThanOrEqual(100);
    }
    expect(new Set(CHANGE_SURFACES).size).toBe(CHANGE_SURFACES.length);
  });
});
