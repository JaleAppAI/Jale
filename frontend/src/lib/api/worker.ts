export interface UploadUrlResponse {
  url: string;
  s3_key: string;
}

export type DocType = 'resume' | 'driver_license' | 'ssn';

export async function getUploadUrl(
  token: string,
  doc_type: DocType,
  mime_type: string,
): Promise<UploadUrlResponse> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/upload-url`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, doc_type, mime_type }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'upload_url_failed');
  return res.json();
}

export async function uploadFileToS3(presignedUrl: string, file: File): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!res.ok) throw new Error('s3_upload_failed');
}

export async function confirmUpload(
  token: string,
  s3_key: string,
  doc_type: DocType,
  file: File,
): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        s3_key,
        doc_type,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
      }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'confirm_failed');
}

export async function submitUpload(token: string): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/submit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'submit_failed');
}
