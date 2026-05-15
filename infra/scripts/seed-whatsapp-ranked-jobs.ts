/**
 * Seed a fake employer plus active jobs derived from a selected worker profile.
 *
 * Usage:
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   WORKER_PHONE=9152272188 npx ts-node scripts/seed-whatsapp-ranked-jobs.ts
 *
 * Optional:
 *   WORKER_ID=<users.id>
 *   SEED_JOB_CANDIDATES=true
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const EMPLOYER_SUB = 'seed-employer-profile-match';
const EMPLOYER_EMAIL = 'jobs+profile-match@jale.test';
const EMPLOYER_NAME = 'Jale Profile Match Fixtures';

interface WorkerProfileSeed {
  worker_id: string;
  label: string;
  profile_profession: string;
  profile_location: string;
  profile_availability: string;
}

interface SeedJob {
  key: string;
  title: string;
  location: string;
  pay: string;
  job_type: string;
  description: string;
  score: number;
  rank: number;
  fit: string;
}

function normalizePhone(value: string | undefined): string {
  if (!value?.trim()) {
    return '';
  }
  const clean = value.trim().replace(/^whatsapp:/, '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{8,15}$/.test(clean)) {
    throw new Error('WORKER_PHONE must contain 8-15 digits, for example 9152272188 or +19152272188.');
  }
  if (clean.startsWith('+')) {
    return clean;
  }
  if (clean.length === 10) {
    return `+1${clean}`;
  }
  return `+${clean}`;
}

function phoneVariants(phone: string): string[] {
  if (!phone) {
    return [];
  }
  const bare = phone.replace(/^\+/, '');
  const local = bare.startsWith('1') && bare.length === 11 ? bare.slice(1) : bare;
  return Array.from(new Set([phone, bare, local, `whatsapp:${phone}`]));
}

function display(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function availabilityToJobType(value: string): string {
  if (value === 'part_time') {
    return 'part-time';
  }
  if (value === 'weekends') {
    return 'contract';
  }
  return 'full-time';
}

function buildJobs(profile: WorkerProfileSeed): SeedJob[] {
  const profession = profile.profile_profession;
  const professionTitle = display(profession);
  const location = profile.profile_location;
  return [
    {
      key: 'profile-primary',
      title: `${professionTitle} Profile Match Crew`,
      location,
      pay: '$30-$38/hr',
      job_type: availabilityToJobType(profile.profile_availability),
      description: `Profile Match role for current worker profile. Work centers on ${profession} tasks, field tools, safety, cleanup, and steady production near ${location}.`,
      score: 95,
      rank: 10,
      fit: 'current profile profession and location',
    },
    {
      key: 'profile-experienced',
      title: `Experienced ${professionTitle} - Same Area`,
      location,
      pay: '$28-$35/hr',
      job_type: 'contract',
      description: `Second profile-derived match for ${profession}. The description repeats the current profile profession so the independent matcher can score it without seeded candidate rows.`,
      score: 88,
      rank: 20,
      fit: 'current profile profession repeated in title and description',
    },
    {
      key: 'profile-helper',
      title: `${professionTitle} Helper - Local Project`,
      location,
      pay: '$24-$30/hr',
      job_type: 'full-time',
      description: `Local helper opening supporting ${profession} crews with materials, measurements, tools, site prep, and punch-list work.`,
      score: 76,
      rank: 30,
      fit: 'current profile profession with helper seniority',
    },
    {
      key: 'profile-control',
      title: 'Warehouse General Labor Support',
      location,
      pay: '$20-$24/hr',
      job_type: 'part-time',
      description: 'Control posting for staging materials, sweeping, loading, and general site cleanup. It should not outrank jobs that mention the worker profile profession.',
      score: 30,
      rank: 90,
      fit: 'location-only control job',
    },
  ];
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return r.rows[0]?.exists === true;
}

async function findWorkerProfile(client: Client): Promise<WorkerProfileSeed> {
  const workerId = process.env.WORKER_ID?.trim();
  const phone = normalizePhone(process.env.WORKER_PHONE);
  const variants = phoneVariants(phone);

  const params: unknown[] = [];
  const filters: string[] = [`u.user_type = 'worker'`];

  if (workerId) {
    params.push(workerId);
    filters.push(`u.id = $${params.length}::uuid`);
  } else if (variants.length > 0) {
    params.push(variants);
    filters.push(`(
      regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = ANY($${params.length})
      OR regexp_replace(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g') = ANY($${params.length})
      OR u.phone = ANY($${params.length})
      OR u.whatsapp_number = ANY($${params.length})
    )`);
  } else {
    filters.push(`(
      NULLIF(u.main_trade_other, '') IS NOT NULL
      OR NULLIF(u.main_trade, '') IS NOT NULL
    )`);
  }

  const result = await client.query<WorkerProfileSeed>(
    `SELECT
        u.id AS worker_id,
        COALESCE(u.full_name, u.phone, u.whatsapp_number, u.cognito_sub) AS label,
        COALESCE(
          NULLIF(u.main_trade_other, ''),
          NULLIF(CASE WHEN u.main_trade IS NOT NULL AND u.main_trade <> 'other' THEN u.main_trade ELSE NULL END, ''),
          NULLIF((SELECT string_agg(ws.skill, ' ' ORDER BY ws.skill) FROM worker_skills ws WHERE ws.worker_id = u.id), ''),
          'general labor'
        ) AS profile_profession,
        COALESCE(NULLIF(wp.location, ''), NULLIF(u.city, ''), 'El Paso, TX') AS profile_location,
        COALESCE(NULLIF(wp.availability, ''), NULLIF(u.availability, ''), 'full_time') AS profile_availability
       FROM users u
       LEFT JOIN worker_profiles wp ON wp.user_id = u.id
      WHERE ${filters.join(' AND ')}
      ORDER BY u.updated_at DESC NULLS LAST
      LIMIT 1`,
    params,
  );

  if (!result.rows[0]) {
    throw new Error('No worker found for the supplied phone or worker id.');
  }
  return result.rows[0];
}

async function upsertEmployer(client: Client): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users
       (cognito_sub, user_type, email, full_name, tos_version, tos_accepted_at, privacy_version, privacy_accepted_at)
     VALUES
       ($1, 'employer', $2, $3, '1.0', now(), '1.0', now())
     ON CONFLICT (cognito_sub) DO UPDATE
       SET email = EXCLUDED.email,
           full_name = EXCLUDED.full_name
     RETURNING id`,
    [EMPLOYER_SUB, EMPLOYER_EMAIL, EMPLOYER_NAME],
  );
  return r.rows[0].id;
}

async function upsertJob(client: Client, employerId: string, job: SeedJob): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM jobs
      WHERE employer_id = $1
        AND title = $2
        AND location = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [employerId, job.title, job.location],
  );

  if (existing.rows[0]) {
    await client.query(
      `UPDATE jobs
          SET company = $2,
              pay = $3,
              job_type = $4,
              description = $5,
              status = 'active',
              required_docs = '{}'
        WHERE id = $1`,
      [existing.rows[0].id, EMPLOYER_NAME, job.pay, job.job_type, job.description],
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO jobs
       (employer_id, title, company, location, pay, job_type, description, status, required_docs)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, 'active', '{}')
     RETURNING id`,
    [employerId, job.title, EMPLOYER_NAME, job.location, job.pay, job.job_type, job.description],
  );
  return inserted.rows[0].id;
}

async function rankWorkerForJob(
  client: Client,
  workerId: string,
  jobId: string,
  job: SeedJob,
): Promise<number> {
  await client.query(
    `DELETE FROM job_candidates WHERE job_id = $1 AND worker_id = $2`,
    [jobId, workerId],
  );

  const used = await client.query<{ candidate_rank: number }>(
    `SELECT candidate_rank FROM job_candidates WHERE job_id = $1`,
    [jobId],
  );
  const usedRanks = new Set(used.rows.map((row) => row.candidate_rank));
  let rank = job.rank;
  while (usedRanks.has(rank)) {
    rank += 1;
  }

  await client.query(
    `INSERT INTO job_candidates
       (job_id, worker_id, score, score_components, candidate_rank)
     VALUES
       ($1, $2, $3, $4::jsonb, $5)`,
    [
      jobId,
      workerId,
      job.score,
      JSON.stringify({ seed: true, fixture: job.key, fit: job.fit }),
      rank,
    ],
  );
  return rank;
}

async function main(): Promise<void> {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true'
      ? {
          rejectUnauthorized: true,
          ca: fs.readFileSync(
            path.join(__dirname, '../lambda/lib/rds-ca-bundle.pem'),
            'utf-8',
          ),
        }
      : false,
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    const worker = await findWorkerProfile(client);
    const employerId = await upsertEmployer(client);
    const jobs = buildJobs(worker);
    const seedCandidates = process.env.SEED_JOB_CANDIDATES === 'true';

    if (seedCandidates && !await tableExists(client, 'job_candidates')) {
      throw new Error('job_candidates table does not exist. Unset SEED_JOB_CANDIDATES or apply matching migrations first.');
    }

    console.log(`Using worker: ${worker.label} (${worker.worker_id})`);
    console.log(`Profile profession: ${worker.profile_profession}`);
    console.log(`Profile location: ${worker.profile_location}`);
    console.log(`Using employer: ${EMPLOYER_NAME} (${employerId})`);

    for (const job of jobs) {
      const jobId = await upsertJob(client, employerId, job);
      if (seedCandidates) {
        const rank = await rankWorkerForJob(client, worker.worker_id, jobId, job);
        console.log(`Rank ${rank}: ${job.title} (${job.score}) -> ${jobId}`);
      } else {
        console.log(`Seeded profile-derived job: ${job.title} -> ${jobId}`);
      }
    }

    await client.query('COMMIT');
    console.log('\nSeed complete. Send "Jobs" in WhatsApp; matching should score these jobs from profile text.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
