/**
 * `.github/workflows/e2e-nightly.yml` + `.github/workflows/ci-e2e-branch-sweep.yml`
 * guards (spec 123 slice 2, DW-11 and the `ci-e2e/*` sweep).
 *
 * Both hold the CI Neon key in a PUBLIC repo; the nightly also drops a schema
 * and writes issues; the sweep deletes branches. Read as TEXT with the shared
 * parser (no YAML dependency). Each file has a positive control: its parse must
 * find steps and run blocks, and the fixture below must be flagged.
 */
import { existsSync, readFileSync } from 'node:fs';
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
    expect(body).toMatch(/ci-e2e\/\*\)/);
    expect(body).toMatch(/CI_E2E_BRANCH_CREATED/);
    expect(body).toMatch(/exit 1/);
  });

  it('runs the full suite on chromium with one worker against next dev from the base config', () => {
    const run = step(src, /- name: e2e full suite on chromium/);
    expect(run).toMatch(/--project=chromium/);
    expect(run).toMatch(/--workers=1/);
    expect(run).not.toMatch(/--grep|playwright\.attach\.config/);
    expect(code).toMatch(/E2E_X_TENANT_HEADER_ENABLED: '1'/);
    expect(code).not.toMatch(/next start/);
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
});
