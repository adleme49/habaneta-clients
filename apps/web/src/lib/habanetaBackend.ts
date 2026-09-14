// Client for the habaneta-backend image-processing service.
//
// Wire types live in `@habaneta/api-types` so they're shared with the
// mobile app. This module only owns the runtime client (fetch, polling,
// abort handling, error class).

export type {
  Atom,
  Cell,
  Composition,
  JobParams,
  JobStatus,
  JobStatusResponse,
  Lattice,
  Pattern,
  PipelineOutput,
  Transform,
  Vec2,
} from '@habaneta/api-types';

import type {
  JobParams,
  JobStatus,
  JobStatusResponse,
  PipelineOutput,
} from '@habaneta/api-types';

const BASE_URL =
  (import.meta.env.VITE_HABANETA_API as string | undefined) ??
  'http://localhost:8080';

export class HabanetaBackendError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'HabanetaBackendError';
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
    throw new HabanetaBackendError(
      `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      undefined,
      res.status
    );
  }
  return (await res.json()) as T;
}

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitJob(
  file: File,
  params?: JobParams,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData();
  form.append('image', file);
  if (params && Object.keys(params).length > 0) {
    form.append('params', JSON.stringify(params));
  }
  const res = await fetch(`${BASE_URL}/v1/jobs`, {
    method: 'POST',
    body: form,
    signal,
  });
  const body = await jsonOrThrow<{ job_id: string }>(res);
  return body.job_id;
}

export async function getJobStatus(
  jobId: string,
  signal?: AbortSignal
): Promise<JobStatusResponse> {
  const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, { signal });
  return jsonOrThrow<JobStatusResponse>(res);
}

export async function getJobResult(
  jobId: string,
  signal?: AbortSignal
): Promise<PipelineOutput> {
  const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}/result`, { signal });
  return jsonOrThrow<PipelineOutput>(res);
}

export interface PollOptions {
  /** Initial delay between status polls. Default 250ms. */
  initialIntervalMs?: number;
  /** Max delay between polls (exponential backoff cap). Default 2000ms. */
  maxIntervalMs?: number;
  /** Hard ceiling on total polling time. Default 60s. */
  timeoutMs?: number;
  /** Called on each status change so the UI can show progress. */
  onStatus?: (status: JobStatus) => void;
  /** Per-job extraction parameters; omit any field to use server defaults. */
  params?: JobParams;
  signal?: AbortSignal;
}

/**
 * Submit a file and resolve with the final PipelineOutput. Polls with
 * exponential backoff. Aborts cleanly via `signal` (caller's responsibility
 * to wire a controller — e.g. from a React effect cleanup).
 */
/**
 * A finished import: the pipeline output plus the job that produced it.
 * The job id is what lets `POST /v1/patterns` record the settings and
 * pipeline version behind a saved pattern — without it the backend has no
 * way to know which run the output came from.
 */
export interface ImportResult {
  jobId: string;
  output: PipelineOutput;
}

export async function runImageImport(
  file: File,
  opts: PollOptions = {}
): Promise<ImportResult> {
  const initial = opts.initialIntervalMs ?? 250;
  const max = opts.maxIntervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 60_000;
  const { signal, onStatus, params } = opts;

  const jobId = await submitJob(file, params, signal);
  const deadline = Date.now() + timeout;
  let interval = initial;
  let lastStatus: JobStatus | null = null;

  while (true) {
    if (signal?.aborted) throw new HabanetaBackendError('aborted');
    if (Date.now() > deadline) {
      throw new HabanetaBackendError(`Timed out after ${timeout}ms`);
    }
    const { status, error } = await getJobStatus(jobId, signal);
    if (status !== lastStatus) {
      lastStatus = status;
      onStatus?.(status);
    }
    if (status === 'done') {
      return { jobId, output: await getJobResult(jobId, signal) };
    }
    if (status === 'failed') {
      throw new HabanetaBackendError(error ?? 'Job failed');
    }
    await sleep(interval, signal);
    interval = Math.min(interval * 1.5, max);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HabanetaBackendError('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new HabanetaBackendError('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
