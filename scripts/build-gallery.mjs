#!/usr/bin/env node
// Builds a single self-contained HTML page from the screenshots every scenario
// captured, pairing each surface against the same surface from the other
// variant.
//
// Written for a human opening a zip: relative links only, no CDN, no build
// step, works offline by double-clicking index.html.
//
// Input layout (what the CI artifacts unpack into):
//   <root>/playwright-main-<scenario>/visual/<scenario>/<surface-state>.png
//   <root>/playwright-published-<scenario>/visual/<scenario>/<surface-state>.png
// Locally, a plain visual/<scenario>/*.png tree works too - it is then treated
// as the "main" variant.
//
// Usage: node scripts/build-gallery.mjs <input-root> <output-dir> [runUrl]

import fs from 'node:fs';
import path from 'node:path';

const [, , inputRoot = 'artifacts', outDir = 'gallery', runUrl = ''] = process.argv;

/**
 * Find every deliberately-captured screenshot under root, tagged with its
 * variant and scenario.
 *
 * Only PNGs beneath a `visual/` directory count. The uploaded artifacts also
 * contain the Playwright HTML report and `test-results/`, whose images are
 * content-hash named (`<sha1>.png`) and per-run: they can never pair across
 * variants, so collecting them turns most of the gallery into single-sided
 * rows of unidentifiable screenshots and buries the surfaces a reviewer is
 * here to look at.
 */
function collect(root) {
  const shots = [];
  const walk = (dir, variant, scenario, inVisual) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const m = entry.name.match(/^playwright-(main|published)-(.+)$/);
        if (m) walk(full, m[1], m[2], false);
        else if (entry.name === 'visual') walk(full, variant, scenario, true);
        // Inside visual/, each subdirectory is a scenario.
        else walk(full, variant, inVisual ? entry.name : scenario, inVisual);
      } else if (inVisual && entry.name.endsWith('.png')) {
        const base = entry.name.replace(/\.png$/, '');
        const dark = base.endsWith('__dark');
        shots.push({
          variant: variant ?? 'main',
          scenario: scenario ?? 'unknown',
          surface: dark ? base.slice(0, -'__dark'.length) : base,
          theme: dark ? 'dark' : 'light',
          file: full,
        });
      }
    }
  };
  // Pointing the script straight at a visual/ directory is the natural thing to
  // do locally, and it must not come back empty.
  walk(root, undefined, undefined, path.basename(path.resolve(root)) === 'visual');
  return shots;
}

/**
 * Session recordings, one per test, tagged with the test's real title.
 *
 * Playwright names its output directories by truncating the test title around a
 * hash ("alerts-a-rule-matching-a-r-0bca7-ppears-as-an-alert-instance"), so the
 * titles come from the JSON report instead. Where the report is missing the
 * directory name is de-slugged as a fallback - a recording with an awkward
 * label still beats no recording.
 */
