import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';

export type ApplySurface = 'web' | 'whatsapp';

export type ApplyWorkerResult =
  | { status: 'applied'; application: Record<string, unknown> }
  | { status: 'already_applied'; application?: Record<string, unknown> }
  | { status: 'missing_documents'; missing_docs: string[] }
  | { status: 'job_closed' }
  | { status: 'forbidden' };

interface ApplyWorkerToJobInput {
  workerId: string;
  jobId: string;
  surface: ApplySurface;
}

async function copyRequiredDocumentSnapshots(
  client: PoolClient,
  workerId: string,
  jobId: string,
  requiredDocs: string[],
): Promise<void> {
  if (requiredDocs.length === 0) return;

  await client.query(
    `INSERT INTO worker_documents
       (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
     SELECT DISTINCT ON (doc_type)
            worker_id, $1::uuid, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id
       FROM worker_documents
      WHERE worker_id = $2
        AND doc_type = ANY($3::text[])
        AND (job_id IS NULL OR job_id = $1::uuid)
      ORDER BY doc_type, (job_id = $1::uuid) DESC, (job_id IS NULL) DESC, uploaded_at DESC
     ON CONFLICT DO NOTHING`,
    [jobId, workerId, requiredDocs],
  );
}

async function missingRequiredDocuments(
  client: PoolClient,
  workerId: string,
  jobId: string,
  requiredDocs: string[],
): Promise<string[]> {
  if (requiredDocs.length === 0) return [];

  const docsRes = await client.query<{ doc_type: string }>(
    `SELECT DISTINCT doc_type
       FROM worker_documents
      WHERE worker_id = $1
        AND doc_type = ANY($2::text[])
        AND (job_id IS NULL OR job_id = $3::uuid)`,
    [workerId, requiredDocs, jobId],
  );
  const present = new Set(docsRes.rows.map((row) => row.doc_type));
  return requiredDocs.filter((docType) => !present.has(docType));
}

export async function applyWorkerToJob(
  client: PoolClient,
  input: ApplyWorkerToJobInput,
): Promise<ApplyWorkerResult> {
  const { workerId, jobId } = input;
  await setInternalUserRlsContext(client, workerId);

  const jobRes = await client.query<{ id: string; required_docs: string[] | null }>(
    `SELECT id, required_docs FROM jobs WHERE id = $1 AND status = 'active'`,
    [jobId],
  );
  if (jobRes.rows.length === 0) {
    return { status: 'job_closed' };
  }

  const requiredDocs = jobRes.rows[0].required_docs ?? [];
  const missingDocs = await missingRequiredDocuments(client, workerId, jobId, requiredDocs);
  if (missingDocs.length > 0) {
    return { status: 'missing_documents', missing_docs: missingDocs };
  }

  try {
    const insertRes = await client.query(
      `INSERT INTO job_applications (job_id, worker_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (job_id, worker_id) DO NOTHING
       RETURNING id, job_id, status, applied_at`,
      [jobId, workerId],
    );

    if (insertRes.rows.length === 0) {
      await copyRequiredDocumentSnapshots(client, workerId, jobId, requiredDocs);
      const existingRes = await client.query(
        `SELECT id, job_id, status, applied_at
           FROM job_applications
          WHERE job_id = $1 AND worker_id = $2`,
        [jobId, workerId],
      );
      if (existingRes.rows.length > 0) {
        return { status: 'already_applied', application: existingRes.rows[0] };
      }
      return { status: 'forbidden' };
    }

    await copyRequiredDocumentSnapshots(client, workerId, jobId, requiredDocs);
    return { status: 'applied', application: insertRes.rows[0] };
  } catch (err: any) {
    if (err?.code === '42501') {
      return { status: 'forbidden' };
    }
    throw err;
  }
}
