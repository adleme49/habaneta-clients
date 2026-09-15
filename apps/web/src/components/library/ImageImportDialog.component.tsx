import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  checkHealth,
  HabanetaBackendError,
  JobParamsInput,
  JobStatus,
  PipelineOutput,
  runImageImport,
} from '../../lib/habanetaBackend';
import type { NewPattern } from '../../lib/patternsApi';
import { Dict } from '../../context/interfaces';
import { slugify } from '../../lib/utils';
import { useSavePatternMutation } from '../../lib/queries';
import {
  adjustHex,
  isNeutral,
  NO_ADJUSTMENTS,
  PaletteAdjustments,
} from '../../lib/palette-adjust';
import CompositionCanvas from '../common/CompositionCanvas.component';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const PREVIEW_SIZE = 240;

// UI defaults shown until the user touches a control. Should match the
// server-side defaults closely so the displayed value isn't misleading
// — but the form only *sends* fields the user explicitly changed.
interface ParamsForm {
  target_px: number;
  layers: number;
  /** When true, omit `layers` from the request and let the backend pick k. */
  layersAuto: boolean;
  denoise: number;
  contourEnabled: boolean;
  contour_sensitivity: number;
  contour_max_thickness: number;
}
const DEFAULT_PARAMS: ParamsForm = {
  target_px: 1024,
  layers: 5,
  // Auto by default — the backend's auto-detector picks k=3..5 well
  // for typical tile photos. Manual override is one click away.
  layersAuto: true,
  denoise: 0.5,
  contourEnabled: true,
  contour_sensitivity: 0.5,
  contour_max_thickness: 6,
};

