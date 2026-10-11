/**
 * audit-coverage.test.ts -- every API handler that reads personal data
 * records who read it.
 *
 * An API handler whose reachable SQL selects from a personal-data table,
 * directly or inside a database function it calls, is either registered under
 * a surface in lambda/lib/audit/registry.ts, where it must actually call
 * recordAccess with that surface and recordAttempt, or it is on the exclusion
 * list below with its reason. A new handler that reads personal data and is in
 * neither fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACCESS_SURFACES } from '../../../lambda/lib/audit/registry';
import {
  LAMBDA_ROOT,
  apiHandlerModules,
  lambdaModules,
  personalDataReads,
  personalDataReadsOf,
  personalDataReadsThroughFunctions,
} from './audit-source-scan';

/** API handlers that read personal data and record nothing, with the reason. */
const COVERAGE_EXCLUSIONS: Readonly<Record<string, string>> = {
  // Workers and employers reading their own data, outside the covered set:
  // these reads are not recorded.
  'api/worker-profile.ts': 'The worker reads their own profile; outside the covered set.',
  'api/worker-profile-update.ts': 'The worker edits their own profile and gets it back; the change log records the edit.',
  'api/worker-applications-list.ts': 'The worker lists their own applications; outside the covered set.',
  'api/worker-jobs-detail.ts': 'The worker reads a job and their own application to it; outside the covered set.',
  'api/worker-jobs-list.ts': 'The job board reads the worker\'s own profile to rank jobs and returns jobs, not the profile.',
  'api/worker-jobs-apply.ts': 'The worker applies; the copy of their own vault documents is a write the change log records.',
  'api/worker-doc-confirm-auth.ts': 'The worker confirms their own upload; a write the change log records.',
  'whatsapp/web/worker-onboarding.ts': 'The worker\'s own onboarding run; outside the covered set.',
  'api/employer-profile.ts': 'The employer reads and edits their own profile; outside the covered set.',
  'billing/checkout.ts': 'The employer\'s own billing details, sent to the payment provider; outside the covered set.',
  // The read stays inside a database function that returns only codes, flags
  // and ids, so nothing personal reaches the handler or its caller.
  'api/employer-application-status-update.ts': 'The stage notice reads the worker\'s number inside jale_cap.employer_stage_recipient and the thread inside jale_cap.employer_claim_worker_intent; both return only ids, codes and flags, so nothing personal is returned to the caller.',
  'api/worker-doc-confirm.ts': 'The link holder confirms an upload; the document read stays inside jale_cap.upload_token_confirm, which returns only an outcome code and the document id, so nothing personal is returned to the caller.',
  'auth/worker-web-signup.ts': 'Web sign-up; the contact lookup stays inside public.reconcile_worker_signup, which returns only the user id, so nothing personal is returned to the caller.',
  'whatsapp/status-callback.ts': 'The delivery status callback; the message lookup stays inside jale_twilio_callback.record_twilio_delivery_status, which returns only two flags and a source code, so nothing personal is returned to the caller.',
};

const registered = new Map<string, string>();
for (const [surface, entry] of Object.entries(ACCESS_SURFACES)) {
  for (const handler of entry.handlers) registered.set(handler, surface);
}

describe('the personal-data read classifier', () => {
  it('finds reads of the personal-data tables and columns', () => {
    expect(personalDataReads('SELECT wd.id FROM worker_documents wd')).toEqual(['worker_documents']);
    expect(personalDataReads('SELECT 1 FROM jobs j JOIN public.worker_profiles wp ON true')).toEqual(['worker_profiles']);
    expect(personalDataReads('SELECT ja.application_answers FROM job_applications ja')).toEqual(['job_applications.application_answers']);
    expect(personalDataReads('SELECT u.phone FROM job_applications ja JOIN users u ON u.id = ja.worker_id'))
      .toEqual(['users contact columns']);
    expect(personalDataReads('SELECT status FROM worker_trust_extractions')).toEqual(['worker_trust_extractions']);
  });

  it('leaves out what is not a read of personal data', () => {
    expect(personalDataReads('SELECT id FROM users WHERE cognito_sub = $1')).toEqual([]);
    expect(personalDataReads('SELECT status FROM job_applications WHERE id = $1')).toEqual([]);
    expect(personalDataReads('DELETE FROM worker_documents WHERE id = $1')).toEqual([]);
    expect(personalDataReads('UPDATE job_applications SET application_answers = $1')).toEqual([]);
  });

  it('finds a read made only inside a database function the SQL calls, by its latest definition', () => {
    const sql = 'SELECT outcome, document_id FROM jale_cap.upload_token_confirm($1, $2)';
    expect(personalDataReads(sql)).toEqual([]);
    expect(personalDataReadsThroughFunctions(sql)).toEqual(['worker_documents (inside jale_cap.upload_token_confirm)']);
  });

  it('finds nothing through a function whose body reads no personal data', () => {
    expect(personalDataReadsThroughFunctions('SELECT outcome FROM jale_cap.upload_token_submit($1)')).toEqual([]);
    expect(personalDataReadsThroughFunctions('SELECT count(*) FROM jobs')).toEqual([]);
  });
});

describe('access record coverage', () => {
  const handlers = apiHandlerModules();
  const reading = new Map(handlers
    .map((handler) => [handler.file, personalDataReadsOf(handler)] as const)
    .filter(([, reads]) => reads.length > 0));

  it('enumerates the API handlers', () => {
    expect(handlers.length).toBeGreaterThan(55);
    expect(reading.has('api/employer-worker-profile.ts')).toBe(true);
  });

  it('every API handler that reads personal data is registered or excluded', () => {
    const unclassified = [...reading.keys()]
      .filter((file) => !registered.has(file) && !(file in COVERAGE_EXCLUSIONS))
      .map((file) => `${file} -> ${reading.get(file)!.join('; ')}`);
    expect(unclassified).toEqual([]);
  });

  it('every registered handler records access with its surface, and records attempts', () => {
    const missing: string[] = [];
    for (const [file, surface] of registered) {
      const module = lambdaModules().get(file);
      if (!module) {
        missing.push(`${file}: not found`);
        continue;
      }
      if (!module.calls.has('recordAccess')) missing.push(`${file}: no recordAccess call`);
      if (!module.calls.has('recordAttempt')) missing.push(`${file}: no recordAttempt call`);
      if (!module.literals.includes(surface)) missing.push(`${file}: never names ${surface}`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps the exclusion list exact: real handlers that read personal data, each with a reason', () => {
    const stale: string[] = [];
    for (const [file, reason] of Object.entries(COVERAGE_EXCLUSIONS)) {
      if (!fs.existsSync(path.join(LAMBDA_ROOT, file))) stale.push(`${file}: no such module`);
      else if (!reading.has(file)) stale.push(`${file}: reads no personal data`);
      if (registered.has(file)) stale.push(`${file}: also registered`);
      if (reason.trim().length < 10) stale.push(`${file}: no reason`);
    }
    expect(stale).toEqual([]);
  });
});