function collectVideos(root) {
  const videos = [];

  /** Walk the JSON report's nested suites and yield every test result. */
  const eachTest = (suite, trail, out) => {
    // The outermost suite is the file (foo.spec.ts, auth.setup.ts); the
    // scenario heading already says which file this is.
    const here = suite.title && !/\.ts$/.test(suite.title) ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          out.push({
            title: [...here, spec.title].filter(Boolean).join(' > '),
            status: r.status,
            duration: r.duration,
            videoPaths: (r.attachments ?? [])
              .filter((a) => a.name === 'video' && a.path)
              .map((a) => a.path.replace(/\\/g, '/')),
          });
        }
      }
    }
    for (const child of suite.suites ?? []) eachTest(child, here, out);
  };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = entry.name.match(/^playwright-(main|published)-(.+)$/);
    const variant = m ? m[1] : 'main';
    const scenario = m ? m[2] : entry.name;
    const artifact = path.join(root, entry.name);
    const resultsDir = path.join(artifact, 'test-results');
    if (!fs.existsSync(resultsDir)) continue;

    // Absolute paths in the report point at the CI machine, so match on the
    // tail from test-results/ onwards, which survives the artifact round trip.
    const byTail = new Map();
    for (const dir of fs.readdirSync(resultsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = path.join(resultsDir, dir.name, 'video.webm');
      if (fs.existsSync(file)) byTail.set(`${dir.name}/video.webm`, { file, dir: dir.name });
    }
    if (!byTail.size) continue;

    const claimed = new Set();
    const reportPath = path.join(resultsDir, 'results.json');
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const tests = [];
        for (const s of report.suites ?? []) eachTest(s, [], tests);
        for (const t of tests) {
          for (const p of t.videoPaths) {
            const tail = p.split('/').slice(-2).join('/');
            const hit = byTail.get(tail);
            if (!hit) continue;
            claimed.add(tail);
            videos.push({ variant, scenario, title: t.title, status: t.status, duration: t.duration, file: hit.file });
          }
        }
      } catch {
        /* a malformed report must not cost us the recordings themselves */
      }
    }

    // Anything the report did not account for (including the shared sign-in
    // step, which is its own project) still belongs in the review.
    for (const [tail, hit] of byTail) {
      if (claimed.has(tail)) continue;
      videos.push({
        variant,
        scenario,
        title: hit.dir.replace(/-chromium$|-setup$/, '').replace(/-/g, ' '),
        status: undefined,
        duration: undefined,
        file: hit.file,
      });
    }
  }
  return videos;
}

/** Console-error attachments a spec wrote, keyed by scenario. */
function collectConsoleErrors(root) {
  const found = {};
  const walk = (dir, scenario) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const m = entry.name.match(/^playwright-(?:main|published)-(.+)$/);
        walk(full, m ? m[1] : scenario);
      } else if (/console-errors\.json$/.test(entry.name)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (Array.isArray(parsed) && parsed.length) {
            (found[scenario ?? 'unknown'] ??= []).push(...parsed);
          }
        } catch {
          /* a malformed attachment is not worth failing the gallery over */
        }
      }
    }
  };
  walk(root, undefined);
  return found;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const shots = collect(inputRoot);
if (!shots.length) {
  console.error(`no screenshots found under ${inputRoot}`);
  process.exit(1);
}
const consoleErrors = collectConsoleErrors(inputRoot);

// Copy the session recordings, keyed by scenario so each section can carry its
// own. Names are slugged from the test title, which keeps a downloaded file
// meaningful on its own once it is out of the page.
const videosByScenario = new Map();
let videoBytes = 0;
const rawVideos = collectVideos(inputRoot);
if (rawVideos.length) fs.mkdirSync(path.join(outDir, 'video'), { recursive: true });
for (const v of rawVideos) {
  const slug = v.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const rel = path.join('video', `${v.variant}__${v.scenario}__${slug || 'session'}.webm`);
  fs.copyFileSync(v.file, path.join(outDir, rel));
  videoBytes += fs.statSync(v.file).size;
  const list = videosByScenario.get(v.scenario) ?? [];
  list.push({ ...v, rel });
  videosByScenario.set(v.scenario, list);
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// Copy images into the output under stable relative paths.
fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });
const byScenario = new Map();
for (const shot of shots) {
  const rel = path.join('img', `${shot.variant}__${shot.theme}__${shot.scenario}__${shot.surface}.png`);
  fs.copyFileSync(shot.file, path.join(outDir, rel));
  const scenario = byScenario.get(shot.scenario) ?? new Map();
  const surface = scenario.get(shot.surface) ?? {};
  (surface[shot.variant] ??= {})[shot.theme] = rel;
  scenario.set(shot.surface, surface);
  byScenario.set(shot.scenario, scenario);
}

const scenarios = [...byScenario.keys()].sort();
// A surface is one screen; a screenshot is one image of it. With both themes
// captured on both variants a single surface can be four images, so reporting
// only one of the two numbers reads as if most of the run went missing.
const totalSurfaces = [...byScenario.values()].reduce((n, m) => n + m.size, 0);
const totalShots = shots.length;
const bothVariants = [...byScenario.values()].reduce(
  (n, m) => n + [...m.values()].filter((v) => v.main?.light && v.published?.light).length,
  0,
);
const onlyMain = [...byScenario.values()].reduce(
  (n, m) => n + [...m.values()].filter((v) => v.main?.light && !v.published?.light).length,
  0,
);

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

