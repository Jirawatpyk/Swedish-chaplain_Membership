/**
 * `.github/workflows/e2e-nightly.yml` + `.github/workflows/ci-e2e-branch-sweep.yml`
 * guards (spec 123 slice 2, DW-11 and the `ci-e2e/*` sweep).
 *
 * Both hold the CI Neon key in a PUBLIC repo; the nightly also drops a schema
 * and writes issues; the sweep deletes branches. Read as TEXT with the shared
 * parser (no YAML dependency). Each file has a positive control: its parse must
 * find steps and run blocks, and the fixture below must be flagged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INJECTABLE, codeLines, lines, runBlocks, stepCount, stepRange } from './workflow-yaml-text';

const NIGHTLY = join(process.cwd(), '.github', 'workflows', 'e2e-nightly.yml');
const SWEEP = join(process.cwd(), '.github', 'workflows', 'ci-e2e-branch-sweep.yml');

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function step(src: string, name: RegExp): string {
  const r = stepRange(src, name);
  expect(r, String(name)).not.toBeNull();
  return lines(src).slice(r!.start, r!.end).join('\n');
}

function lineOf(src: string, re: RegExp): number {
  const at = lines(src).findIndex((l) => re.test(l));
  expect(at, String(re)).toBeGreaterThanOrEqual(0);
  return at;
}

function triggers(code: string): string[] {
  const block = code.slice(code.search(/^on:/m)).split(/\n(?=\S)/)[0] ?? '';
  return (block.match(/^\s{2}(\w+):/gm) ?? []).map((t) => t.trim().replace(':', ''));
}

/** Every `- name:` step whose text mentions `needle`, by name. */
function stepsMentioning(src: string, needle: RegExp): string[] {
  const all = lines(src);
  const names: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const m = /^\s*-\s+name:\s*(.+)$/.exec(all[i]!);
    if (m === null) continue;
    const r = stepRange(src, new RegExp(`^\\s*-\\s+name:\\s*${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`));
    if (r !== null && needle.test(all.slice(r.start, r.end).join('\n'))) names.push(m[1]!.trim());
  }
  return names;
}

