// Backend API client for the Expo app.
//
// Mirrors the surface area of `apps/web/src/lib/patternsApi.ts` but
// targets the React Native fetch (no DOM types, no `import.meta.env`).
// The base URL is read from Expo's app.json `extra` so different
// environments (dev / prod) can ship in the same binary.

import Constants from 'expo-constants';
import type {
  JobParamsInput,
  JobStatus,
  JobStatusResponse,
  NewPattern,
  PatternResponse,
  PipelineOutput,
} from '@habaneta/api-types';

// Re-exported for the screens that import these from here. The definitions
// live in @habaneta/api-types, generated from the backend's OpenAPI document —
// never re-declare a wire shape in an app.
export type { NewPattern, PatternResponse };

const BASE_URL: string =
  (Constants.expoConfig?.extra as { habanetaApi?: string } | undefined)
    ?.habanetaApi ?? 'http://localhost:8080';

export class HabanetaApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HabanetaApiError';
    this.status = status;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new HabanetaApiError(
      `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Pipeline jobs ----------

export async function submitJob(
  fileUri: string,
  contentType: string,
  params?: JobParamsInput
): Promise<string> {
  // RN's fetch supports FormData with `{ uri, name, type }` shaped
  // file references — the runtime streams from disk without copying
  // bytes into JS memory.
  const form = new FormData();
  form.append('image', {
    // RN-specific shape; TypeScript needs a cast because the DOM lib
    // expects File | Blob.
    uri: fileUri,
    name: 'photo',
    type: contentType,
  } as unknown as Blob);
  if (params && Object.keys(params).length > 0) {
    form.append('params', JSON.stringify(params));
  }
  const res = await fetch(`${BASE_URL}/v1/jobs`, {
    method: 'POST',
    body: form,
  });
  const body = await jsonOrThrow<{ job_id: string }>(res);
  return body.job_id;
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}`);
  return jsonOrThrow<JobStatusResponse>(res);
}

export async function getJobResult(jobId: string): Promise<PipelineOutput> {
  const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}/result`);
  return jsonOrThrow<PipelineOutput>(res);
}

/**
 * Submit + poll until done. 60s ceiling, exp backoff. Throws on
 * timeout / abort / job failure. Caller can pipe `onStatus` to drive
 * a "queued / running / done" UI.
 */
/** A finished import: the output plus the job that produced it. */
export interface ImportResult {
  jobId: string;
  output: PipelineOutput;
}

export async function runImageImport(
  fileUri: string,
  opts: {
    contentType?: string;
    params?: JobParamsInput;
    onStatus?: (s: JobStatus) => void;
  } = {}
): Promise<ImportResult> {
  const jobId = await submitJob(
    fileUri,
    opts.contentType ?? 'image/jpeg',
    opts.params
  );
  const deadline = Date.now() + 60_000;
  let interval = 250;
  let last: JobStatus | null = null;
  while (true) {
    if (Date.now() > deadline) {
      throw new HabanetaApiError('image import timed out');
    }
    const { status, error } = await getJobStatus(jobId);
    if (status !== last) {
      last = status;
      opts.onStatus?.(status);
    }
    if (status === 'done') return { jobId, output: await getJobResult(jobId) };
    if (status === 'failed') {
      throw new HabanetaApiError(error ?? 'image import failed');
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 2000);
  }
}

// ---------- Patterns ----------

// ---------- Patterns ----------

export async function listPatterns(): Promise<PatternResponse[]> {
  const res = await fetch(`${BASE_URL}/v1/patterns`);
  return jsonOrThrow<PatternResponse[]>(res);
}

export async function getPattern(id: string): Promise<PatternResponse> {
  const res = await fetch(`${BASE_URL}/v1/patterns/${id}`);
  return jsonOrThrow<PatternResponse>(res);
}

async function requestUploadUrl(contentType: string): Promise<{
  photo_key: string;
  presigned_put_url: string;
}> {
  const res = await fetch(`${BASE_URL}/v1/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType }),
  });
  return jsonOrThrow(res);
}

async function uploadPhotoFromUri(
  presignedUrl: string,
  fileUri: string,
  contentType: string
): Promise<void> {
  // RN streams from disk via the URI; no need to read the bytes into JS.
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    // FormData isn't appropriate here — R2 expects a raw PUT body.
    body: {
      uri: fileUri,
      name: 'photo',
      type: contentType,
    } as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new HabanetaApiError(
      `R2 upload failed: HTTP ${res.status}`,
      res.status
    );
  }
}

export async function uploadAndSavePattern(
  fileUri: string,
  contentType: string,
  body: Omit<NewPattern, 'photo_key'>
): Promise<PatternResponse> {
  const upload = await requestUploadUrl(contentType);
  await uploadPhotoFromUri(upload.presigned_put_url, fileUri, contentType);
  const res = await fetch(`${BASE_URL}/v1/patterns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, photo_key: upload.photo_key }),
  });
  return jsonOrThrow<PatternResponse>(res);
}
