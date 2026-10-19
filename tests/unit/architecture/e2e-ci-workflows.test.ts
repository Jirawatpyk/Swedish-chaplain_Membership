/**
 * `.github/workflows/e2e-critical.yml` + `.github/ci/e2e.env` guard
 * (spec 123 US2, DW-6, DW-8, DW-9, DW-10).
 *
 * Read as TEXT with the shared parser (`workflow-yaml-text.ts`, no YAML
 * dependency). The repo is PUBLIC and this job holds a Neon API key, so the
 * guard pins: a `pull_request` trigger only (never `pull_request_target`), a
 * fork skip, the CI-only Neon project and key (never the project-wide
 * `NEON_API_KEY`), a `ci-e2e/` branch deleted in an `always()` step, no
 * event/input value expanded inside `run:`, and an artifact that holds only
 * the Playwright report and traces. It carries its own positive control.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRITICAL_SET } from './e2e-critical-set-list';
import { INJECTABLE, codeLines, lines, runBlocks, stepCount, stepRange } from './workflow-yaml-text';

const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'e2e-critical.yml');
const CI_ENV = join(process.cwd(), '.github', 'ci', 'e2e.env');

/** A missing file reads as empty, so every rule below fails on its own line. */
function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The text of the step whose `- name:` / `- uses:` line matches. */
function step(src: string, name: RegExp): string {
  const r = stepRange(src, name);
  expect(r, String(name)).not.toBeNull();
  return lines(src).slice(r!.start, r!.end).join('\n');
}

/** 0-based line of the first match, for ordering checks. */
function lineOf(src: string, re: RegExp): number {
  const at = lines(src).findIndex((l) => re.test(l));
  expect(at, String(re)).toBeGreaterThanOrEqual(0);
  return at;
}

describe('e2e workflow guard parser (positive control)', () => {
  const fixture = [
    'jobs:',
    '  e2e:',
    '    steps:',
    '      - name: Upload',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          path: |',
    '            playwright-report/',
    '            .env.local',
    '      - name: unsafe',
    '        run: echo "${{ github.event.pull_request.title }}"',
  ].join('\r\n');

  it('finds the step and flags the injectable run line, CRLF or not', () => {
    expect(stepCount(fixture)).toBe(2);
    expect(runBlocks(fixture).filter((b) => INJECTABLE.test(b.text)).map((b) => b.line)).toEqual([11]);
    expect(step(fixture, /- name: Upload/)).toMatch(/^\s+\.env\.local$/m);
  });
});

