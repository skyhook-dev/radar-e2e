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

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  // Every test the reports mention, recording or not. The gallery is supposed
  // to be the thing someone reads instead of the run log, and a page of
  // screenshots that never says which tests failed is not that.
  const outcomes = [];

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
            expected: t.expectedStatus,
            duration: r.duration,
            // First line only. Playwright errors carry a full stack and an
            // ANSI-coloured code frame; the first line is the assertion, which
            // is the part that says what actually went wrong.
            error: (r.error?.message ?? '')
              .replace(/\[[0-9;]*m/g, '')
              .split('\n')[0]
              .slice(0, 300),
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
    const claimed = new Set();
    const reportPath = path.join(resultsDir, 'results.json');
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const tests = [];
        for (const s of report.suites ?? []) eachTest(s, [], tests);
        for (const t of tests) {
          outcomes.push({
            variant,
            scenario,
            title: t.title,
            status: t.status,
            expected: t.expected,
            error: t.error,
          });
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

    if (!byTail.size) continue;

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
  return { videos, outcomes };
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
let sourceBytes = 0;
const { videos: rawVideos, outcomes } = collectVideos(inputRoot);
if (rawVideos.length) fs.mkdirSync(path.join(outDir, 'video'), { recursive: true });

// Playwright records at a fixed 25fps, which is far more than a UI walkthrough
// needs. Dropping to 8fps and letting VP8 pick its own bitrate takes a typical
// recording down by an order of magnitude, and the whole point of the artifact
// is that someone will actually download it. Measured on real recordings:
// 3.3 MB -> ~460 KB, with the product's body text still readable.
//
// If ffmpeg is not on PATH the recordings are copied through untouched: a
// bigger artifact is a far better outcome than a gallery with no recordings.
const haveFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (rawVideos.length && !haveFfmpeg) {
  console.warn('ffmpeg not found - shipping recordings at full frame rate, which makes a much larger artifact');
}

const shrink = (src, dest) =>
  new Promise((resolve) => {
    execFile(
      'ffmpeg',
      // Three things, in order:
      //
      // scale - cap the width at 854 without ever upscaling, so a recording
      //   made at a larger size costs neither the encode time nor the bytes of
      //   its full resolution. -2 keeps the aspect ratio and an even height.
      // fps - Playwright records at a fixed 25fps, far more than a walkthrough
      //   needs. This has to come BEFORE mpdecimate, not instead of it:
      //   mpdecimate keeps every distinct frame at whatever rate it is fed, so
      //   on a busy recording it alone produced a bigger file than a plain
      //   frame-rate cap. Capping first bounds the rate, decimating then
      //   removes the idle, and the two together beat either one.
      // mpdecimate - drop frames that are near-identical to the one before.
      //   Most of a test's wall time is spent waiting on a screen that is not
      //   changing, and that idle is the bulk of the file: on a real 77s
      //   recording only ~9s contained any visible change. Thresholds are set
      //   sensitive on purpose, so a spinner or a single row appearing is kept;
      //   a laxer setting saved barely any more bytes.
      // setpts - restamp the surviving frames evenly, otherwise they keep their
      //   original timestamps and the gaps play back as a frozen picture,
      //   which would defeat the whole exercise.
      ['-v', 'error', '-y', '-i', src,
       '-vf', "scale='min(854,iw)':-2,fps=8,mpdecimate=hi=64*8:lo=64*3:frac=0.002,setpts=N/8/TB",
       '-r', '8', '-c:v', 'libvpx',
       '-deadline', 'realtime', '-cpu-used', '8', '-crf', '45', '-b:v', '0', '-an', dest],
      (err) => {
        // A recording that will not re-encode still belongs in the review.
        if (err || !fs.existsSync(dest) || fs.statSync(dest).size === 0) fs.copyFileSync(src, dest);
        resolve();
      },
    );
  });

const prepared = rawVideos.map((v) => {
  const slug = v.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const rel = path.join('video', `${v.variant}__${v.scenario}__${slug || 'session'}.webm`);
  return { ...v, rel };
});

// A small pool: the runners have few cores and ffmpeg already threads.
const queue = [...prepared];
await Promise.all(
  Array.from({ length: Math.min(4, os.cpus().length || 1) }, async () => {
    for (let v = queue.shift(); v; v = queue.shift()) {
      const dest = path.join(outDir, v.rel);
      if (haveFfmpeg) await shrink(v.file, dest);
      else fs.copyFileSync(v.file, dest);
    }
  }),
);

for (const v of prepared) {
  sourceBytes += fs.statSync(v.file).size;
  videoBytes += fs.statSync(path.join(outDir, v.rel)).size;
  const list = videosByScenario.get(v.scenario) ?? [];
  list.push(v);
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

// A scenario with recordings but no screenshots still gets a section: `mcp`
// tests an API surface and takes no pictures, and dropping it here would ship
// its recordings inside the artifact with nothing in the page pointing at them.
const scenarios = [...new Set([...byScenario.keys(), ...videosByScenario.keys()])].sort();
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

// Outcomes grouped by scenario, so each section can say what happened rather
// than leaving a reviewer to infer it from which screenshots exist.
const outcomesByScenario = new Map();
for (const o of outcomes) {
  const list = outcomesByScenario.get(o.scenario) ?? [];
  list.push(o);
  outcomesByScenario.set(o.scenario, list);
}

/** A test counts as failed when its result is not what the spec expected. */
const isFailure = (o) => o.status !== (o.expected ?? 'passed') && o.status !== 'skipped';

/** Every scenario with at least one unexpected result, for the run-wide summary. */
const failingScenarios = [...outcomesByScenario.entries()]
  .filter(([, list]) => list.some(isFailure))
  .map(([scenario, list]) => ({
    scenario,
    variants: [...new Set(list.filter(isFailure).map((o) => o.variant))].sort(),
  }));

/**
 * What happened in one scenario, per variant, naming the failures.
 *
 * A test whose spec pinned it with test.fail() and which then passed shows up
 * here too: Playwright calls that a failure, and it is the signal that a known
 * defect got fixed and the pin is now stale.
 */
function outcomeBanner(scenario) {
  const list = outcomesByScenario.get(scenario);
  if (!list?.length) return '';
  const rows = ['main', 'published']
    .map((variant) => {
      const mine = list.filter((o) => o.variant === variant);
      if (!mine.length) return '';
      const bad = mine.filter(isFailure);
      const label = variant === 'main' ? 'built from main' : 'published release';
      if (!bad.length) return `<div><strong>${label}:</strong> ${mine.length} passed</div>`;
      return (
        `<div><strong>${label}:</strong> ${mine.length - bad.length} passed, ${bad.length} failed` +
        bad
          .map(
            (o) =>
              `<div class="failrow"><span class="failtitle">${esc(o.title)}</span>` +
              (o.expected === 'failed' && o.status === 'passed'
                ? `<span class="failwhy">passed while pinned as a known defect - the pin is stale and should be removed</span>`
                : o.error
                  ? `<span class="failwhy">${esc(o.error)}</span>`
                  : `<span class="failwhy">${esc(o.status)}</span>`) +
              `</div>`,
          )
          .join('') +
        `</div>`
      );
    })
    .filter(Boolean)
    .join('');
  const anyBad = list.some(isFailure);
  return `    <div class="${anyBad ? 'outcome bad' : 'outcome'}">${rows}</div>\n`;
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
    // Recordings are kept only for failures, so an empty side normally means
    // this variant passed - which is information, not a gap.
    if (!v) return `<div class="pane"><div class="label"><span>${label}</span></div><div class="missing">no recording - this variant did not fail</div></div>`;
    const secs = v.duration ? ` &middot; ${(v.duration / 1000).toFixed(1)}s` : '';
    const status = v.status && v.status !== 'passed' ? ` <strong>${esc(v.status)}</strong>` : '';
    return `<div class="pane">
            <div class="label"><span>${label}${secs}${status}</span><a href="${v.rel}" download>download</a></div>
            <video controls preload="metadata" src="${v.rel}"></video>
          </div>`;
  };
  return `    <div class="surface">
      <h3>Session recordings <code style="color:var(--muted)">${byTitle.size} test${byTitle.size === 1 ? '' : 's'}</code></h3>
      <p class="hint" style="padding: 0 14px">
        Recordings are kept only for tests that failed. Stretches where the screen was not changing
        have been removed, so a recording plays back much shorter than the test took - the time shown
        is the real duration of the test, not of the video.
      </p>
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
  .outcome { border: 1px solid var(--line); border-left: 3px solid #3a9; border-radius: 8px;
             padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .outcome.bad { border-left-color: #d9534f; background: color-mix(in srgb, Canvas 95%, #d9534f); }
  .outcome > div + div { margin-top: 6px; }
  .failrow { display: flex; gap: 10px; align-items: baseline; margin: 5px 0 0 14px; flex-wrap: wrap; }
  .failtitle { font-weight: 600; }
  .failwhy { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
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
${
  failingScenarios.length
    ? `  <div class="outcome bad" style="margin-bottom:20px">
    <strong>${failingScenarios.length} scenario${failingScenarios.length === 1 ? '' : 's'} did not come out clean.</strong>
    Each is listed under its own heading below with the failing test and the reason.
    A scenario failing on <em>published only</em> is normally a feature that exists in main and has not shipped yet.
${failingScenarios
  .map(
    (f) =>
      `    <div class="failrow"><span class="failtitle"><a href="#${esc(f.scenario)}">${esc(f.scenario)}</a></span>` +
      `<span class="failwhy">${f.variants.join(' and ')}</span></div>`,
  )
  .join('\n')}
  </div>`
    : '  <div class="outcome">Every test passed on both variants.</div>'
}
${scenarios
  .map((scenario) => {
    const surfaces = [...(byScenario.get(scenario)?.entries() ?? [])].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const errs = consoleErrors[scenario];
    const recs = videosByScenario.get(scenario)?.length ?? 0;
    const counts = [
      surfaces.length ? `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}` : '',
      recs ? `${recs} recording${recs === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return `  <section id="${esc(scenario)}">
    <h2>${esc(title(scenario))}</h2>
    <p class="hint">${counts.join(' &middot; ') || 'nothing captured'}${surfaces.length ? '' : ' - this scenario takes no screenshots'}</p>
${outcomeBanner(scenario)}${errs ? `    <div class="warn"><strong>Console errors during this scenario:</strong><br><code>${errs.slice(0, 6).map(esc).join('<br>')}</code></div>\n` : ''}${surfaces
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
if (rawVideos.length) {
  console.log(
    `recordings: ${rawVideos.length}, ${mb(sourceBytes)} -> ${mb(videoBytes)}` +
      (haveFfmpeg ? ' (854px wide, 8fps)' : ' (not re-encoded: no ffmpeg)'),
  );
}
