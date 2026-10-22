/**
 * r-paths-world.ts -- fixtures for the r-paths-*.integration.test.ts suites.
 *
 * Every fixture row is written through the SUPERUSER url the test bed
 * exports (JALE_TEST_DATABASE_URL), never through the login under test, and
 * every id it creates is tracked so `cleanup()` removes exactly those rows.
 * Values are obviously fake: phones are in the 555-01xx fiction range, names
 * say "Fixture", subs and codes are random.
 *
 * Not a test file (no .test.ts suffix), so jest never runs it on its own.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

let phoneSeq = Math.floor(Math.random() * 9000);
/** A fictional +1 555 010 xxxx number, unique per call within a run. */
export function fakePhone(): string {
  phoneSeq = (phoneSeq + 1) % 10000;
  return `+1555010${String(phoneSeq).padStart(4, '0')}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A random, valid-shaped 8-character share code (Crockford base32). */
export function fakeShareCode(): string {
  return Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join('');
}

/** The ToS version every fixture user has accepted; handlers read REQUIRED_TOS_VERSION. */
export const FIXTURE_TOS_VERSION = 'fixture-tos-1';

export interface UserFixture {
  id: string;
  sub: string;
}

export interface WorkerOptions {
  phone?: string | null;
  whatsappNumber?: string | null;
  fullName?: string;
  /** Inserts worker_onboarding_state with this lifecycle. */
  lifecycle?: 'onboarding' | 'ready' | 'suspended';
  /** Inserts a worker_workflow_runs row with this preferred_language. */
  workflowLanguage?: 'en' | 'es';
  /** Inserts a whatsapp_conversations row with this language. */
  whatsappLanguage?: 'en' | 'es';
  city?: string;
}

export interface JobOptions {
  title?: string;
  status?: 'active' | 'paused' | 'filled' | 'closed';
  publicListing?: boolean;
  latitude?: number;
  longitude?: number;
  optionalDocs?: string[];
  requiredDocs?: string[];
  numberOfWorkersNeeded?: number;
  cityKey?: string;
}

export class World {
  readonly su: Client;
  private readonly userIds: string[] = [];
  private readonly jobIds: string[] = [];
  private readonly extraCleanup: Array<() => Promise<unknown>> = [];

  constructor(databaseUrl: string) {
    this.su = new Client({ connectionString: databaseUrl });
  }

  async connect(): Promise<void> {
    await this.su.connect();
  }

  /** Registers an extra cleanup statement, run first (latest first). */
  onCleanup(fn: () => Promise<unknown>): void {
    this.extraCleanup.push(fn);
  }

  get users(): readonly string[] {
    return this.userIds;
  }

  async employer(opts: { companyName?: string; fullName?: string } = {}): Promise<UserFixture> {
    const id = randomUUID();
    const sub = `fixture-employer-${randomUUID()}`;
    await this.su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name, email, tos_version)
       VALUES ($1, $2, 'employer', $3, $4, $5)`,
      [id, sub, opts.fullName ?? 'Fixture Employer', `${id}@fixture.invalid`, FIXTURE_TOS_VERSION],
    );
    this.userIds.push(id);
    if (opts.companyName !== undefined) {
      await this.su.query(
        `INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, $2)`,
        [id, opts.companyName],
      );
    }
    // Like a real sign-up (post-confirmation -> employer_ensure_organization):
    // every employer is the active owner of a one-person company.
    const org = (await this.su.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      [opts.companyName ?? opts.fullName ?? 'Fixture Employer'],
    )).rows[0].id;
    await this.su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [id, org],
    );
    // Extra cleanups run before the users are deleted, so remove the members first.
    // Billing rows restrict their company (127), so they go before it. Matching the
    // payer as well as the company keeps this working before 127 stamps the column.
    this.onCleanup(async () => {
      await this.su.query(`DELETE FROM subscriptions WHERE user_id = $1 OR organization_id = $2`, [id, org]);
      await this.su.query(`DELETE FROM billing_customers WHERE user_id = $1 OR organization_id = $2`, [id, org]);
      await this.su.query(`DELETE FROM organization_members WHERE organization_id = $1`, [org]);
      await this.su.query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    return { id, sub };
  }

  async worker(opts: WorkerOptions = {}): Promise<UserFixture & { phone: string | null }> {
    const id = randomUUID();
    const sub = `fixture-worker-${randomUUID()}`;
    const phone = opts.phone === undefined ? fakePhone() : opts.phone;
    await this.su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name, phone, whatsapp_number, city, tos_version)
       VALUES ($1, $2, 'worker', $3, $4, $5, $6, $7)`,
      [id, sub, opts.fullName ?? 'Fixture Worker', phone, opts.whatsappNumber ?? null, opts.city ?? null, FIXTURE_TOS_VERSION],
    );
    this.userIds.push(id);
    if (opts.lifecycle) {
      await this.su.query(
        `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, $2)`,
        [id, opts.lifecycle],
      );
    }
    if (opts.workflowLanguage) {
      await this.su.query(
        `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status, preferred_language)
         VALUES ($1, 1, 'start.choose_language', 'completed', $2)`,
        [id, opts.workflowLanguage],
      );
    }
    if (opts.whatsappLanguage) {
      await this.su.query(
        `INSERT INTO whatsapp_conversations (whatsapp_number, user_id, language)
         VALUES ($1, $2, $3)`,
        [phone ?? fakePhone(), id, opts.whatsappLanguage],
      );
    }
    return { id, sub, phone };
  }

  async job(employerId: string, opts: JobOptions = {}): Promise<{ id: string; publicCode: string }> {
    const id = randomUUID();
    const publicCode = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    const located = opts.latitude !== undefined && opts.longitude !== undefined;
    await this.su.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status, public_listing_enabled,
                         public_code, latitude, longitude, location_source, location_updated_at,
                         optional_docs, required_docs, number_of_workers_needed, city_key)
       VALUES ($1, $2, $3, 'Fixture City', 'full-time', $4, $5, $6, $7, $8,
               CASE WHEN $9::boolean THEN 'manual' END, CASE WHEN $9::boolean THEN now() END,
               $10, $11, $12, $13)`,
      [
        id, employerId, opts.title ?? 'Fixture Job', opts.status ?? 'active', opts.publicListing ?? false,
        publicCode, located ? opts.latitude : null, located ? opts.longitude : null, located,
        opts.optionalDocs ?? [], opts.requiredDocs ?? [], opts.numberOfWorkersNeeded ?? 1, opts.cityKey ?? null,
      ],
    );
    this.jobIds.push(id);
    return { id, publicCode };
  }

  /** A worker_profiles row; with coordinates it is a complete map-pin location. */
  async workerProfile(userId: string, opts: { latitude?: number; longitude?: number; location?: string } = {}): Promise<void> {
    const located = opts.latitude !== undefined && opts.longitude !== undefined;
    await this.su.query(
      `INSERT INTO worker_profiles (user_id, location, latitude, longitude, location_source,
                                    location_confidence, location_updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN 'map_pin' END,
               CASE WHEN $5::boolean THEN 100 END, CASE WHEN $5::boolean THEN now() END)`,
      [userId, opts.location ?? null, located ? opts.latitude : null, located ? opts.longitude : null, located],
    );
  }

  /** A worker_preferred_cities row (cascades away with the user). */
  async preferredCity(userId: string, opts: {
    cityKey: string; city: string; state: string; latitude?: number; longitude?: number;
  }): Promise<void> {
    await this.su.query(
      `INSERT INTO worker_preferred_cities (user_id, city_key, city, state, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, opts.cityKey, opts.city, opts.state, opts.latitude ?? null, opts.longitude ?? null],
    );
  }

  async application(jobId: string, workerId: string, status = 'pending'): Promise<string> {
    const { rows } = await this.su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, $3) RETURNING id`,
      [jobId, workerId, status],
    );
    return rows[0].id;
  }

  async conversation(input: {
    jobId: string; employerId: string; workerId: string; applicationId: string;
    lastWorkerMessageAt?: Date | null;
  }): Promise<string> {
    const { rows } = await this.su.query<{ id: string }>(
      `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, last_worker_message_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.jobId, input.employerId, input.workerId, input.applicationId, input.lastWorkerMessageAt ?? null],
    );
    return rows[0].id;
  }

  async message(conversationId: string, body: string, status = 'queued'): Promise<string> {
    const { rows } = await this.su.query<{ id: string }>(
      `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
       VALUES ($1, 'employer', 'outbound', $2, $3) RETURNING id`,
      [conversationId, body, status],
    );
    return rows[0].id;
  }

  async outbox(conversationId: string, messageId: string, whatsappNumber: string, body: string): Promise<string> {
    const { rows } = await this.su.query<{ id: string }>(
      `INSERT INTO job_message_outbox (conversation_id, message_id, whatsapp_number, send_kind, body)
       VALUES ($1, $2, $3, 'freeform', $4) RETURNING id`,
      [conversationId, messageId, whatsappNumber, body],
    );
    return rows[0].id;
  }

  async document(input: {
    workerId: string; jobId: string | null; docType: string; certName?: string | null;
  }): Promise<string> {
    const { rows } = await this.su.query<{ id: string }>(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       VALUES ($1, $2, $3, $4, $5, 1024, 'application/pdf', $6) RETURNING id`,
      [
        input.workerId, input.jobId, input.docType,
        `documents/fixture/${randomUUID()}.pdf`, `${input.docType}.pdf`, input.certName ?? null,
      ],
    );
    return rows[0].id;
  }

  /**
   * A document_upload_tokens row, as employer-upload-token issues it: the
   * database keeps only the lower-case hex SHA-256 of the raw token.
   */
  async uploadToken(input: {
    jobId: string; workerId: string; expiresAt?: Date; used?: boolean;
  }): Promise<{ raw: string; hash: string }> {
    const raw = `fixture-${randomBytes(16).toString('hex')}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    await this.su.query(
      `INSERT INTO document_upload_tokens (token_hash, worker_id, job_id, expires_at, used, used_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() END)`,
      [hash, input.workerId, input.jobId, input.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000), input.used ?? false],
    );
    return { raw, hash };
  }

  /** A document_upload_token_slots row under a token. */
  async uploadSlot(tokenHash: string, input: {
    docType: string; s3Key?: string; mimeType?: string; maxFileSize?: number; confirmed?: boolean;
  }): Promise<string> {
    const s3Key = input.s3Key ?? `documents/fixture/${randomUUID()}.pdf`;
    await this.su.query(
      `INSERT INTO document_upload_token_slots (token_hash, doc_type, issued_s3_key, expected_mime_type, max_file_size, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END)`,
      [tokenHash, input.docType, s3Key, input.mimeType ?? 'application/pdf', input.maxFileSize ?? 10 * 1024 * 1024, input.confirmed ?? false],
    );
    return s3Key;
  }

  /** A job_share_links row (cascades away with its job). */
  async shareLink(input: {
    jobId: string; referrerWorkerId?: string; referrerEmployerId?: string; channel?: string; revoked?: boolean;
  }): Promise<string> {
    const code = fakeShareCode();
    await this.su.query(
      `INSERT INTO job_share_links (code, job_id, referrer_worker_id, referrer_employer_id, channel, revoked_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END)`,
      [code, input.jobId, input.referrerWorkerId ?? null, input.referrerEmployerId ?? null,
        input.channel ?? 'whatsapp', input.revoked ?? false],
    );
    return code;
  }

  /** Removes every row this world created, children first. */
  async cleanup(): Promise<void> {
    for (const fn of [...this.extraCleanup].reverse()) {
      await fn();
    }
    const users = this.userIds;
    const jobs = this.jobIds;
    if (jobs.length || users.length) {
      await this.su.query(
        `DELETE FROM job_conversations WHERE job_id = ANY($1::uuid[]) OR employer_id = ANY($2::uuid[]) OR worker_id = ANY($2::uuid[])`,
        [jobs, users],
      );
      await this.su.query(
        `DELETE FROM whatsapp_outbox WHERE source_type = 'worker_intent'
            AND source_id IN (SELECT id FROM worker_message_intents WHERE user_id = ANY($1::uuid[]))`,
        [users],
      );
      await this.su.query(`DELETE FROM worker_message_intents WHERE user_id = ANY($1::uuid[])`, [users]);
      // Before the jobs: a first-touch row must not see its job set to NULL.
      await this.su.query(`DELETE FROM worker_attribution WHERE worker_id = ANY($1::uuid[])`, [users]);
      await this.su.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[]) OR job_id = ANY($2::uuid[])`, [users, jobs]);
      await this.su.query(`DELETE FROM document_upload_tokens WHERE worker_id = ANY($1::uuid[]) OR job_id = ANY($2::uuid[])`, [users, jobs]);
      await this.su.query(`DELETE FROM job_visibility_events WHERE job_id = ANY($1::uuid[])`, [jobs]);
      await this.su.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobs]);
      await this.su.query(`DELETE FROM whatsapp_conversations WHERE user_id = ANY($1::uuid[])`, [users]);
      await this.su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    }
  }

  async end(): Promise<void> {
    await this.su.end();
  }
}

