// The habaneta-backend wire contract.
//
// These types are GENERATED from `openapi.json`, which the backend emits from
// its own Rust types. Do not hand-edit them, and do not re-declare a request or
// response shape in an app — that is the duplication this package exists to
// remove. To pull in a backend change:
//
//     pnpm gen:api            # sibling checkout at ../backend
//     pnpm gen:api --staging  # or fetch from the deployed backend
//
// This file is the curated surface: flat, readable aliases over the generated
// `components['schemas']` tree, so consumers write `Pattern` rather than
// `components['schemas']['Pattern']`. Adding an endpoint means adding an alias
// here; the generated file itself is never edited.

import type { components, operations } from './generated';

type Schemas = components['schemas'];

// ---------- Pipeline output ----------

/** Everything the image pipeline extracted from one photo. */
export type PipelineOutput = Schemas['PipelineOutput'];
export type Atom = Schemas['Atom'];
export type Composition = Schemas['Composition'];
export type Lattice = Schemas['Lattice'];
export type Cell = Schemas['Cell'];
export type Transform = Schemas['Transform'];
export type Color = Schemas['Color'];
export type Quality = Schemas['Quality'];

/** Lattice basis vectors, as the contract declares them: exactly two floats. */
export type Vec2 = Lattice['basis_a'];

// ---------- Jobs ----------

/**
 * The settings a run was executed with. Every field is present here because
 * this is the *sanitised* form the server stored — see `JobParamsInput` for
 * what a client sends.
 */
export type JobParams = Schemas['JobParams'];

/**
 * What a client sends to `POST /v1/jobs`. Every knob is optional: send only
 * what the user actually changed so server defaults survive, which is what
 * lets the backend change a default without a client release.
 */
export type JobParamsInput = Partial<
  Omit<JobParams, 'contour'> & { contour: Partial<ContourParams> | null }
>;

export type ContourParams = Schemas['ContourParams'];
export type JobCreated = Schemas['JobCreated'];
export type JobStatusResponse = Schemas['StatusBody'];

/** The four states a run moves through. Enumerated in the contract. */
export type JobStatus = Schemas['JobStatus'];

// ---------- Patterns ----------

/** A saved pattern. `photo_key` and `captured_at` are null when no capture backs it. */
export type Pattern = Schemas['Pattern'];
export type PatternResponse = Schemas['PatternResponse'];
export type NewPattern = Schemas['NewPattern'];
export type PatchPattern = Schemas['PatchPattern'];

/** How a pattern came to be. Only `captured` is produced today. */
export type PatternOrigin =
  | 'captured'
  | 'authored'
  | 'generated'
  | 'remixed'
  | 'imported';

// ---------- Uploads & health ----------

export type UploadRequest = Schemas['UploadRequest'];
export type UploadUrlResponse = Schemas['UploadResponse'];
export type HealthBody = Schemas['HealthBody'];
export type ComponentStatus = Schemas['ComponentStatus'];

/** Every non-2xx response from the API has this shape. */
export type ErrorBody = Schemas['ErrorBody'];

// The raw generated trees, for anything the aliases above don't cover.
export type { components, operations, paths } from './generated';
