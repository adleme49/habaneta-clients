// Client for the habaneta-backend `/v1/patterns` and `/v1/upload-url`
// endpoints. Cloud-platform v1 — replaces the IndexedDB-backed user
// tile store with backend-persisted patterns + R2 photo storage.
//
// Mirrors `habanetaBackend.ts`'s shape (typed fetches, AbortController,
// tiny error class) so the two API surfaces feel consistent.

import type { Dict } from '../context/interfaces';
import type { Pattern, PipelineOutput } from '@habaneta/api-types';
import { HabanetaBackendError } from './habanetaBackend';

const BASE_URL =
  (import.meta.env.VITE_HABANETA_API as string | undefined) ??
  'http://localhost:8080';

/** A pattern with a freshly-signed photo URL. */
export interface PatternResponse extends Pattern {
  /** Time-limited URL (1h) that resolves to the original photo bytes. */
  photo_url?: string | null;
}

export interface UploadUrlResponse {
  photo_key: string;
  presigned_put_url: string;
  expires_in_seconds: number;
}

export interface NewPattern {
  name: string;
  family?: string;
  kind?: 'floor' | 'border';
  photo_key: string;
  captured_at: string; // ISO timestamp
  geo_lat?: number | null;
  geo_lng?: number | null;
  place_name?: string | null;
  pipeline: PipelineOutput;
  layers: Dict<string>;
  /**
   * The job that produced `pipeline`. Additive: with it the backend records
   * the settings and pipeline version behind this pattern, so it can be
   * reproduced, re-run and compared. Without it the pattern still saves.
   */
  job_id?: string;
  /** Where the photo came from. Recorded on the capture. */
  source?: 'web' | 'mobile';
}

export interface PatchPattern {
  name?: string;
  family?: string;
  place_name?: string | null;
  layers?: Dict<string>;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new HabanetaBackendError(
      `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      undefined,
      res.status
    );
  }
  return (await res.json()) as T;
}

export async function requestUploadUrl(
  contentType: string,
  signal?: AbortSignal
): Promise<UploadUrlResponse> {
  const res = await fetch(`${BASE_URL}/v1/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType }),
    signal,
  });
  return jsonOrThrow<UploadUrlResponse>(res);
}

/**
 * PUT raw photo bytes to a pre-signed R2 URL. Returns nothing on
 * success; throws with a useful detail on failure (R2 returns XML
 * error bodies, so we only surface the status code rather than try
 * to parse them).
 */
export async function uploadPhoto(
  presignedUrl: string,
  file: File,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
    signal,
  });
  if (!res.ok) {
    throw new HabanetaBackendError(
      `R2 upload failed: HTTP ${res.status} ${res.statusText}`,
      undefined,
      res.status
    );
  }
}

export async function listPatterns(
  signal?: AbortSignal
): Promise<PatternResponse[]> {
  const res = await fetch(`${BASE_URL}/v1/patterns`, { signal });
  return jsonOrThrow<PatternResponse[]>(res);
}

export async function getPattern(
  id: string,
  signal?: AbortSignal
): Promise<PatternResponse> {
  const res = await fetch(`${BASE_URL}/v1/patterns/${id}`, { signal });
  return jsonOrThrow<PatternResponse>(res);
}

export async function savePattern(
  body: NewPattern,
  signal?: AbortSignal
): Promise<PatternResponse> {
  const res = await fetch(`${BASE_URL}/v1/patterns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return jsonOrThrow<PatternResponse>(res);
}

export async function updatePattern(
  id: string,
  patch: PatchPattern,
  signal?: AbortSignal
): Promise<PatternResponse> {
  const res = await fetch(`${BASE_URL}/v1/patterns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal,
  });
  return jsonOrThrow<PatternResponse>(res);
}

export async function deletePattern(
  id: string,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/patterns/${id}`, {
    method: 'DELETE',
    signal,
  });
  if (!res.ok) {
    throw new HabanetaBackendError(
      `delete failed: HTTP ${res.status} ${res.statusText}`,
      undefined,
      res.status
    );
  }
}

/**
 * High-level helper: presign + upload + save in one shot. Used by the
 * import dialog on Save. Splitting the steps lets the caller surface
 * granular progress, but for v1 the dialog just shows a single saving
 * state, so the bundled call simplifies the call site.
 */
export async function uploadAndSavePattern(
  file: File,
  body: Omit<NewPattern, 'photo_key'>,
  opts: { signal?: AbortSignal } = {}
): Promise<PatternResponse> {
  const upload = await requestUploadUrl(file.type || 'image/jpeg', opts.signal);
  await uploadPhoto(upload.presigned_put_url, file, opts.signal);
  return savePattern({ ...body, photo_key: upload.photo_key }, opts.signal);
}
