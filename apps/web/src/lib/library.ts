// Library data model.
//
// Three concepts, deliberately separated:
//
//   TileSource    — immutable catalog entry (svg path + default layer colors)
//   TileInstance  — a user's customization (source id + layer overrides)
//   ResolvedTile  — source ⊕ instance, ready for the SVG renderer
//
// The legacy code conflated these: clicking a tile mutated the source's
// `layers` object in place, so the original defaults were lost until a
// full page reload. Splitting the concepts lets us implement reset,
// undo/redo, persist user instances separately from the catalog, and
// eventually load the catalog from JSON or a backend without rewriting
// the rendering path.

import { ITile, Dict } from '../context/interfaces';
import { loadUserTiles } from './userTiles';
import type { PipelineOutput } from './habanetaBackend';
import { listPatterns, type PatternResponse } from './patternsApi';

export type TileKind = 'floor' | 'border';

export interface TileSource {
  id: string;                      // stable slug, e.g. "contemporary/l05"
  kind: TileKind;
  family: string;                  // family display name, e.g. "Contemporary"
  displayName: string;             // "Mod. l05"
  svgUrl: string;                  // primary SVG path (relative to index.html)
  cornerUrl?: string;              // border variants
  cornerInteriorUrl?: string;
  // Default colors by layer id. Keying convention varies by source:
  //   - Builtin tiles: legacy `stN` keys (paired with `colora` class
  //     on each path; `paintLayer` walks `class="colora stN"`).
  //   - v2 user tiles (pipeline-driven): `layer-N` keys + optional
  //     `contour` (paths use `class="layer-N"` / `class="contour"`;
  //     CompositionCanvas binds them to `--habaneta-layer-N` /
  //     `--habaneta-contour` CSS variables).
  // Render dispatch in `<SVGTileBase>` branches on `pipeline` presence
  // so the two conventions never share a code path. Anything that
  // walks `Object.keys(layers)` blindly should know which it has.
  layers: Dict<string>;
  grids?: number[][];              // floor rotation patterns
  tags?: string[];
  source: 'builtin' | 'user';
  /**
   * Backend pipeline output, when this tile was produced by the
   * habaneta-backend image-import service. Carried alongside `svgUrl`
   * so the existing renderer keeps working today, and so the future
   * recolor / multi-atom / lattice-aware render path can branch on
   * its presence without re-importing the source image.
   */
  pipeline?: PipelineOutput;
  /**
   * Capture metadata for cloud-saved patterns. Set when the pattern
   * was imported via the photo-hunt flow (mobile or web). Empty for
   * builtin tiles. Surface in the detail dialog; the renderer ignores it.
   */
  captured?: {
    at: string; // ISO timestamp
    geoLat?: number | null;
    geoLng?: number | null;
    placeName?: string | null;
  };
  /** 1-hour signed URL pointing at the original photo on R2. */
  photoUrl?: string | null;
}

export interface TileInstance {
  sourceId: string;
  layerOverrides: Dict<string>;    // only the layers the user has changed
}

/**
 * A named color scheme saved by a user for a specific tile. A preset
 * is essentially a TileInstance with a display name and some metadata,
 * persisted separately so it can be applied to future edits of the
 * same source tile.
 */
export interface TilePreset {
  id: string;                      // `${sourceId}:${timestamp}`
  sourceId: string;                // → TileSource.id
  name: string;                    // user-given, e.g. "Ocean blue"
  layerOverrides: Dict<string>;
  createdAt: string;               // ISO timestamp
}

/**
 * A TileSource merged with a TileInstance's overrides. Shape-compatible
 * with the legacy ITile / IFloor / IBorder union so existing rendering
 * components (SVGBase, SVGTile, grid sub-components) can consume it
 * without changes.
 */
export interface ResolvedTile extends ITile {
  _sourceId: string;
  layers: Dict<string>;
  cornerUrl?: string;
  cornerInteriorUrl?: string;
  grids?: number[][];
}

/** Build an empty TileInstance for a freshly-picked source. */
export function newInstance(source: TileSource): TileInstance {
  return { sourceId: source.id, layerOverrides: {} };
}