// ── Driving handlers ─────────────────────────────────────────────────

export interface ApiEventInput {
  sub?: string;
  claims?: Record<string, string>;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: unknown;
  httpMethod?: string;
  resource?: string;
  path?: string;
}

/** The shape API Gateway's Cognito authorizer hands a Lambda proxy handler. */
export function apiEvent(input: ApiEventInput = {}): any {
  const claims = input.claims ?? (input.sub ? { sub: input.sub } : undefined);
  return {
    resource: input.resource ?? '/',
    path: input.path ?? input.resource ?? '/',
    httpMethod: input.httpMethod ?? 'GET',
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    queryStringParameters: input.queryStringParameters ?? null,
    multiValueQueryStringParameters: null,
    pathParameters: input.pathParameters ?? null,
    stageVariables: null,
    body: input.body === undefined ? null : typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
    isBase64Encoded: false,
    requestContext: {
      authorizer: claims ? { claims } : undefined,
      httpMethod: input.httpMethod ?? 'GET',
      resourcePath: input.resource ?? '/',
      requestId: `fixture-request-${randomUUID()}`,
    },
  };
}

export interface ParsedResponse {
  statusCode: number;
  body: any;
}

export function parseResponse(result: { statusCode: number; body?: string }): ParsedResponse {
  let body: any = result.body;
  try {
    body = result.body ? JSON.parse(result.body) : null;
  } catch {
    // leave non-JSON bodies as text
  }
  return { statusCode: result.statusCode, body };
}
