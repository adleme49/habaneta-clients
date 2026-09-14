// End-to-end smoke for the backend-driven image import flow:
//   import → recolor → adjust lighting → save → reopen in editor →
//   commit to floor → set rotation pattern → assert recolor + rotation
//   propagate to the floor preview.
//
// Skips cleanly when habaneta-backend is unreachable, so this can run
// in CI environments where only the frontend is up.

import { chromium } from 'playwright';

const BACKEND_URL = process.env.VITE_HABANETA_API ?? 'http://localhost:8080';
const FRONTEND_URL = `${process.env.WEB_URL || 'http://localhost:3000'}`;

// When the backend URL was given explicitly we are pointed at a deployed
// environment on purpose, so an unreachable backend is a failure. Falling back
// to the localhost default means nobody started one locally, which stays a skip.
const BACKEND_EXPLICIT = Boolean(process.env.VITE_HABANETA_API);

async function backendReachable() {
  // A suspended Fly machine takes a few seconds to wake, so the first probe
  // against a deployed environment routinely exceeds a short timeout.
  const attempts = BACKEND_EXPLICIT ? 3 : 1;
  const timeoutMs = BACKEND_EXPLICIT ? 10000 : 1500;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${BACKEND_URL}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Probe whether R2 is configured on the backend. The save step in
 * the patterns flow needs presigned R2 PUTs — without R2, /v1/upload-url
 * returns 503 and Save fails. Detect this once up-front so the test
 * runs end-to-end on a fully-wired backend AND passes (with a clear
 * skip note) on a DB-only local backend.
 */
async function r2Configured() {
  try {
    const res = await fetch(`${BACKEND_URL}/v1/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await backendReachable())) {
  if (BACKEND_EXPLICIT) {
    // Exiting 0 here would let a staging or production run that never connected
    // report as a pass — the same "green for the wrong reason" failure this
    // file's floor-preview assertion used to have.
    console.error(
      `image-import-backend smoke failed: backend not reachable at ${BACKEND_URL}/healthz ` +
        `(VITE_HABANETA_API was set, so this is a real failure, not a skip)`
    );
    process.exit(1);
  }
  console.log(`[skip] habaneta-backend not reachable at ${BACKEND_URL}/healthz`);
  process.exit(0);
}

const R2_LIVE = await r2Configured();
if (!R2_LIVE) {
  console.log('[note] R2 not configured on backend — save step will be skipped');
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

function fail(msg) {
  throw new Error(msg);
}

let exitCode = 0;
try {
  await page.goto(`${FRONTEND_URL}/library`, { waitUntil: 'networkidle' });

  // Reset prior user tiles for a clean slate.
  await page.evaluate(async () => {
    const { del } = await import('https://esm.sh/idb-keyval@6');
    await del('habaneta:user-tiles');
  });
  await page.reload({ waitUntil: 'networkidle' });

  // ---- 1. Submit + verify v2 atom shape + auto-layers ----
  await page.getByRole('button', { name: 'Import image' }).click();
  await page.waitForSelector('#image-import-file');
  await page.locator('#image-import-file').setInputFiles('public/assets/Gallery/f3.jpeg');
  await page.waitForSelector('div[role="dialog"] svg use', { timeout: 60000 });

  const atomStats = await page.evaluate(() => {
    const symbol = document.querySelector('div[role="dialog"] svg symbol');
    return symbol
      ? {
          layerPaths: symbol.querySelectorAll('path[class^="layer-"]').length,
          contourPaths: symbol.querySelectorAll('path[class="contour"]').length,
        }
      : null;
  });
  if (!atomStats || atomStats.layerPaths < 2) {
    fail(`expected ≥2 layer paths in v2 atom, got ${JSON.stringify(atomStats)}`);
  }
  if (atomStats.contourPaths !== 1) {
    fail(`expected 1 contour path with default params, got ${atomStats.contourPaths}`);
  }

  // Quality badge: default flow runs auto-layer detection.
  const qualityText = await page
    .locator('[data-testid="quality-badge"]')
    .innerText();
  if (!/auto/i.test(qualityText)) {
    fail(`expected "(auto)" in quality badge, got "${qualityText}"`);
  }

  // ---- 2. Recolor a swatch -> CSS var cascades ----
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('div[role="dialog"] label input[type="color"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], '#ff00ff');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  let cssVar = await page.evaluate(() =>
    document
      .querySelector('div[role="dialog"] div[style*="--habaneta-layer-0"]')
      ?.style.getPropertyValue('--habaneta-layer-0')
      .trim()
  );
  if (cssVar !== '#ff00ff') {
    fail(`recolor didn't cascade to --habaneta-layer-0; got ${cssVar}`);
  }

  // ---- 3. Lighting sliders move non-pinned layers, leave pinned alone ----
  const beforeLayer1 = await page.evaluate(() =>
    document
      .querySelector('div[role="dialog"] div[style*="--habaneta-layer-0"]')
      ?.style.getPropertyValue('--habaneta-layer-1')
      .trim()
  );
  for (const id of ['#image-import-exposure', '#image-import-warmth', '#image-import-saturation']) {
    await page.evaluate(({ id, value }) => {
      const inp = document.querySelector(id);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, value);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id, value: '0.5' });
  }
  await page.waitForTimeout(150);
  const afterLayer0 = await page.evaluate(() =>
    document
      .querySelector('div[role="dialog"] div[style*="--habaneta-layer-0"]')
      ?.style.getPropertyValue('--habaneta-layer-0')
      .trim()
  );
  const afterLayer1 = await page.evaluate(() =>
    document
      .querySelector('div[role="dialog"] div[style*="--habaneta-layer-0"]')
      ?.style.getPropertyValue('--habaneta-layer-1')
      .trim()
  );
  if (afterLayer0 !== '#ff00ff') {
    fail(`pinned layer-0 should survive slider drag; got ${afterLayer0}`);
  }
  if (!beforeLayer1 || afterLayer1 === beforeLayer1) {
    fail(`expected layer-1 to shift after lighting sliders; before=${beforeLayer1} after=${afterLayer1}`);
  }
  // Reset adjustments before saving so the persisted color = pinned override
  // for layer-0 + adjusted-baseline for the rest. We assert the whole shape
  // by simply confirming the pinned magenta survives the save.
  await page.getByRole('button', { name: /^Reset$/ }).click();
  await page.waitForTimeout(100);

  // ---- 4. Save -> /v1/patterns (cloud) — gated on R2 ----
  if (!R2_LIVE) {
    console.log('image-import-backend smoke: ok (save step skipped — R2 not configured)');
    if (errors.length) {
      console.error('runtime errors:', errors);
      exitCode = 1;
    }
    await browser.close();
    process.exit(exitCode);
  }

  const stamp = Date.now();
  const tileName = `backend-smoke-${stamp}`;
  await page.locator('#image-import-name').fill(tileName);
  await page.getByRole('button', { name: /Save tile/i }).click();
  await page.waitForSelector('div[role="dialog"]', { state: 'detached', timeout: 15000 });

  // Confirm the pattern landed via the API.
  const apiPatterns = await fetch(`${BACKEND_URL}/v1/patterns`).then((r) => r.json());
  const saved = apiPatterns.find((p) => p.name === tileName);
  if (!saved) fail(`saved pattern not found in /v1/patterns response (looking for ${tileName})`);
  if (!saved.pipeline) fail('saved pattern missing pipeline field');
  if (saved.layers['layer-0'] !== '#ff00ff') {
    fail(`layer-0 override not persisted; got ${saved.layers['layer-0']}`);
  }

  // ---- 5. Editor + rotation pattern ----
  await page.getByRole('button', { name: /Mine/ }).click();
  await page.waitForTimeout(150);
  await page.locator(`text=${tileName}`).first().click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Open in editor/ }).click();
  await page.waitForSelector('svg path[class^="layer-"]', { timeout: 5000 });
  await page.getByRole('button', { name: /Save to recents/i }).click();
  await page.waitForTimeout(300);
  await page.locator('#grid-pattern-select').selectOption('pinwheel');
  await page.waitForTimeout(400);

  // Scope every floor-preview probe to #grid. The same wrapper markup renders the
  // library/recents thumbnails in the sidebar, so a document-wide selector also
  // matches every other saved pattern — and the assertions below would then be
  // describing whichever tile happens to sit first in the DOM rather than the
  // preview. Only shows up once the library holds more than one user pattern,
  // which is why it passed locally against an empty database and failed on staging.
  const rotProbe = await page.evaluate(() => {
    const wrappers = Array.from(
      document.querySelectorAll('#grid div[style*="--habaneta-layer-0"]')
    );
    const rotated = wrappers.filter((w) =>
      /transform:\s*rotate\([^0]/.test(w.getAttribute('style') ?? '')
    );
    return { wrapperCount: wrappers.length, rotatedCount: rotated.length };
  });
  if (rotProbe.wrapperCount === 0) fail('no v2 wrappers in floor preview');
  if (rotProbe.rotatedCount === 0) {
    fail(`expected non-zero rotation on at least one v2 wrapper; got ${JSON.stringify(rotProbe)}`);
  }

  // The pinned magenta should still be in effect on the floor preview.
  const floorVars = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#grid div[style*="--habaneta-layer-0"]')).map((w) =>
      w.style.getPropertyValue('--habaneta-layer-0').trim()
    )
  );
  if (floorVars.length === 0) fail('no v2 wrappers in the floor preview grid');
  const unpinned = floorVars.filter((v) => v !== '#ff00ff');
  if (unpinned.length > 0) {
    fail(
      `floor preview lost the pinned override on ${unpinned.length}/${floorVars.length} cells; saw ${[...new Set(unpinned)].join(', ')}`
    );
  }

  // ---- 6. PNG export of a v2 design fires and produces a valid PNG ----
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: /^Export$/i }).click();
  const download = await downloadPromise;
  const buf = await download.createReadStream().then(async (s) => {
    const chunks = [];
    for await (const c of s) chunks.push(c);
    return Buffer.concat(chunks);
  });
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 100) fail(`PNG export too small: ${buf.length} bytes`);
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) fail(`PNG signature mismatch at byte ${i}: ${buf[i]} vs ${sig[i]}`);
  }

  console.log('image-import-backend smoke: ok');
  if (errors.length) {
    console.error('runtime errors:', errors);
    exitCode = 1;
  }
} catch (err) {
  console.error('image-import-backend smoke failed:', err.message ?? err);
  exitCode = 1;
} finally {
  await browser.close();
  process.exit(exitCode);
}