/** Merge a source with an instance's overrides into a render-ready tile. */
export function resolveTile(
  source: TileSource,
  instance: TileInstance
): ResolvedTile {
  return {
    name: source.displayName,
    type: source.kind === 'floor' ? 'Floor' : 'Border',
    imgUrl: source.svgUrl,
    cornerUrl: source.cornerUrl,
    cornerInteriorUrl: source.cornerInteriorUrl,
    layers: { ...source.layers, ...instance.layerOverrides },
    grids: source.grids,
    _sourceId: source.id,
    pipeline: source.pipeline,
  };
}

/**
 * Paint a single layer on an instance. Returns a new instance with the
 * layer override updated. Does not mutate either argument.
 */
export function paintInstanceLayer(
  instance: TileInstance,
  layerId: string,
  color: string
): TileInstance {
  return {
    ...instance,
    layerOverrides: { ...instance.layerOverrides, [layerId]: color },
  };
}

// ---------- Catalog loading ----------

/** Fetch the built-in tile catalog from public/library.json. */
async function fetchBuiltinLibrary(): Promise<TileSource[]> {
  const res = await fetch('/library.json');
  if (!res.ok) {
    throw new Error(`Failed to load library.json: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as TileSource[];
}

/**
 * Fetch the full tile catalog — builtins from `public/library.json`
 * plus user-saved patterns from the cloud backend (`GET /v1/patterns`).
 * Patterns are mapped into the `TileSource` shape so the existing
 * render path keeps working unchanged. The dispatch in `<SVGTileBase>`
 * branches on `tile.pipeline` for v2-aware rendering.
 *
 * Backend-down handling: the patterns fetch is best-effort. If it
 * fails (network, 503, CORS), we log and return only the builtin
 * catalog rather than failing the whole library page. The image-import
 * dialog has its own pre-flight backend check, so users see a clear
 * error there if they try to capture.
 */
export async function fetchLibrary(): Promise<TileSource[]> {
  const [builtin, idbTiles, patterns] = await Promise.all([
    fetchBuiltinLibrary(),
    loadUserTiles(),
    listPatterns().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[library] failed to fetch patterns from backend:', err);
      return [] as PatternResponse[];
    }),
  ]);
  return [...builtin, ...idbTiles, ...patterns.map(patternToTileSource)];
}

/** Inline 1×1 transparent SVG. v2 tiles render via `pipeline`, not `svgUrl`. */
const PIPELINE_PLACEHOLDER_SVG_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'
  );

/**
 * Adapt a backend `PatternResponse` into the `TileSource` shape that
 * the existing library / editor render code expects. The pipeline
 * rides along in `tile.pipeline` so `<SVGTileBase>` dispatches to
 * `<CompositionCanvas>` automatically.
 */
function patternToTileSource(p: PatternResponse): TileSource {
  return {
    id: `pattern/${p.id}`,
    kind: (p.kind === 'border' ? 'border' : 'floor') as TileKind,
    family: p.family,
    displayName: p.name,
    svgUrl: PIPELINE_PLACEHOLDER_SVG_URL,
    layers: (p.layers ?? {}) as Dict<string>,
    source: 'user',
    pipeline: p.pipeline,
    captured: {
      // A pattern without a capture (authored, generated) has no capture time;
      // fall back to when the record was created so the detail view always
      // has something true to show.
      at: p.captured_at ?? p.created_at,
      geoLat: p.geo_lat,
      geoLng: p.geo_lng,
      placeName: p.place_name,
    },
    photoUrl: p.photo_url ?? null,
  };
}

/** List of all family names that contain at least one tile, grouped by kind. */
export interface FamilyMeta {
  name: string;
  kind: TileKind;
  count: number;
}

export function listFamilies(library: TileSource[]): FamilyMeta[] {
  const map = new Map<string, FamilyMeta>();
  for (const t of library) {
    const key = `${t.kind}:${t.family}`;
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { name: t.family, kind: t.kind, count: 1 });
  }
  return [...map.values()];
}

/** Find a TileSource by id in a library. */
export function findSource(
  library: TileSource[],
  sourceId: string
): TileSource | undefined {
  return library.find((t) => t.id === sourceId);
}