describe('nightly / sweep guard parser (positive control)', () => {
  const fixture = [
    'on:',
    '  schedule:',
    '  pull_request_target:',
    'jobs:',
    '  x:',
    '    steps:',
    '      - name: Open the issue',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    '        run: echo "${{ github.event.issue.title }}"',
  ].join('\r\n');

  it('reads triggers, finds token-bearing steps and flags the injectable run line, CRLF or not', () => {
    expect(triggers(codeLines(fixture).join('\n'))).toEqual(['schedule', 'pull_request_target']);
    expect(stepsMentioning(fixture, /github\.token/)).toEqual(['Open the issue']);
    expect(runBlocks(fixture).filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([10]);
  });
});

describe('.github/workflows/e2e-nightly.yml', () => {
  const src = read(NIGHTLY);
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);

  it('the parse finds steps and run blocks (an empty parse checks nothing)', () => {
    expect(stepCount(src)).toBeGreaterThan(12);
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });

  it('triggers on schedule and workflow_dispatch only', () => {
    expect(triggers(code)).toEqual(['schedule', 'workflow_dispatch']);
    expect(code).toMatch(/^\s+- cron: '0 19 \* \* \*'\s*$/m);
    expect(code).not.toMatch(/pull_request/);
  });

  it('never cancels a run in progress', () => {
    expect(code).toMatch(/^\s{2}cancel-in-progress:\s*false\s*$/m);
    expect(code).not.toMatch(/cancel-in-progress:\s*true/);
  });

  it('uses only the CI key and the CI service secrets — never NEON_API_KEY', () => {
    expect(code).not.toMatch(/secrets\.NEON_API_KEY\b/);
    const secrets = [...new Set(code.match(/secrets\.[A-Z0-9_]+/g) ?? [])].sort();
    expect(secrets).toEqual(
      [
        'secrets.CI_BLOB_PRIVATE_READ_WRITE_TOKEN',
        'secrets.CI_BLOB_READ_WRITE_TOKEN',
        'secrets.CI_UPSTASH_REDIS_REST_TOKEN',
        'secrets.CI_UPSTASH_REDIS_REST_URL',
        'secrets.NEON_CI_API_KEY',
      ].sort(),
    );
  });

  it('expands no event payload or dispatch input inside any run block', () => {
    expect(blocks.filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([]);
  });

  it('hands the GitHub token only to the issue steps', () => {
    const holders = stepsMentioning(src, /github\.token/);
    expect(holders.length).toBeGreaterThanOrEqual(2);
    expect(holders.every((name) => /issue/i.test(name))).toBe(true);
  });

  it('cuts a ci-e2e/ branch from the CI parent and deletes it in an always() step', () => {
    expect(code).toMatch(/CI_E2E_BRANCH_NAME: ci-e2e\//);
    expect(step(src, /- name: Create this run's Neon branch/)).toMatch(
      /parent_branch: \$\{\{ vars\.NEON_CI_PARENT_BRANCH \}\}/,
    );
    const del = step(src, /- name: Delete this run's Neon branch/);
    expect(del).toMatch(/if: always\(\) && steps\.branch\.outputs\.created == 'true'/);
  });

  it('pins the Neon actions by commit SHA (they receive the key)', () => {
    expect(step(src, /- name: Create this run's Neon branch/)).toContain(
      'uses: neondatabase/create-branch-action@fb620d43d4c565abaf088b848a4e28e5c4ea4d9c # v6',
    );
    expect(step(src, /- name: Delete this run's Neon branch/)).toContain(
      'uses: neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776 # v3',
    );
  });

  it('runs every refusal of the reset step before the psql line, and refuses an empty expected host', () => {
    const body = step(src, /- name: Reset the schema/).split('\n');
    const psql = body.findIndex((l) => /psql /.test(l));
    const exits = body.map((l, i) => (/exit 1/.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(psql).toBeGreaterThan(0);
    expect(exits.length).toBeGreaterThanOrEqual(4);
    expect(exits.every((i) => i < psql)).toBe(true);
    expect(body.join('\n')).toMatch(/\[ -n "\$CI_E2E_EXPECTED_DIRECT_HOST" \]/);
  });

  it('fails on flaky tests and lists flaky specs in the issue; no `|| true` hides a parse failure (M1)', () => {
    expect(step(src, /- name: e2e full suite on chromium/)).toMatch(/--fail-on-flaky-tests/);
    const list = step(src, /- name: List the failed specs/);
    expect(list).toMatch(/"flaky"/);
    expect(list).not.toMatch(/\|\| true/);
    expect(step(src, /- name: Open or update the e2e-nightly issue/)).toMatch(/[Ff]laky/);
  });

  it('uploads the report on failure or cancellation', () => {
    expect(step(src, /- name: Upload the Playwright report/)).toMatch(/^\s+if: failure\(\) \|\| cancelled\(\)\s*$/m);
  });

  it('gives each shard its own Upstash rate-limit prefix (M2)', () => {
    expect(code).toMatch(/RATE_LIMIT_KEY_PREFIX: swecham-nightly-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-s\$\{\{ matrix\.shard \}\}/);
  });

  it('grants the report job only issues: write', () => {
    const report = code.slice(code.indexOf('\n  report:'));
    const perms = /\n {4}permissions:\n((?: {6}\S.*\n)+)/.exec(report)?.[1]?.trim().split('\n').map((l) => l.trim());
    expect(perms).toEqual(['issues: write']);
  });

  it('resets the schema only after the DW-9 guard, re-checks the target, then migrates from zero', () => {
    const guard = lineOf(src, /- name: Refuse any target but this run's ci-e2e branch \(DW-9\)/);
    const reset = lineOf(src, /- name: Reset the schema/);
    const migrate = lineOf(src, /- name: Migrate the branch from zero/);
    expect(guard).toBeLessThan(reset);
    expect(reset).toBeLessThan(migrate);
    const body = step(src, /- name: Reset the schema/);
    expect(body).toMatch(/DROP SCHEMA public CASCADE;/);
    expect(body).toMatch(/DROP SCHEMA IF EXISTS drizzle CASCADE;/);
    expect(body).toMatch(/CREATE SCHEMA public;/);
    // A recreated `public` lacks the USAGE grant PostgreSQL gives PUBLIC on a
    // new database, and no migration grants it, so `chamber_app` (the role
    // runInTenant switches to) could not read any table: the first nightly
    // (run 39180255712) failed in the plans seed. Restore the default.
    expect(body).toMatch(/CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;/);
    expect(body).toMatch(/ci-e2e\/\*\)/);
    expect(body).toMatch(/CI_E2E_BRANCH_CREATED/);
    expect(body).toMatch(/exit 1/);
  });

  // #592: the first full nightly (39241857172) ran with F6 and F7 OFF (the PR
  // job's `.github/ci/e2e.env` keeps them off for @critical), so every events,
  // broadcasts and E-Blast approval spec failed on its first assertion. The
  // nightly layers its own flags over that file; the PR job never reads them.
  it('turns on F6, F7 and E-Blast member approval for the full suite only (#592)', () => {
    const overlay = read(join(process.cwd(), '.github', 'ci', 'e2e-nightly.env'));
    for (const flag of ['FEATURE_F6_EVENTCREATE', 'FEATURE_F7_BROADCASTS', 'FEATURE_EBLAST_MEMBER_APPROVAL']) {
      expect(overlay, flag).toMatch(new RegExp(`^${flag}=true\\s*$`, 'm'));
    }
    // Flags only: nothing secret-shaped in a file a public repo publishes.
    for (const line of overlay.split(/\r?\n/).filter((l) => /^[A-Z]/.test(l))) {
      expect(line, 'only FEATURE_* flags').toMatch(/^FEATURE_[A-Z0-9_]+=(true|false)\s*$/);
    }
    const apply = step(src, /- name: Apply the CI env/);
    const base = apply.indexOf('.github/ci/e2e.env');
    const layer = apply.indexOf('.github/ci/e2e-nightly.env');
    expect(base, 'applies the shared CI env').toBeGreaterThan(-1);
    // Later $GITHUB_ENV lines win, so the overlay must come after the base.
    expect(layer, 'applies the nightly overlay after it').toBeGreaterThan(base);
    const critical = read(join(process.cwd(), '.github', 'workflows', 'e2e-critical.yml'));
    expect(critical, 'the PR job keeps F6/F7 off').not.toMatch(/e2e-nightly\.env/);
  });

  it('runs the full suite on chromium with one worker against next dev from the base config', () => {
    const run = step(src, /- name: e2e full suite on chromium/);
    expect(run).toMatch(/--project=chromium/);
    expect(run).toMatch(/--workers=1/);
    expect(run).not.toMatch(/--grep|playwright\.attach\.config/);
    expect(code).toMatch(/E2E_X_TENANT_HEADER_ENABLED: '1'/);
    expect(code).not.toMatch(/next start/);
  });

  // The first full run (39182165888) took over 5 h on a shard and the 350-min
  // job limit cancelled shard 1 before it wrote any result: every red spent
  // two extra attempts. Four shards, one retry, and a step limit under the
  // job limit so the summary, upload and issue steps still run.
  it('runs four shards with one retry, and stops the suite before the job limit', () => {
    expect(code).toMatch(/^\s{8}shard: \[1, 2, 3, 4\]\s*$/m);
    const run = step(src, /- name: e2e full suite on chromium/);
    expect(run).toMatch(/--shard="\$SHARD\/4"/);
    expect(run).toMatch(/--retries=1(\s|$)/);
    const jobLimit = Number(/^\s{4}timeout-minutes: (\d+)\s*$/m.exec(code)?.[1]);
    const stepLimit = Number(/^\s{8}timeout-minutes: (\d+)\s*$/m.exec(run)?.[1]);
    expect(jobLimit, 'job timeout').toBeGreaterThan(0);
    expect(stepLimit, 'suite step timeout').toBeGreaterThan(0);
    // Room for the summary, the uploads and the branch delete after it.
    expect(jobLimit - stepLimit).toBeGreaterThanOrEqual(30);
  });

  it('uploads only the Playwright report, traces and failed-spec list — never an env file', () => {
    for (const name of stepsMentioning(src, /actions\/upload-artifact/)) {
      const body = step(src, new RegExp(`- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(body).not.toMatch(/\.env/);
    }
    expect(stepsMentioning(src, /actions\/upload-artifact/).length).toBeGreaterThanOrEqual(1);
  });

  it('writes the issue from a body file holding failed spec names only', () => {
    const open = step(src, /- name: Open or update the e2e-nightly issue/);
    expect(open).toMatch(/--body-file/);
    expect(open).toMatch(/--label e2e-nightly/);
    expect(step(src, /- name: Close the e2e-nightly issue/)).toMatch(/gh issue close/);
  });
});

describe('.github/workflows/ci-e2e-branch-sweep.yml', () => {
  const src = read(SWEEP);
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);
  const sweep = () => step(src, /- name: Sweep stale ci-e2e branches/);

  it('the parse finds steps and run blocks (an empty parse checks nothing)', () => {
    expect(stepCount(src)).toBeGreaterThanOrEqual(1);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers on schedule and workflow_dispatch only', () => {
    expect(triggers(code)).toEqual(['schedule', 'workflow_dispatch']);
    expect(code).not.toMatch(/pull_request/);
  });

  it('uses only the CI project key and the CI project — never NEON_API_KEY', () => {
    expect(code).not.toMatch(/secrets\.NEON_API_KEY\b/);
    expect([...new Set(code.match(/secrets\.[A-Z0-9_]+/g) ?? [])]).toEqual(['secrets.NEON_CI_API_KEY']);
    expect(code).toMatch(/\$\{\{ vars\.NEON_CI_PROJECT_ID \}\}/);
    expect(code).not.toMatch(/vars\.NEON_PROJECT_ID\b/);
  });

  it('expands no event payload or dispatch input inside any run block', () => {
    expect(blocks.filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([]);
  });

  it('only considers ci-e2e/ branches whose parent is the CI parent, older than 24 h', () => {
    const body = sweep();
    expect(body).toMatch(/startswith\("ci-e2e\/"\)/);
    expect(body).toMatch(/\.parent_id == \$parent/);
    expect(body).toMatch(/PARENT_BRANCH_ID: \$\{\{ vars\.NEON_CI_PARENT_BRANCH \}\}/);
    expect(body).toMatch(/24 \* 3600/);
  });

  it('keeps a denylist and the parent itself out, whatever the filter says', () => {
    const body = sweep();
    expect(body).toMatch(/main\|dev\|ci\|\*backup\*/);
    expect(body).toMatch(/"\$id" = "\$PARENT_BRANCH_ID"/);
  });

  it('is a dry run unless the repo variable arms it (and a manual run asks for it)', () => {
    const body = sweep();
    expect(body).toMatch(/SWEEP_ENABLED: \$\{\{ vars\.CI_E2E_SWEEP_ENABLED \}\}/);
    expect(body).toMatch(/\[ "\$SWEEP_ENABLED" = "true" \]/);
    expect(body).toMatch(/DRY_RUN=true/);
  });

  it('decides arming exactly as documented (the bash block, executed)', () => {
    const body = sweep();
    const start = body.indexOf('# arming:start');
    const end = body.indexOf('# arming:end');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = body
      .slice(start, end)
      .split('\n')
      .map((l) => l.replace(/^ {10}/, ''))
      .join('\n');
    const decide = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', `${block}\necho "$DRY_RUN"`], {
        // Only the three inputs and PATH: nothing from this machine's env leaks in.
        env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      }).stdout.trim();
    expect(decide({ SWEEP_ENABLED: '', EVENT_NAME: 'schedule', INPUT_DRY_RUN: '' })).toBe('true');
    expect(decide({ SWEEP_ENABLED: 'false', EVENT_NAME: 'schedule', INPUT_DRY_RUN: '' })).toBe('true');
    expect(decide({ SWEEP_ENABLED: 'true', EVENT_NAME: 'schedule', INPUT_DRY_RUN: '' })).toBe('false');
    expect(decide({ SWEEP_ENABLED: 'true', EVENT_NAME: 'workflow_dispatch', INPUT_DRY_RUN: 'true' })).toBe('true');
    expect(decide({ SWEEP_ENABLED: 'true', EVENT_NAME: 'workflow_dispatch', INPUT_DRY_RUN: 'false' })).toBe('false');
    expect(decide({ SWEEP_ENABLED: '', EVENT_NAME: 'workflow_dispatch', INPUT_DRY_RUN: 'false' })).toBe('true');
  });

  it('warns with the would-delete list while it is a dry run', () => {
    expect(sweep()).toMatch(/::warning title=ci-e2e sweep \(dry run\)/);
  });
});

describe('ci-e2e-branch-sweep.yml — review round 2 (PR #586)', () => {
  const src = read(SWEEP);
  const sweep = () => step(src, /- name: Sweep stale ci-e2e branches/);

  it('bounds every Neon call with --max-time', () => {
    const curls = sweep().split('\n').filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBeGreaterThanOrEqual(2);
    expect(curls.every((l) => /--max-time \d+/.test(l))).toBe(true);
  });

  it('keeps going after a failed DELETE, reports each failure, and fails the step at the end (executed)', () => {
    const body = sweep();
    const start = body.indexOf('# delete-loop:start');
    const end = body.indexOf('# delete-loop:end');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const loop = body
      .slice(start, end)
      .split('\n')
      .map((l) => l.replace(/^ {10}/, ''))
      .join('\n');
    const summary = join(mkdtempSync(join(tmpdir(), 'sweep-')), 'summary.md');
    // A fake curl: every DELETE of br-bad fails, every other call succeeds.
    const script = [
      'set -euo pipefail',
      'curl() { for a in "$@"; do case "$a" in *br-bad*) return 22 ;; esac; done; return 0; }',
      'DRY_RUN=false',
      'PARENT_BRANCH_ID=br-parent',
      'NEON_API_KEY=fake',
      'api=https://neon.invalid/api/v2/projects/p',
      `GITHUB_STEP_SUMMARY='${summary.replace(/\\/g, '/')}'`,
      "candidates=$'br-bad ci-e2e/1-1\\nbr-ok ci-e2e/2-1'",
      loop,
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(run.stdout).toMatch(/::warning title=ci-e2e sweep delete failed::ci-e2e\/1-1/);
    expect(readFileSync(summary, 'utf8')).toMatch(/deleted `ci-e2e\/2-1`/);
    // A failed delete must not be reported as deleted.
    expect(readFileSync(summary, 'utf8')).not.toMatch(/deleted `ci-e2e\/1-1`/);
    expect(run.status).toBe(1);
  });

  it('warns when Neon paginated the branch list instead of sweeping silently', () => {
    expect(sweep()).toMatch(/\.pagination\.next/);
    expect(sweep()).toMatch(/::warning title=ci-e2e sweep paginated/);
  });
});