/** One pane. Carries both themes so the toggle can swap without re-rendering. */
function pane(shot, alt) {
  if (!shot?.light && !shot?.dark) return '<div class="missing">not captured</div>';
  const light = shot.light ?? shot.dark;
  const dark = shot.dark ?? shot.light;
  const noDark = shot.dark ? '' : ' <span class="nodark">light only</span>';
  return `<a href="${light}" data-light="${light}" data-dark="${dark}">` +
    `<img loading="lazy" src="${light}" data-light="${light}" data-dark="${dark}" alt="${esc(alt)}"></a>${noDark}`;
}

/**
 * The session recordings for one scenario, grouped by test.
 *
 * preload="metadata" matters: with ~100 recordings on the page, preloading the
 * media itself would pull the whole artifact into memory on open. Nothing is
 * fetched until a reviewer presses play, and each has a download link for
 * anyone who would rather watch it outside the page.
 */
function recordings(scenario) {
  const list = videosByScenario.get(scenario);
  if (!list?.length) return '';
  const byTitle = new Map();
  for (const v of list) {
    const group = byTitle.get(v.title) ?? {};
    group[v.variant] = v;
    byTitle.set(v.title, group);
  }
  const cell = (v, label) => {
    if (!v) return `<div class="pane"><div class="label"><span>${label}</span></div><div class="missing">not recorded</div></div>`;
    const secs = v.duration ? ` &middot; ${(v.duration / 1000).toFixed(1)}s` : '';
    const status = v.status && v.status !== 'passed' ? ` <strong>${esc(v.status)}</strong>` : '';
    return `<div class="pane">
            <div class="label"><span>${label}${secs}${status}</span><a href="${v.rel}" download>download</a></div>
            <video controls preload="metadata" src="${v.rel}"></video>
          </div>`;
  };
  return `    <div class="surface">
      <h3>Session recordings <code style="color:var(--muted)">${byTitle.size} test${byTitle.size === 1 ? '' : 's'}</code></h3>
${[...byTitle.entries()]
  .map(
    ([t, g]) => `      <div class="rec">
        <div class="rectitle">${esc(t)}</div>
        <div class="pair">
          ${cell(g.main, 'built from main')}
          ${cell(g.published, 'published release')}
        </div>
      </div>`,
  )
  .join('\n')}
    </div>
`;
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>radar e2e - visual review</title>
<style>
  :root { color-scheme: light dark; --line:#8883; --muted:#8a8a8a; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
  header { padding: 24px 32px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
           backdrop-filter: blur(8px); background: color-mix(in srgb, Canvas 85%, transparent); z-index: 2; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; }
  nav { padding: 12px 32px; border-bottom: 1px solid var(--line); font-size: 13px; }
  nav a { margin-right: 14px; white-space: nowrap; }
  main { padding: 8px 32px 64px; }
  section { margin: 32px 0; scroll-margin-top: 120px; }
  h2 { font-size: 17px; margin: 0 0 4px; }
  .hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .surface { border: 1px solid var(--line); border-radius: 10px; margin: 14px 0; overflow: hidden; }
  .surface > h3 { margin: 0; padding: 10px 14px; font-size: 14px; border-bottom: 1px solid var(--line);
                  background: color-mix(in srgb, Canvas 92%, CanvasText); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); }
  .pane { background: Canvas; padding: 10px; }
  .pane > .label { font-size: 12px; color: var(--muted); margin-bottom: 8px; display: flex; justify-content: space-between; }
  .pane img { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
  .missing { color: var(--muted); font-size: 13px; padding: 28px 10px; text-align: center;
             border: 1px dashed var(--line); border-radius: 6px; }
  .warn { border-left: 3px solid #e0a800; padding: 10px 14px; margin: 14px 0; font-size: 13px;
          background: color-mix(in srgb, Canvas 94%, #e0a800); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .themes { margin-right: 18px; }
  .themes button { font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
                   border: 1px solid var(--line); background: Canvas; color: inherit; }
  .themes button:first-child { border-radius: 6px 0 0 6px; }
  .themes button:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
  .themes button.on { background: color-mix(in srgb, Canvas 80%, CanvasText); font-weight: 600; }
  .nodark { font-size: 11px; color: var(--muted); }
  .rec { border-top: 1px solid var(--line); }
  .rec:first-of-type { border-top: 0; }
  .rectitle { padding: 9px 14px; font-size: 13px; }
  .pane video { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; background: #000; }
  .pane > .label a { font-size: 12px; }
  footer { padding: 24px 32px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
</style>
<header>
  <h1>radar e2e - visual review</h1>
  <div class="sub">
    ${stamp} UTC &middot; ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}
    &middot; ${totalSurfaces} surface${totalSurfaces === 1 ? '' : 's'} &middot; ${totalShots} screenshot${totalShots === 1 ? '' : 's'}
    &middot; ${bothVariants} surface${bothVariants === 1 ? '' : 's'} captured on both variants${onlyMain ? `, ${onlyMain} on main only` : ''}
    ${rawVideos.length ? `&middot; ${rawVideos.length} session recording${rawVideos.length === 1 ? '' : 's'} (${mb(videoBytes)})` : ''}
    ${runUrl ? `&middot; <a href="${esc(runUrl)}">run log</a>` : ''}
  </div>
</header>
<nav>
  <span class="themes">
    <button id="t-light" class="on" onclick="setTheme('light')">light</button><button id="t-dark" onclick="setTheme('dark')">dark</button>
  </span>
  ${scenarios.map((s) => `<a href="#${esc(s)}">${esc(s)}</a>`).join('')}
</nav>
<script>
  // Swap every image in place rather than making the reviewer scroll a second
  // set: same page, same length, dark theme one click away.
  function setTheme(theme) {
    for (const el of document.querySelectorAll('img[data-light], a[data-light]')) {
      const src = theme === 'dark' ? el.dataset.dark : el.dataset.light;
      if (el.tagName === 'IMG') el.src = src; else el.href = src;
    }
    document.getElementById('t-light').className = theme === 'light' ? 'on' : '';
    document.getElementById('t-dark').className = theme === 'dark' ? 'on' : '';
  }
</script>
<main>
  <p class="hint">
    Left is <strong>built from main</strong>, right is the <strong>published release</strong>. A surface present on
    one side only usually means the feature does not exist in the other - which is itself the thing to look at.
    Click any image to open it full size.
  </p>
${scenarios
  .map((scenario) => {
    const surfaces = [...byScenario.get(scenario).entries()].sort(([a], [b]) => a.localeCompare(b));
    const errs = consoleErrors[scenario];
    return `  <section id="${esc(scenario)}">
    <h2>${esc(title(scenario))}</h2>
    <p class="hint">${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}</p>
${errs ? `    <div class="warn"><strong>Console errors during this scenario:</strong><br><code>${errs.slice(0, 6).map(esc).join('<br>')}</code></div>\n` : ''}${surfaces
      .map(
        ([surface, v]) => `    <div class="surface">
      <h3>${esc(title(surface))} <code style="color:var(--muted)">${esc(surface)}</code></h3>
      <div class="pair">
        <div class="pane"><div class="label"><span>built from main</span></div>
          ${pane(v.main, `${surface} on main`)}
        </div>
        <div class="pane"><div class="label"><span>published release</span></div>
          ${pane(v.published, `${surface} on the published release`)}
        </div>
      </div>
    </div>`,
      )
      .join('\n')}
${recordings(scenario)}  </section>`;
  })
  .join('\n')}
</main>
<footer>
  Screenshots are taken at deliberate moments inside each test, not at random - the name says which surface and
  which state. Anything captured on one variant only is worth a look: it usually means main and the release differ.
</footer>
`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(
  `gallery: ${scenarios.length} scenarios, ${totalSurfaces} surfaces, ` +
    `${totalShots} screenshots -> ${path.join(outDir, 'index.html')}`,
);
