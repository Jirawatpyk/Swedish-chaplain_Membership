/**
 * `.github/workflows/ci-e2e-parent-refresh.yml` guard (spec 123 slice 2).
 *
 * The job migrates the CI Neon project's parent branch so each PR's
 * `ci-e2e/*` branch applies only its own migrations. It holds the CI Neon key
 * and runs DDL, so the guard pins: push-to-main + manual dispatch only (never
 * a pull_request trigger), the CI-only key (never the project-wide
 * `NEON_API_KEY`), a refusal unless the resolved branch and project are
 * exactly `vars.NEON_CI_PARENT_BRANCH` / `vars.NEON_CI_PROJECT_ID`, masking
 * before the URL leaves the step, no event/input value expanded in `run:`,
 * and a concurrency group that queues instead of cancelling a migration
 * half-way. Read as TEXT with the shared parser; it has its own positive
 * control.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INJECTABLE, codeLines, lines, runBlocks, stepCount, stepRange } from './workflow-yaml-text';

const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'ci-e2e-parent-refresh.yml');

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

/** The top-level `on:` block's direct children, e.g. ['push', 'workflow_dispatch']. */
function triggers(code: string): string[] {
  const block = code.slice(code.search(/^on:/m)).split(/\n(?=\S)/)[0] ?? '';
  return (block.match(/^\s{2}(\w+):/gm) ?? []).map((t) => t.trim().replace(':', ''));
}

describe('parent-refresh guard parser (positive control)', () => {
  const fixture = [
    'on:',
    '  push:',
    '  pull_request:',
    'jobs:',
    '  refresh:',
    '    steps:',
    '      - name: unsafe',
    '        run: echo "${{ inputs.branch }}"',
  ].join('\r\n');

  it('reads the triggers and flags the injectable run line, CRLF or not', () => {
    expect(triggers(codeLines(fixture).join('\n'))).toEqual(['push', 'pull_request']);
    expect(runBlocks(fixture).filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([8]);
  });
});

describe('.github/workflows/ci-e2e-parent-refresh.yml', () => {
  const src = read(WORKFLOW);
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);

  it('the parse finds steps and run blocks (an empty parse checks nothing)', () => {
    expect(stepCount(src)).toBeGreaterThan(4);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('triggers on push to main and workflow_dispatch only — never a pull_request event', () => {
    expect(triggers(code)).toEqual(['push', 'workflow_dispatch']);
    expect(code).toMatch(/^\s{2}push:\s*\n\s{4}branches:\s*\[main\]\s*$/m);
    expect(code).not.toMatch(/pull_request/);
    expect(code).not.toContain('workflow_run');
  });

  it('queues runs in one concurrency group and never cancels one in progress', () => {
    expect(code).toMatch(/^concurrency:\s*\n\s{2}group:\s*\S+/m);
    expect(code).toMatch(/^\s{2}cancel-in-progress:\s*false\s*$/m);
    expect(code).not.toMatch(/cancel-in-progress:\s*true/);
  });

  it('uses only the CI project key — never the project-wide NEON_API_KEY or any other secret', () => {
    expect(code).not.toMatch(/secrets\.NEON_API_KEY\b/);
    const secrets = new Set(code.match(/secrets\.[A-Z0-9_]+/g) ?? []);
    expect([...secrets]).toEqual(['secrets.NEON_CI_API_KEY']);
  });

  it('expands no event payload or dispatch input inside any run block', () => {
    expect(blocks.filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([]);
  });

  it('grants no token write permission', () => {
    expect(code).toMatch(/^permissions: \{\}\s*$/m);
    expect(code).not.toMatch(/:\s*write\b/);
  });

  it('refuses unless the resolved branch and project are exactly the CI parent and CI project', () => {
    const resolve = step(src, /- name: Resolve the CI parent branch/);
    expect(resolve).toMatch(/PARENT_BRANCH_ID: \$\{\{ vars\.NEON_CI_PARENT_BRANCH \}\}/);
    expect(resolve).toMatch(/PROJECT_ID: \$\{\{ vars\.NEON_CI_PROJECT_ID \}\}/);
    expect(resolve).toMatch(/NEON_API_KEY: \$\{\{ secrets\.NEON_CI_API_KEY \}\}/);
    expect(resolve).toMatch(/\[ "\$got_branch" != "\$PARENT_BRANCH_ID" \]/);
    expect(resolve).toMatch(/\[ "\$got_project" != "\$PROJECT_ID" \]/);
    expect(resolve).toMatch(/exit 1/);
  });

  it('masks the connection string before it leaves the resolve step', () => {
    const resolve = step(src, /- name: Resolve the CI parent branch/);
    const body = resolve.split('\n');
    const mask = body.findIndex((l) => /::add-mask::\$DB_URL\b/.test(l));
    const out = body.findIndex((l) => /GITHUB_OUTPUT/.test(l) && /db_url/.test(l));
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(out).toBeGreaterThan(mask);
    expect(resolve).not.toMatch(/echo "\$DB_URL"|set -x/);
  });

  it('migrates through the shared ci-neon-env action, after the guard, with the prod blocklist', () => {
    const migrate = step(src, /- name: Migrate the CI parent branch/);
    expect(migrate).toMatch(/uses: \.\/\.github\/actions\/ci-neon-env/);
    expect(migrate).toMatch(/database-url: \$\{\{ steps\.parent\.outputs\.db_url \}\}/);
    expect(migrate).toMatch(/blocklist: \$\{\{ vars\.TEST_DB_HOST_BLOCKLIST \}\}/);
    expect(migrate).toMatch(/migrate: 'true'/);
    expect(lineOf(src, /uses: \.\/\.github\/actions\/ci-neon-env/)).toBeGreaterThan(
      lineOf(src, /- name: Resolve the CI parent branch/),
    );
  });
});
