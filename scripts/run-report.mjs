#!/usr/bin/env node
// Summarise a CI run without opening a browser.
//
// Triaging a failure used to mean: list the jobs, guess which artifact holds
// the evidence, download it, find results.json, and read it by hand - several
// minutes per iteration, every iteration. This does it in one command and
// prints what actually matters: which tests failed, the first line of each
// failure, and every annotation the specs recorded (issue severities,
// alert-rule flags, notification timings), which is usually where the answer
// is. Then the harness's own diagnostics - pods, hub and agent logs, and the
// hub's API state at teardown.
//
//   node scripts/run-report.mjs                 # newest run
//   node scripts/run-report.mjs 31693842876     # a specific run
//   node scripts/run-report.mjs 31693842876 -v  # include passing tests
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'skyhook-dev/radar-e2e';
const [, , runArg, ...flags] = process.argv;
const verbose = flags.includes('-v');

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const runId =
  runArg ??
  JSON.parse(gh('run', 'list', '--repo', REPO, '--workflow=e2e.yml', '--limit', '1', '--json', 'databaseId'))[0]
    .databaseId;

const run = JSON.parse(
  gh('run', 'view', String(runId), '--repo', REPO, '--json', 'status,conclusion,jobs,createdAt'),
);

const jobs = run.jobs.filter((j) => j.name.includes('('));
const failedJobs = jobs.filter((j) => j.conclusion === 'failure');
console.log(`run ${runId}  ${run.status}/${run.conclusion || '-'}  ${run.createdAt}`);
console.log(`${jobs.filter((j) => j.conclusion === 'success').length}/${jobs.length} scenario jobs green`);
if (!failedJobs.length && !verbose) {
  console.log('nothing failed.');
  process.exit(0);
}

// Only the artifacts worth pulling: a failed job's, or everything with -v.
const wanted = (verbose ? jobs : failedJobs)
  .map((j) => {
    const m = j.name.match(/^e2e-(main|published) \((\S+),/);
    return m ? `playwright-${m[1]}-${m[2]}` : null;
  })
  .filter(Boolean);

const dir = mkdtempSync(path.join(tmpdir(), 'run-report-'));
try {
  for (const artifact of [...new Set(wanted)]) {
    try {
      gh('run', 'download', String(runId), '--repo', REPO, '-n', artifact, '-D', path.join(dir, artifact));
    } catch {
      console.log(`  (no artifact ${artifact})`);
      continue;
    }
    const results = path.join(dir, artifact, 'test-results', 'results.json');
    if (!existsSync(results)) continue;

    console.log(`\n=== ${artifact} ===`);
    const report = JSON.parse(readFileSync(results, 'utf8'));
    const walk = (suite) => {
      for (const child of suite.suites ?? []) walk(child);
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          for (const r of t.results ?? []) {
            const failed = r.status !== 'passed' && r.status !== 'skipped';
            if (failed || verbose) {
              const secs = Math.round((r.duration ?? 0) / 1000);
              console.log(`  ${failed ? 'FAIL' : r.status.padEnd(4)} ${secs}s  ${spec.title.slice(0, 70)}`);
            }
            for (const e of failed ? (r.errors ?? []).slice(0, 2) : []) {
              const first = (e.message ?? '').replace(/\[[0-9;]*m/g, '').split('\n')[0];
              console.log(`        ${first.slice(0, 200)}`);
            }
            for (const a of r.annotations ?? []) {
              console.log(`        note[${a.type}] ${a.description}`);
            }
          }
        }
      }
    };
    for (const suite of report.suites ?? []) walk(suite);

    const diag = path.join(dir, artifact, 'diagnostics.txt');
    if (existsSync(diag)) {
      const interesting = readFileSync(diag, 'utf8')
        .split('\n')
        .filter((l) => /CrashLoop|error|panic|OOM|GET \/api|^--- /i.test(l))
        .slice(0, 40);
      if (interesting.length) {
        console.log('  diagnostics:');
        for (const line of interesting) console.log(`        ${line.slice(0, 180)}`);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