const ImageImportDialog: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineOutput | null>(null);
  const [status, setStatus] = useState<JobStatus | 'idle' | 'submitting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [family, setFamily] = useState('My Imports');
  const [params, setParams] = useState<ParamsForm>(DEFAULT_PARAMS);
  const [touched, setTouched] = useState<Set<keyof ParamsForm>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrides, setOverrides] = useState<Dict<string>>({});
  const [adjustments, setAdjustments] =
    useState<PaletteAdjustments>(NO_ADJUSTMENTS);
  // null = not yet checked; true/false = result of last health check.
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  // The run that produced `pipeline`. Sent on save so the pattern records
  // what settings and pipeline version made it.
  const [jobId, setJobId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const saveMutation = useSavePatternMutation();

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setFile(null);
    setImagePreviewUrl(null);
    setPipeline(null);
    setJobId(null);
    setStatus('idle');
    setError(null);
    setDisplayName('');
    setFamily('My Imports');
    setParams(DEFAULT_PARAMS);
    setTouched(new Set());
    setAdvancedOpen(false);
    setOverrides({});
    setAdjustments(NO_ADJUSTMENTS);
    saveMutation.reset();
  };

  const close = () => {
    reset();
    setOpen(false);
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  // Pre-flight health check whenever the dialog opens. Re-checks on
  // every open so a backend brought up after a denied dialog will
  // unblock without a page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBackendUp(null);
    const ctrl = new AbortController();
    checkHealth(ctrl.signal)
      .then((ok) => {
        if (!cancelled) setBackendUp(ok);
      })
      .catch(() => {
        if (!cancelled) setBackendUp(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [open]);

  const retryHealth = () => {
    setBackendUp(null);
    checkHealth().then((ok) => setBackendUp(ok));
  };

  const setParam = <K extends keyof ParamsForm>(key: K, value: ParamsForm[K]) => {
    setParams((p) => ({ ...p, [key]: value }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const buildJobParams = (): JobParamsInput => {
    const out: JobParamsInput = {};
    if (touched.has('target_px')) out.target_px = params.target_px;
    // Layers: only send when the user opted out of Auto. Per backend
    // contract, leaving the field out (not null, not 0) triggers
    // auto-detection.
    if (!params.layersAuto) out.layers = params.layers;
    if (touched.has('denoise')) out.denoise = params.denoise;
    if (touched.has('contourEnabled') && !params.contourEnabled) {
      out.contour = null;
    } else {
      const c: { sensitivity?: number; max_thickness?: number } = {};
      if (touched.has('contour_sensitivity')) c.sensitivity = params.contour_sensitivity;
      if (touched.has('contour_max_thickness')) c.max_thickness = params.contour_max_thickness;
      if (Object.keys(c).length > 0) out.contour = c;
    }
    return out;
  };

  const submit = async (f: File) => {
    abortRef.current?.abort();
    setPipeline(null);
    setOverrides({});
    setAdjustments(NO_ADJUSTMENTS);
    setError(null);
    saveMutation.reset();
    setStatus('submitting');

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const result = await runImageImport(f, {
        signal: ctrl.signal,
        onStatus: (s) => setStatus(s),
        params: buildJobParams(),
      });
      if (ctrl.signal.aborted) return;
      setPipeline(result.output);
      setJobId(result.jobId);
      setStatus('done');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const msg =
        e instanceof HabanetaBackendError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setStatus('idle');
    }
  };

  const handleFile = (f: File) => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setFile(f);
    setImagePreviewUrl(URL.createObjectURL(f));
    if (!displayName) {
      setDisplayName(f.name.replace(/\.(png|jpe?g|webp|bmp|gif|heic|heif)$/i, ''));
    }
    submit(f);
  };

  const handleSave = async () => {
    if (!pipeline || !file) return;
    try {
      await saveMutation.mutateAsync({
        file,
        body: pipelineToPatternRequest(
          pipeline,
          displayName,
          family,
          overrides,
          adjustments,
          file,
          jobId
        ),
      });
      close();
    } catch {
      /* error banner shown via mutation state */
    }
  };

  const isProcessing =
    status === 'submitting' || status === 'queued' || status === 'running';

  // Effective layer colors = adjustment-shifted palette baseline, then
  // user click-overrides pinned on top. Memoized so CompositionCanvas's
  // CSS-var diff is cheap.
  const effectiveLayers = useMemo<Dict<string>>(() => {
    if (!pipeline) return {};
    const out: Dict<string> = {};
    pipeline.palette.forEach((p, i) => {
      const key = `layer-${i}`;
      out[key] = overrides[key] ?? adjustHex(p.hex, adjustments);
    });
    if (pipeline.contour) {
      out.contour = overrides.contour ?? adjustHex(pipeline.contour.hex, adjustments);
    }
    return out;
  }, [pipeline, overrides, adjustments]);

  const swatchColor = (key: string) =>
    effectiveLayers[key] ?? '#ffffff';

  const setAdjust = <K extends keyof PaletteAdjustments>(
    key: K,
    value: number
  ) => setAdjustments((a) => ({ ...a, [key]: value }));

  const adjustmentsDirty = !isNeutral(adjustments);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else setOpen(true);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">{t('library.imageImport.trigger')}</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('library.imageImport.title')}</DialogTitle>
          <DialogDescription>
            {t('library.imageImport.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-y-auto -mx-6 px-6">
          {backendUp === false ? (
            <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3 flex items-center justify-between gap-3">
              <span>{t('library.imageImport.backendDown')}</span>
              <Button size="sm" variant="outline" onClick={retryHealth}>
                {t('library.imageImport.retry')}
              </Button>
            </div>
          ) : null}
          <div>
            <Label htmlFor="image-import-file">
              {t('library.imageImport.imageFile')}
            </Label>
            <input
              id="image-import-file"
              type="file"
              accept="image/png,image/jpeg,image/heic,image/heif"
              disabled={backendUp === false}
              className="mt-1 block w-full text-sm file:mr-4 file:rounded file:border file:border-input file:bg-transparent file:px-3 file:py-1 file:text-sm file:cursor-pointer disabled:opacity-50"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>

          <div className="grid grid-cols-[260px_1fr] gap-4">
            {/* Controls column */}
            <div className="space-y-3 text-sm">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Label
                    htmlFor="image-import-layers"
                    className={params.layersAuto ? 'text-muted-foreground' : ''}
                  >
                    {`${t('library.imageImport.layers')}: ${
                      params.layersAuto
                        ? t('library.imageImport.auto')
                        : params.layers
                    }`}
                  </Label>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={params.layersAuto}
                      onChange={(e) => setParam('layersAuto', e.target.checked)}
                    />
                    <span>{t('library.imageImport.auto')}</span>
                  </label>
                </div>
                <input
                  id="image-import-layers"
                  type="range"
                  min={2}
                  max={16}
                  step={1}
                  value={params.layers}
                  disabled={params.layersAuto}
                  onChange={(e) => setParam('layers', Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </div>
              <RangeRow
                id="image-import-denoise"
                label={`${t('library.imageImport.denoise')}: ${params.denoise.toFixed(2)}`}
                min={0}
                max={1}
                step={0.05}
                value={params.denoise}
                onChange={(v) => setParam('denoise', v)}
              />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={params.contourEnabled}
                  onChange={(e) => setParam('contourEnabled', e.target.checked)}
                />
                <span>{t('library.imageImport.contour')}</span>
              </label>

              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen
                  ? t('library.imageImport.hideAdvanced')
                  : t('library.imageImport.showAdvanced')}
              </button>
              {advancedOpen && (
                <div className="space-y-2 border-l pl-3">
                  <RangeRow
                    id="image-import-target-px"
                    label={`${t('library.imageImport.targetPx')}: ${params.target_px}`}
                    min={256}
                    max={2048}
                    step={128}
                    value={params.target_px}
                    onChange={(v) => setParam('target_px', v)}
                  />
                  <RangeRow
                    id="image-import-contour-sensitivity"
                    label={`${t('library.imageImport.contourSensitivity')}: ${params.contour_sensitivity.toFixed(2)}`}
                    min={0}
                    max={1}
                    step={0.05}
                    value={params.contour_sensitivity}
                    onChange={(v) => setParam('contour_sensitivity', v)}
                    disabled={!params.contourEnabled}
                  />
                  <RangeRow
                    id="image-import-contour-thickness"
                    label={`${t('library.imageImport.contourMaxThickness')}: ${params.contour_max_thickness}`}
                    min={1}
                    max={20}
                    step={1}
                    value={params.contour_max_thickness}
                    onChange={(v) => setParam('contour_max_thickness', v)}
                    disabled={!params.contourEnabled}
                  />
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                disabled={!file || isProcessing}
                onClick={() => file && submit(file)}
                className="w-full"
              >
                {t('library.imageImport.reanalyze')}
              </Button>
            </div>

            {/* Preview column */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col items-center gap-1">
                <Label className="text-center text-xs">
                  {t('library.imageImport.original')}
                </Label>
                <div
                  className="border rounded-md bg-gray-50 flex items-center justify-center overflow-hidden"
                  style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
                >
                  {imagePreviewUrl ? (
                    <img
                      src={imagePreviewUrl}
                      alt="Original"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t('library.imageImport.pickPrompt')}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-center gap-1">
                <Label className="text-center text-xs">
                  {t('library.imageImport.result')}
                </Label>
                <div
                  className="border rounded-md bg-gray-50 flex items-center justify-center overflow-hidden"
                  style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
                >
                  {pipeline ? (
                    <CompositionCanvas
                      pipeline={pipeline}
                      width={PREVIEW_SIZE}
                      height={PREVIEW_SIZE}
                      layers={effectiveLayers}
                    />
                  ) : isProcessing ? (
                    <span className="text-xs text-muted-foreground">
                      {statusLabel(status, t)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {pipeline && (
            <>
              <div
                className="text-xs text-muted-foreground"
                data-testid="quality-badge"
              >
                {qualityLabel(pipeline, t)}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground mr-1">
                  {t('library.imageImport.swatchesHint')}
                </span>
                {pipeline.palette.map((_p, i) => {
                  const layerKey = `layer-${i}`;
                  return (
                    <Swatch
                      key={layerKey}
                      color={swatchColor(layerKey)}
                      title={layerKey}
                      onChange={(hex) =>
                        setOverrides((o) => ({ ...o, [layerKey]: hex }))
                      }
                    />
                  );
                })}
                {pipeline.contour && (
                  <Swatch
                    key="contour"
                    color={swatchColor('contour')}
                    title="contour"
                    bordered
                    onChange={(hex) =>
                      setOverrides((o) => ({ ...o, contour: hex }))
                    }
                  />
                )}
              </div>

              <div className="border rounded-md p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('library.imageImport.lighting')}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline disabled:opacity-40"
                    onClick={() => setAdjustments(NO_ADJUSTMENTS)}
                    disabled={!adjustmentsDirty}
                  >
                    {t('library.imageImport.lightingReset')}
                  </button>
                </div>
                <RangeRow
                  id="image-import-exposure"
                  label={`${t('library.imageImport.exposure')}: ${formatSigned(adjustments.exposure)}`}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={adjustments.exposure}
                  onChange={(v) => setAdjust('exposure', v)}
                />
                <RangeRow
                  id="image-import-warmth"
                  label={`${t('library.imageImport.warmth')}: ${formatSigned(adjustments.warmth)}`}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={adjustments.warmth}
                  onChange={(v) => setAdjust('warmth', v)}
                />
                <RangeRow
                  id="image-import-saturation"
                  label={`${t('library.imageImport.saturation')}: ${formatSigned(adjustments.saturation)}`}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={adjustments.saturation}
                  onChange={(v) => setAdjust('saturation', v)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t('library.imageImport.lightingHint')}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="image-import-name">
                    {t('library.upload.name')}
                  </Label>
                  <Input
                    id="image-import-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t('library.upload.namePlaceholder')}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="image-import-family">
                    {t('library.upload.family')}
                  </Label>
                  <Input
                    id="image-import-family"
                    value={family}
                    onChange={(e) => setFamily(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </div>
          )}
          {saveMutation.isError && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {t('library.upload.saveFailed', {
                error: String(saveMutation.error),
              })}
            </div>
          )}
        </div>

        <DialogFooter className="border-t pt-4 -mx-6 px-6 mt-0">
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!pipeline || saveMutation.isPending || !displayName.trim()}
          >
            {saveMutation.isPending
              ? t('library.upload.saving')
              : t('library.imageImport.saveTile')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const RangeRow: React.FC<{
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}> = ({ id, label, min, max, step, value, disabled, onChange }) => (
  <div>
    <Label htmlFor={id} className={disabled ? 'text-muted-foreground' : ''}>
      {label}
    </Label>
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="mt-1 w-full"
    />
  </div>
);

const Swatch: React.FC<{
  color: string;
  title: string;
  bordered?: boolean;
  onChange: (hex: string) => void;
}> = ({ color, title, bordered, onChange }) => (
  <label
    className={
      'inline-flex items-center justify-center w-7 h-7 rounded cursor-pointer ' +
      (bordered ? 'ring-2 ring-offset-1 ring-gray-400' : 'border border-gray-200')
    }
    style={{ backgroundColor: color }}
    title={`${title}: ${color}`}
  >
    <input
      type="color"
      value={color}
      onChange={(e) => onChange(e.target.value)}
      className="opacity-0 w-0 h-0"
    />
  </label>
);

function statusLabel(
  s: JobStatus | 'idle' | 'submitting',
  t: (k: string) => string
): string {
  switch (s) {
    case 'submitting':
      return t('library.imageImport.uploading');
    case 'queued':
      return t('library.imageImport.queued');
    case 'running':
      return t('library.imageImport.processing');
    default:
      return '';
  }
}

/**
 * Adapt a backend PipelineOutput into the body for `POST /v1/patterns`.
 *
 * The effective layer colors are computed here (lighting adjustments
 * baked in, user pin-overrides on top) and persisted in `layers`. The
 * slider state itself doesn't survive — once saved, the pattern looks
 * exactly like what the user sees in the dialog right now.
 *
 * Capture metadata: photo is required, geo/place are filled by the
 * mobile client (this web dialog has no GPS context, so they stay
 * null here). `captured_at` falls back to the file's `lastModified`
 * timestamp when available — gives photos imported from a phone
 * camera roll a sensible "captured at" without prompting.
 */
function pipelineToPatternRequest(
  pipeline: PipelineOutput,
  displayName: string,
  family: string,
  overrides: Dict<string>,
  adjustments: PaletteAdjustments,
  file: File,
  jobId: string | null
): Omit<NewPattern, 'photo_key'> {
  const atom = pipeline.atoms[0];
  if (!atom) throw new Error('PipelineOutput has no atoms');
  const layers: Dict<string> = {};
  pipeline.palette.forEach((entry, i) => {
    const key = `layer-${i}`;
    layers[key] = overrides[key] ?? adjustHex(entry.hex, adjustments);
  });
  if (pipeline.contour) {
    layers.contour =
      overrides.contour ?? adjustHex(pipeline.contour.hex, adjustments);
  }
  const capturedAt = file.lastModified
    ? new Date(file.lastModified).toISOString()
    : new Date().toISOString();
  return {
    name: displayName.trim() || slugify(file.name) || 'Imported tile',
    family: family.trim() || 'My Imports',
    kind: 'floor',
    captured_at: capturedAt,
    pipeline,
    layers,
    ...(jobId ? { job_id: jobId } : {}),
    source: 'web',
  };
}

/** Render a slider value with a leading sign, e.g. "+0.30" / "-0.15". */
function formatSigned(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

/**
 * One-line summary of the result: "<k> layers (auto) · applied: bilateral, contour".
 * The "(auto)" suffix is driven by the backend's `quality.passes` containing
 * `auto_layers`. Other passes are surfaced verbatim — these are short
 * lowercase tokens by backend convention so they read fine inline.
 */
function qualityLabel(
  pipeline: PipelineOutput,
  t: (k: string, opts?: Record<string, unknown>) => string
): string {
  const k = pipeline.palette.length;
  const passes = pipeline.quality?.passes ?? [];
  const usedAuto = passes.includes('auto_layers');
  const applied = passes.filter((p) => p !== 'auto_layers');
  const head = usedAuto
    ? t('library.imageImport.layersAutoCount', { count: k })
    : t('library.imageImport.layersCount', { count: k });
  return applied.length > 0
    ? `${head} · ${t('library.imageImport.appliedPrefix')} ${applied.join(', ')}`
    : head;
}

export default ImageImportDialog;
