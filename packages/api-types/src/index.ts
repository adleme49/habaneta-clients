// Shared wire types between the habaneta-backend service and its clients
// (apps/web, apps/mobile). Pure types — no runtime exports — so consumers
// can import via `@habaneta/api-types` without bundling overhead.
//
// The shape mirrors what the Rust backend emits in
// `habaneta-backend/src/types.rs`. Backend changes that add fields are
// safe to absorb additively here; breaking changes need a coordinated
// release across all three repos.

export type Vec2 = [number, number];

export type Transform =
  | { kind: 'identity' }
  | { kind: 'rotate'; degrees: number }
  | { kind: 'reflect'; axis_degrees: number };

export interface Atom {
  id: string;
  /** Raw SVG markup. Each atom is `<svg viewBox="…">` containing `<path
   *  class="layer-N">` per quantized layer + optional `<path class="contour">`. */
  svg: string;
}

export interface Lattice {
  basis_a: Vec2;
  basis_b: Vec2;
}

export interface Cell {
  atom_id: string;
  position: Vec2;
  transform: Transform;
}

export interface Composition {
  lattice: Lattice;
  cells: Cell[];
}

export interface PipelineOutput {
  atoms: Atom[];
  composition: Composition;
  /**
   * Layer colors, indexed by N (paths in atoms carry `class="layer-N"`).
   * Frontend treats `palette.length` as authoritative — the backend may
   * clamp or auto-detect the layer count.
   */
  palette: { hex: string }[];
  /**
   * Color of the contour layer (paths carry `class="contour"`). Null when
   * the contour pass was disabled or no thin components survived the
   * thickness gate.
   */
  contour: { hex: string } | null;
  /**
   * Backend-reported pipeline metadata. `passes` lists named stages that
   * actually ran (e.g. `"bilateral"`, `"contour"`, `"auto_layers"`).
   * `"auto_layers"` is emitted iff k was auto-detected.
   */
  quality?: { passes: string[] };
}

/**
 * Optional per-job parameters for `POST /v1/jobs`. Send only fields the
 * user explicitly changed; omitted fields fall back to server defaults.
 * Setting `contour: null` disables the contour pass entirely.
 */
export interface JobParams {
  target_px?: number;
  layers?: number;
  denoise?: number;
  min_region_px?: number;
  auto_levels?: boolean;
  contour?: { sensitivity?: number; max_thickness?: number } | null;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobStatusResponse {
  status: JobStatus;
  error?: string;
}

/**
 * A persisted pattern (stored cloud-side once the backend gains the
 * /v1/patterns API in v1 of the platform). Embeds the full
 * `PipelineOutput` directly. Capture metadata fields are nullable —
 * `geo_lat`/`geo_lng`/`place_name` are optional per the v1 design.
 *
 * Forward-declared here so the web app and (future) mobile app share a
 * single type. Backend implementation lands in a follow-up.
 */
export interface Pattern {
  id: string;
  name: string;
  family: string;
  kind: 'floor' | 'border';
  /**
   * How the pattern came to be. `captured` is the only value produced today;
   * the others exist because a pattern no longer has to come from a photo.
   */
  origin: 'captured' | 'authored' | 'generated' | 'remixed' | 'imported';
  /**
   * The capture behind this pattern. Null for a pattern with no photo —
   * authored in the editor, or generated. Nothing produces those yet.
   */
  photo_key: string | null;
  captured_at: string | null; // ISO timestamp
  geo_lat: number | null;
  geo_lng: number | null;
  place_name: string | null;
  pipeline: PipelineOutput;
  /** Effective colours: the default colourway's overrides. */
  layers: Record<string, string>;
  /**
   * The pipeline version and settings that produced this pattern, from its
   * derivation. Null for patterns saved before runs were recorded, and for
   * any save that doesn't pass a `job_id`.
   */
  pipeline_version: string | null;
  params: JobParams | null;
  created_at: string;
  updated_at: string;
}
