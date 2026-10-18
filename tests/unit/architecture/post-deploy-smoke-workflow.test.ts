/**
 * `.github/workflows/post-deploy-smoke.yml` guard (spec 123 US1, DW-1 + DW-4).
 *
 * Read as TEXT — no YAML dependency (Constitution X). Lines are split on
 * `\r?\n` so the gate is not inert on a Windows CRLF checkout.
 *
 * Asserts the trigger (a successful PRODUCTION deployment, or a manual run),
 * the job's least privilege, and the script-injection rule: no `${{ }}` value
 * from `github.event.*` or `inputs.*` is ever expanded inside a `run:` block —
 * it reaches the shell only through `env:`. The parser carries its own
 * positive control (a fixture it must flag) and fails if it finds zero steps
 * or zero run blocks in the real file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INJECTABLE, codeLines, runBlocks, stepCount, stepRange as findStep } from './workflow-yaml-text';

const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'post-deploy-smoke.yml');

describe('post-deploy-smoke workflow parser (positive control)', () => {
  const fixture = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: safe',
    '        env:',
    '          URL: ${{ github.event.deployment_status.environment_url }}',
    '        run: echo "$URL"',
    '      - name: unsafe block',
    '        run: |',
    '          echo start',
    '          echo "${{ inputs.base_url }}"',
    '      - name: unsafe line',
    '        run: echo ${{ github.event.deployment.ref }}',
  ].join('\r\n');

  it('finds both block and single-line run values, CRLF or not', () => {
    expect(runBlocks(fixture)).toHaveLength(3);
    expect(stepCount(fixture)).toBe(3);
  });

  it('flags an event/input expansion inside run, and not one inside env', () => {
    const flagged = runBlocks(fixture).filter((b) => INJECTABLE.test(b.text));
    expect(flagged.map((b) => b.line)).toEqual([9, 13]);
  });
});

describe('.github/workflows/post-deploy-smoke.yml', () => {
  const src = readFileSync(WORKFLOW_PATH, 'utf8');
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);

  it('the parse finds steps and run blocks (an empty parse checks nothing)', () => {
    expect(stepCount(src)).toBeGreaterThan(0);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('triggers on deployment_status and on workflow_dispatch with an optional base_url', () => {
    expect(code).toMatch(/^on:\s*$/m);
    expect(code).toMatch(/^\s{2}deployment_status:\s*$/m);
    expect(code).toMatch(/^\s{2}workflow_dispatch:\s*$/m);
    expect(code).toMatch(/^\s+base_url:\s*$/m);
    expect(code).toMatch(/^\s+required:\s*false\s*$/m);
  });

  it('runs the job only for a manual run or a successful Production deployment', () => {
    const ifs = codeLines(src).filter((l) => /^\s{4}if:/.test(l));
    expect(ifs).toHaveLength(1);
    const cond = ifs[0]!;
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("github.event.deployment_status.state == 'success'");
    expect(cond).toContain("github.event.deployment.environment == 'Production'");
    // The two deployment filters are AND-ed together, OR-ed with the manual run.
    expect(cond).toMatch(
      /workflow_dispatch'\s*\|\|\s*\(\s*github\.event\.deployment_status\.state == 'success'\s*&&\s*github\.event\.deployment\.environment == 'Production'\s*\)/,
    );
  });

  it('is never triggered by pull_request_target', () => {
    expect(code).not.toContain('pull_request_target');
  });

  it('grants the job contents: read and issues: write, and nothing at the top level', () => {
    expect(code).toMatch(/^permissions:\s*\{\}\s*$/m);
    expect(code).toMatch(/^\s{6}contents:\s*read\s*$/m);
    expect(code).toMatch(/^\s{6}issues:\s*write\s*$/m);
    expect(code).not.toMatch(/:\s*write-all/);
  });

  /** [first, end) line range of the step whose `- name:` line matches. */
  function stepRange(name: RegExp): { start: number; end: number } {
    const r = findStep(src, name);
    expect(r, String(name)).not.toBeNull();
    expect(r!.start, String(name)).toBeGreaterThan(0);
    return r!;
  }

  const FAIL_STEP = /^\s+- name: Open or update the prod-smoke issue\s*$/;
  const RECOVER_STEP = /^\s+- name: Close the prod-smoke issue as recovered\s*$/;

  it('hands the token only to the two issue steps, and checkout keeps no credentials', () => {
    const lines = src.split(/\r?\n/);
    const ranges = [stepRange(FAIL_STEP), stepRange(RECOVER_STEP)];
    for (const key of ['GH_TOKEN', 'GH_REPO']) {
      const at = lines.flatMap((l, i) => (new RegExp(`^\\s+${key}:`).test(l) ? [i] : []));
      expect(at, key).toHaveLength(2);
      for (const r of ranges) {
        const envAt = lines.findIndex((l, i) => i > r.start && i < r.end && /^\s+env:\s*$/.test(l));
        expect(envAt, key).toBeGreaterThan(r.start);
        expect(at.some((i) => i > envAt && i < r.end), key).toBe(true);
      }
    }
    expect(code).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials:\s*false/);
  });

  it('uses no secret except the automatic GITHUB_TOKEN', () => {
    const secrets = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets.filter((s) => s !== 'GITHUB_TOKEN')).toEqual([]);
  });

  it('never expands github.event.* or inputs.* inside a run block', () => {
    const offending = blocks.filter((b) => INJECTABLE.test(b.text)).map((b) => `line ${b.line}`);
    expect(offending).toEqual([]);
  });

  it('expands no ${{ }} expression of any kind inside a run block', () => {
    const offending = blocks.filter((b) => b.text.includes('${{')).map((b) => `line ${b.line}`);
    expect(offending).toEqual([]);
  });

  it('keys concurrency so only successful Production events share the queued slot', () => {
    expect(code).toMatch(
      /^\s{2}group: post-deploy-smoke-\$\{\{ github\.event_name == 'workflow_dispatch' && 'manual' \|\| \(github\.event\.deployment_status\.state == 'success' && github\.event\.deployment\.environment == 'Production'\) && 'production' \|\| github\.run_id \}\}\s*$/m,
    );
    expect(code).toMatch(/^\s{2}cancel-in-progress:\s*false\s*$/m);
  });

  it('resolves the base URL from the input, else the PROD_BASE_URL variable, and fails when empty', () => {
    expect(code).toMatch(/BASE_URL:\s*\$\{\{\s*inputs\.base_url\s*\|\|\s*vars\.PROD_BASE_URL\s*\}\}/);
    const guard = blocks.find((b) => /-z\s+"\$BASE_URL"/.test(b.text));
    expect(guard).toBeDefined();
    expect(guard!.text).toMatch(/exit 1/);
  });

  it('runs the smoke script with plain node, keeps its exit code through tee, and saves its output', () => {
    const smoke = blocks.find((b) => b.text.includes('scripts/post-deploy-smoke.ts'));
    expect(smoke).toBeDefined();
    expect(smoke!.text).toMatch(/(^|\s)node --experimental-strip-types scripts\/post-deploy-smoke\.ts "\$BASE_URL"/);
    expect(smoke!.text).not.toContain('tsx');
    expect(smoke!.text).toContain('set -o pipefail');
    expect(smoke!.text).toMatch(/\|\s*tee\s+\S+/);
  });

  it('sets up node 22 only: no pnpm, no dependency install, no cache', () => {
    expect(code).toContain('uses: actions/checkout@v4');
    expect(code).toContain('uses: actions/setup-node@v4');
    expect(code).toMatch(/node-version:\s*'22'/);
    expect(code).not.toContain('pnpm');
    expect(code).not.toMatch(/^\s+cache:/m);
  });

  it('on failure opens or comments on a prod-smoke issue with --body-file only', () => {
    const issue = blocks.find((b) => b.text.includes('gh issue create'));
    expect(issue).toBeDefined();
    const t = issue!.text;
    expect(t).toMatch(/gh label create prod-smoke[^\n]*\|\|\s*true/);
    expect(t).toMatch(/gh issue list[^\n]*--label prod-smoke[^\n]*--state open/);
    expect(t).toMatch(/gh issue comment[^\n]*--body-file/);
    expect(t).toMatch(/gh issue create[^\n]*--label prod-smoke[^\n]*--body-file/);
    expect(t).not.toMatch(/--body\s+["']/);
    // Only the FAIL lines reach the issue — never a raw response.
    expect(t).toMatch(/grep\s+'\^FAIL '/);
    for (const field of ['BASE_URL', 'COMMIT_SHA', 'DEPLOYMENT_URL']) {
      expect(t).toMatch(new RegExp(`\\$\\{?${field}\\b`));
    }
    const lines = src.split(/\r?\n/);
    const r = stepRange(FAIL_STEP);
    expect(lines.slice(r.start, r.end).some((l) => /^\s+if:\s*failure\(\)\s*$/.test(l))).toBe(true);
  });

  it('on success comments "Recovered" on every open prod-smoke issue and closes it', () => {
    const lines = src.split(/\r?\n/);
    const r = stepRange(RECOVER_STEP);
    expect(lines.slice(r.start, r.end).some((l) => /^\s+if:\s*success\(\)\s*$/.test(l))).toBe(true);
    const block = blocks.find((b) => b.line - 1 > r.start && b.line - 1 < r.end);
    expect(block).toBeDefined();
    const t = block!.text;
    expect(t).toContain('Recovered: smoke passed at');
    expect(t).toMatch(/\$\{?COMMIT_SHA\b/);
    expect(t).toMatch(/\$\{?RUN_URL\b/);
    expect(t).toMatch(/gh issue list[^\n]*--label prod-smoke[^\n]*--state open/);
    expect(t).toMatch(/gh issue comment[^\n]*--body-file/);
    expect(t).toMatch(/gh issue close/);
    expect(t).not.toMatch(/--body\s+["']/);
    // A manual run against another URL must never close a production alarm.
    expect(t).toMatch(/"\$BASE_URL"\s*!=\s*"\$PROD_BASE_URL"/);
  });
});