describe('.github/workflows/e2e-critical.yml', () => {
  const src = read(WORKFLOW);
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);

  it('the parse finds steps and run blocks (an empty parse checks nothing)', () => {
    expect(stepCount(src)).toBeGreaterThan(10);
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });

  it('triggers on pull_request only — never pull_request_target, push or workflow_run', () => {
    expect(code).toMatch(/^on:\s*\n\s{2}pull_request:\s*$/m);
    const triggers = code.slice(code.search(/^on:/m)).split(/\n(?=\S)/)[0]!;
    expect(triggers.match(/^\s{2}\w+:/gm)).toEqual(['  pull_request:']);
    expect(code).not.toContain('pull_request_target');
    expect(code).not.toContain('workflow_run');
  });

  it('runs the e2e job only for a PR from this repository, and tells a fork why it skipped', () => {
    expect(code).toMatch(/^\s{4}if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository\s*$/m);
    expect(code).toMatch(/^\s{4}if: github\.event\.pull_request\.head\.repo\.full_name != github\.repository\s*$/m);
    const notice = blocks.find((b) => b.text.includes('::notice'));
    expect(notice?.text).toMatch(/fork/i);
  });

  it('cancels a superseded run of the same ref', () => {
    expect(code).toMatch(/^\s{2}group: e2e-critical-\$\{\{ github\.ref \}\}\s*$/m);
    expect(code).toMatch(/^\s{2}cancel-in-progress:\s*true\s*$/m);
  });

  it('grants nothing at the top level and only contents: read to the job', () => {
    expect(code).toMatch(/^permissions:\s*\{\}\s*$/m);
    expect(code).toMatch(/^\s{6}contents:\s*read\s*$/m);
    expect(code).not.toMatch(/:\s*write(-all)?\s*$/m);
    expect(code).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials:\s*false/);
  });

  it('never uses the project-wide NEON_API_KEY; the CI-project key reaches only the scope check, create and delete', () => {
    expect(code).not.toMatch(/secrets\.NEON_API_KEY\b/);
    expect(code).not.toMatch(/vars\.NEON_PROJECT_ID\b/);
    const uses = [...code.matchAll(/secrets\.NEON_CI_API_KEY\b/g)];
    expect(uses).toHaveLength(3);
    expect(step(src, /- name: Prove the CI key reaches only the CI project/)).toMatch(
      /NEON_API_KEY: \$\{\{ secrets\.NEON_CI_API_KEY \}\}/,
    );
    expect(step(src, /- name: Create this run's Neon branch/)).toMatch(/api_key: \$\{\{ secrets\.NEON_CI_API_KEY \}\}/);
    expect(step(src, /- name: Delete this run's Neon branch/)).toMatch(/api_key: \$\{\{ secrets\.NEON_CI_API_KEY \}\}/);
  });

  it('creates a ci-e2e/ branch in the CI project from the CI parent, with an expiry backstop', () => {
    expect(code).toMatch(
      /^\s{6}CI_E2E_BRANCH_NAME: ci-e2e\/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.project \}\}\s*$/m,
    );
    const create = step(src, /- name: Create this run's Neon branch/);
    expect(create).toContain('uses: neondatabase/create-branch-action@fb620d43d4c565abaf088b848a4e28e5c4ea4d9c # v6');
    expect(create).toMatch(/project_id: \$\{\{ vars\.NEON_CI_PROJECT_ID \}\}/);
    expect(create).toMatch(/parent_branch: \$\{\{ vars\.NEON_CI_PARENT_BRANCH \}\}/);
    expect(create).toMatch(/branch_name: \$\{\{ env\.CI_E2E_BRANCH_NAME \}\}/);
    expect(create).toMatch(/expires_at: \$\{\{ steps\.\w+\.outputs\.\w+ \}\}/);
  });

  it('masks the connection strings and the password before anything else runs', () => {
    const mask = step(src, /- name: Mask and export the branch connection/);
    for (const output of ['db_url', 'db_url_pooled', 'password']) {
      expect(mask).toMatch(new RegExp(`: \\$\\{\\{ steps\\.branch\\.outputs\\.${output} \\}\\}`));
    }
    expect(mask.match(/::add-mask::/g)).toHaveLength(3);
    // The very next step after the create step.
    expect(lineOf(src, /- name: Mask and export/)).toBe(stepRange(src, /- name: Create this run's Neon branch/)!.end);
  });

  it('runs the DW-9 guard before the migration, and the migration before the seed and the build', () => {
    const guard = lineOf(src, /scripts\/seed-ci-e2e\.ts --guard-only/);
    const migrate = lineOf(src, /uses: \.\/\.github\/actions\/ci-neon-env/);
    const seed = lineOf(src, /run: node --import tsx scripts\/seed-ci-e2e\.ts\s*$|^\s+node --import tsx scripts\/seed-ci-e2e\.ts\s*$/);
    const apply = lineOf(src, /- name: Apply the CI env/);
    const build = lineOf(src, /^\s+pnpm build\s*$/);
    expect(guard).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(seed);
    expect(seed).toBeLessThan(apply);
    expect(apply).toBeLessThan(build);
    expect(step(src, /- uses: \.\/\.github\/actions\/ci-neon-env|- name: Migrate the branch/)).toMatch(/migrate: 'true'/);
  });

  it('maps the CI Upstash pair to KV_REST_API_* and the CI Blob tokens, never the prod Blob token', () => {
    const apply = step(src, /- name: Apply the CI env/);
    expect(apply).toMatch(/\$\{\{ secrets\.CI_UPSTASH_REDIS_REST_URL \}\}/);
    expect(apply).toMatch(/\$\{\{ secrets\.CI_UPSTASH_REDIS_REST_TOKEN \}\}/);
    expect(apply).toMatch(/\$\{\{ secrets\.CI_BLOB_READ_WRITE_TOKEN \}\}/);
    expect(apply).toMatch(/\$\{\{ secrets\.CI_BLOB_PRIVATE_READ_WRITE_TOKEN \}\}/);
    expect(apply).toMatch(/echo "KV_REST_API_URL=\$/);
    expect(apply).toMatch(/echo "KV_REST_API_TOKEN=\$/);
    expect(apply).toMatch(/\.github\/ci\/e2e\.env/);
    expect(code).not.toMatch(/secrets\.BLOB_READ_WRITE_TOKEN\b/);
    expect(code).not.toMatch(/secrets\.CI_DATABASE_URL\b/);
  });

  it('never expands an event or input value — or any ${{ }} — inside a run block', () => {
    expect(blocks.filter((b) => INJECTABLE.test(b.text)).map((b) => `line ${b.line}`)).toEqual([]);
    expect(blocks.filter((b) => b.text.includes('${{')).map((b) => `line ${b.line}`)).toEqual([]);
  });

  it('builds with next build, serves with next start on :3100 and waits for /api/health', () => {
    const server = step(src, /- name: Start the app/);
    expect(server).toMatch(/next start --port 3100/);
    expect(server).toMatch(/http:\/\/localhost:3100\/api\/health/);
    expect(code).not.toMatch(/\bpnpm dev\b|next dev/);
    expect(code).toContain('pnpm exec playwright install --with-deps chromium');
  });

  it('runs @critical for exactly ONE matrix project per job, attached, --workers=1, keeping traces of failures', () => {
    const runs = blocks.filter((b) => /playwright test/.test(b.text));
    expect(runs).toHaveLength(1);
    // `${{ }}` stays out of run blocks, so the matrix value arrives via env.
    expect(step(src, /- name: e2e @critical on the matrix project/)).toMatch(/^\s+PROJECT: \$\{\{ matrix\.project \}\}\s*$/m);
    expect(runs.map((b) => /--project="\$PROJECT"(\s|$)/.test(b.text))).toEqual([true]);
    expect(runs[0]!.text.match(/--project/g)).toHaveLength(1);
    for (const b of runs) {
      expect(b.text).toContain('--config=playwright.attach.config.ts');
      expect(b.text).toContain('--grep @critical');
      expect(b.text).toMatch(/--workers=1(\s|$)/);
      expect(b.text).toContain('--trace=retain-on-failure');
      expect(b.text).toMatch(/--reporter=\S*json/);
      expect(b.text).toMatch(/--output=test-results\/"\$PROJECT"(\s|$)/);
    }
  });

  it('on failure uploads only playwright-report/ and test-results/, for 7 days', () => {
    const upload = step(src, /- name: Upload the Playwright report/);
    // A flaky spec passed on a retry, so the job is green; without the
    // artifact its failed attempts' traces are lost (run 39121468131).
    expect(upload).toMatch(/^\s+if: failure\(\) \|\| cancelled\(\) \|\| steps\.summary\.outputs\.flaky == 'true'\s*$/m);
    const summary = step(src, /- name: Timing and per-spec summary/);
    expect(summary).toMatch(/^\s+id: summary\s*$/m);
    expect(summary).toMatch(/echo "flaky=true" >> "\$GITHUB_OUTPUT"/);
    expect(upload).toContain('uses: actions/upload-artifact@v4');
    expect(upload).toMatch(/retention-days: 7\s*$/m);
    const paths = /path: \|\n((?:\s{12}\S.*\n?)+)/.exec(upload)?.[1]?.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(paths).toEqual(['playwright-report/', 'test-results/']);
    expect(code).not.toMatch(/path:.*\.env/);
  });

  it('deletes the branch it created in an always() step, last', () => {
    const del = step(src, /- name: Delete this run's Neon branch/);
    expect(del).toMatch(/^\s+if: always\(\) && steps\.branch\.outputs\.created == 'true'\s*$/m);
    expect(del).toContain('uses: neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776 # v3');
    expect(del).toMatch(/project_id: \$\{\{ vars\.NEON_CI_PROJECT_ID \}\}/);
    expect(del).toMatch(/branch: \$\{\{ steps\.branch\.outputs\.branch_id \}\}/);
    expect(stepRange(src, /- name: Delete this run's Neon branch/)!.end).toBe(lines(src).length);
  });

  it('writes build, migrate, seed and per-project timings to the step summary', () => {
    for (const phase of ['migrate', 'seed', 'build', 'e2e-\\$PROJECT']) {
      expect(code).toMatch(new RegExp(`echo "${phase} \\$`));
    }
    const summary = step(src, /- name: Timing and per-spec summary/);
    expect(summary).toMatch(/^\s+if: always\(\)\s*$/m);
    expect(summary).toContain('$GITHUB_STEP_SUMMARY');
    expect(summary).toMatch(/retries/i);
  });
});

describe('.github/ci/e2e.env', () => {
  const env = read(CI_ENV);
  const pairs = new Map(
    lines(env)
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );

  it('the parse finds the overrides', () => {
    expect(pairs.size).toBeGreaterThanOrEqual(8);
  });

  it('sets the production-boot overrides the plan requires', () => {
    expect(pairs.get('E2E_BASE_URL')).toBe('http://localhost:3100');
    expect(pairs.get('APP_BASE_URL')).toBe('http://localhost:3100');
    expect(pairs.get('APP_ALLOWED_ORIGINS')).toBe('http://localhost:3100');
    expect(pairs.get('FEATURE_F6_EVENTCREATE')).toBe('false');
    expect(pairs.get('FEATURE_F5_ONLINE_PAYMENT')).toBe('true');
    expect(pairs.get('FEATURE_088_TAX_AT_PAYMENT')).toBe('true');
    expect(pairs.get('FEATURE_F9_DASHBOARD')).toBe('true');
    expect(pairs.get('EXPORT_DOWNLOAD_TOKEN_SECRET')?.length ?? 0).toBeGreaterThanOrEqual(32);
  });

  it('never enables the throwaway-tenant header, NODE_ENV or a database URL', () => {
    for (const key of ['E2E_X_TENANT_HEADER_ENABLED', 'NODE_ENV', 'DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
      expect(pairs.has(key), key).toBe(false);
    }
  });

  it('holds no service token, and no quotes ($GITHUB_ENV keeps them literally)', () => {
    for (const key of pairs.keys()) expect(key).not.toMatch(/^(BLOB_|KV_|UPSTASH_|STRIPE_SECRET|NEON_)/);
    for (const [key, value] of pairs) expect(value, key).not.toMatch(/^["']|["']$/);
  });
});

describe('e2e-critical.yml — review round 1 (PR #586)', () => {
  const src = read(WORKFLOW);
  const code = codeLines(src).join('\n');
  const blocks = runBlocks(src);
  const testSteps = () => [step(src, /- name: e2e @critical on the matrix project/)];

  it('proves, before creating a branch, that the key reaches only the CI project (M3, two-sided)', () => {
    const scope = step(src, /- name: Prove the CI key reaches only the CI project/);
    expect(scope).toMatch(/NEON_API_KEY: \$\{\{ secrets\.NEON_CI_API_KEY \}\}/);
    expect(scope).toMatch(/PROJECT_ID: \$\{\{ vars\.NEON_CI_PROJECT_ID \}\}/);
    // Both legs and the verdict live in a unit-tested script
    // (tests/unit/scripts/ci-neon-key-scope.test.ts); the step only runs it.
    expect(scope).toMatch(/run: node --import tsx scripts\/ci-neon-key-scope\.ts\s*$/m);
    expect(scope).not.toMatch(/curl|set -x|\|\| true/);
    expect(lineOf(src, /- name: Prove the CI key reaches only the CI project/)).toBeLessThan(
      lineOf(src, /- name: Create this run's Neon branch/),
    );
  });

  it('bounds each test step and stops a broken run early, keeping its trace (H3)', () => {
    for (const body of testSteps()) {
      expect(body).toMatch(/^\s+timeout-minutes: 15\s*$/m);
      expect(body).toMatch(/--max-failures=5/);
    }
  });

  it('cannot go green without running tests (H2)', () => {
    expect(code).not.toMatch(/continue-on-error/);
    for (const body of testSteps()) {
      expect(body).not.toMatch(/\|\| true|--pass-with-no-tests/);
    }
    const summary = step(src, /- name: Timing and per-spec summary/);
    expect(summary).toMatch(/status == "skipped"/);
    expect(summary).toMatch(/::error title=Skipped @critical tests/);
    expect(summary).toMatch(/exit 1/);
  });

  it('names every flaky spec in a warning (M1)', () => {
    const summary = step(src, /- name: Timing and per-spec summary/);
    expect(summary).toMatch(/status == "flaky"/);
    expect(summary).toMatch(/::warning title=Flaky @critical spec/);
  });

  it('gives each run its own Upstash rate-limit prefix (M2)', () => {
    expect(code).toMatch(
      /^\s{6}RATE_LIMIT_KEY_PREFIX: swecham-ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.project \}\}\s*$/m,
    );
  });

  it('still expands no ${{ }} inside a run block after these steps', () => {
    expect(blocks.filter((b) => b.text.includes('${{')).map((b) => `line ${b.line}`)).toEqual([]);
  });
});

describe('e2e-critical.yml — review round 2 (PR #586)', () => {
  const src = read(WORKFLOW);
  const BASELINES = join(process.cwd(), '.github', 'ci', 'e2e-critical-baselines.json');

  it('warns when a spec runs over 1.5x its recorded baseline, read from one file', () => {
    const summary = step(src, /- name: Timing and per-spec summary/);
    expect(summary).toMatch(/\.github\/ci\/e2e-critical-baselines\.json/);
    expect(summary).toMatch(/1\.5/);
    expect(summary).toMatch(/::warning title=Slow @critical spec/);
  });

  it('keeps a positive baseline (seconds) for every @critical spec, and no other', () => {
    const baselines = JSON.parse(read(BASELINES) || '{}') as Record<string, unknown>;
    const names = Object.keys(baselines).filter((k) => !k.startsWith('_'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(typeof baselines[name] === 'number' && (baselines[name] as number) > 0).toBe(true);
    const tagged = [...CRITICAL_SET];
    expect(tagged.length).toBeGreaterThan(5);
    expect(names.sort()).toEqual([...tagged].sort());
  });

  it('bounds the readiness wait by a real 3-minute deadline', () => {
    const server = step(src, /- name: Start the app/);
    expect(server).toMatch(/deadline=\$\(\( SECONDS \+ 180 \)\)/);
    expect(server).toMatch(/while \[ "\$SECONDS" -lt "\$deadline" \]/);
    expect(server).toMatch(/within 3 minutes/);
  });
});

describe('e2e-critical.yml — one parallel job per project (spec 123 DW-7)', () => {
  const src = read(WORKFLOW);
  const code = codeLines(src).join('\n');
  const PROJECTS = ['chromium', 'mobile-chrome'];
  /** The branch-name and rate-limit-prefix templates with a project substituted in. */
  const expand = (template: string, project: string) =>
    template
      .replace('${{ github.run_id }}', '39182204895')
      .replace('${{ github.run_attempt }}', '1')
      .replace('${{ matrix.project }}', project);

  it('is a matrix over both projects, and one project failing does not cancel the other', () => {
    const job = lines(src)
      .slice(lines(src).findIndex((l) => /^ {2}e2e:\s*$/.test(l)))
      .join('\n');
    expect(job).toMatch(/^\s{4}strategy:\s*$/m);
    expect(job).toMatch(/^\s{6}fail-fast:\s*false\s*$/m);
    expect(job).toMatch(/^\s{6}matrix:\s*$/m);
    const listed = /^\s{8}project:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1]?.split(',').map((p) => p.trim());
    expect(listed).toEqual(PROJECTS);
  });

  it('names each job after its project, so the check list shows both', () => {
    expect(code).toMatch(/^\s{4}name: e2e @critical \(\$\{\{ matrix\.project \}\}\)\s*$/m);
    expect(code).not.toContain('chromium + mobile-chrome)');
  });

  it('gives each project its own ci-e2e/ branch, and the name still passes the DW-9 guard and the sweep prefix', () => {
    const template = /^\s{6}CI_E2E_BRANCH_NAME: (.+?)\s*$/m.exec(code)?.[1] ?? '';
    const names = PROJECTS.map((p) => expand(template, p));
    expect(new Set(names).size).toBe(PROJECTS.length);
    for (const name of names) expect(name).toMatch(/^ci-e2e\/\d+-\d+-[a-z0-9-]+$/);
  });

  it('gives each project its own Upstash prefix, inside the validator (1-64 of [a-z0-9-])', () => {
    const template = /^\s{6}RATE_LIMIT_KEY_PREFIX: (.+?)\s*$/m.exec(code)?.[1] ?? '';
    const prefixes = PROJECTS.map((p) => expand(template, p));
    expect(new Set(prefixes).size).toBe(PROJECTS.length);
    for (const prefix of prefixes) expect(prefix).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it('uploads one artifact name per project (two jobs with one name would collide)', () => {
    const upload = step(src, /- name: Upload the Playwright report/);
    expect(upload).toMatch(
      /^\s+name: e2e-critical-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.project \}\}\s*$/m,
    );
  });

  it('runs the whole chain in each job and drops the cross-project step chaining', () => {
    for (const re of [
      /- name: Create this run's Neon branch/,
      /- name: Refuse any target but this run's ci-e2e branch/,
      /- name: Migrate the branch/,
      /- name: Seed personas and fixtures/,
      /- name: Build \(next build\)/,
      /- name: Start the app/,
      /- name: e2e @critical on the matrix project/,
      /- name: Timing and per-spec summary/,
      /- name: Upload the Playwright report/,
      /- name: Delete this run's Neon branch/,
    ]) {
      expect(stepRange(src, re), String(re)).not.toBeNull();
    }
    // The mobile-chrome step ran only after the server step of the SAME job.
    expect(code).not.toMatch(/steps\.server\.outcome/);
    expect(code).not.toMatch(/- name: e2e @critical on (chromium|mobile-chrome)\s*$/m);
    expect(code).not.toMatch(/^\s+id: (chromium|mobile-chrome)\s*$/m);
  });
});
