/**
 * Seed a fresh `ci-e2e/*` Neon branch for the PR e2e run (spec 123 US2,
 * DW-6 + DW-9).
 *
 * The CI Neon project starts empty, so every run's branch is migrated from
 * zero and then needs the personas and fixtures a developer's `dev` branch
 * already has. This runs the existing seed scripts in the one order that
 * works (plan § Fixes):
 *
 *   system actors → e2e users → F4 invoice settings → 2026 plans →
 *   F5 payment settings → portal invoices (088 on) → F5 reconciliation →
 *   F5 stale invoice → F4 admin fixtures
 *
 * The F4 settings run BEFORE the plans seed: the plans seed inserts
 * placeholder invoice settings, and the F4 seed's ON CONFLICT DO NOTHING
 * would then keep them.
 *
 * The seeds print the env a developer pastes into `.env.local`
 * (`export E2E_ADMIN_EMAIL='…'`, `E2E_ISSUED_INVOICE_ID=…`). Here those lines
 * go to `$GITHUB_ENV` for the later steps instead, and the repo is PUBLIC, so
 * each value is registered with `::add-mask::` before anything else is
 * printed, and the KEY= lines themselves are never echoed. A degenerate value
 * (`1`, `true`, three characters or fewer) is not masked: masking "1" stars
 * out every "1" in every later log line, timings included, and such a value
 * carries nothing worth hiding.
 *
 * Only `E2E_*` and the F4 fixture document numbers are exported. Feature
 * flags belong to `.github/ci/e2e.env`, and the Stripe values a seed suggests
 * would override `.env.example`'s test-mode pins, so those keys are dropped
 * and named in the log.
 *
 * DW-9 — before it writes anything, and as its own workflow step before the
 * migration (`--guard-only`), it refuses every target except the branch this
 * run just created: the name must start with `ci-e2e/`, the action must report
 * `created=true` (it silently REUSES a same-named branch), and the hosts in
 * DATABASE_URL / DATABASE_URL_UNPOOLED must EQUAL the pooled / direct hosts
 * Neon returned for that branch. On top of that, the shared seed-target guard
 * (TEST_DB_HOST_BLOCKLIST, fail-closed; NODE_ENV=production) and a refusal of
 * the `.env.example` placeholders, as `.github/actions/ci-neon-env` does.
 *
 *   node --import tsx scripts/seed-ci-e2e.ts --guard-only
 *   node --import tsx scripts/seed-ci-e2e.ts
 *
 * Env: DATABASE_URL, DATABASE_URL_UNPOOLED, TEST_DB_HOST_BLOCKLIST,
 * CI_E2E_BRANCH_NAME, CI_E2E_EXPECTED_HOST, CI_E2E_EXPECTED_DIRECT_HOST,
 * CI_E2E_BRANCH_CREATED, GITHUB_ENV; CI_E2E_ENV_FILE (default `.env.local`,
 * the file `.github/actions/ci-neon-env` writes) fills the rest of the env
 * schema for the seeds.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedTargetRefusal } from './lib/seed-target-guard';

export interface CiE2eTarget {
  readonly databaseUrl: string | undefined;
  readonly unpooledUrl: string | undefined;
  readonly blocklistRaw: string | undefined;
  readonly nodeEnv: string | undefined;
  /** The name this run asked Neon for. */
  readonly branchName: string | undefined;
  /** `db_host_pooled` from neondatabase/create-branch-action. */
  readonly expectedHost: string | undefined;
  /** `db_host` from neondatabase/create-branch-action. */
  readonly expectedDirectHost: string | undefined;
  /** `created` from neondatabase/create-branch-action ('true' | 'false'). */
  readonly created: string | undefined;
}

export interface SeedStep {
  readonly script: string;
  /** Extra env for this seed only. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SeedExport {
  readonly key: string;
  readonly value: string;
}

const BRANCH_PREFIX = 'ci-e2e/';
const TENANT_SLUG = 'swecham';

/**
 * Stand-ins that have shipped in `.env.example` as TEST_DB_HOST_BLOCKLIST. Kept
 * equal to `tests/helpers/db-host-guard.ts` (a unit test asserts it) and to the
 * literals `.github/actions/ci-neon-env/action.yml` refuses.
 */
export const BLOCKLIST_PLACEHOLDERS: readonly string[] = [
  'REPLACE-WITH-YOUR-PROD-ENDPOINT-ID',
  'ep-prod-endpoint-id',
];

/** The fake host `.env.example` ships in its DATABASE_URL lines. */
const PLACEHOLDER_DB_HOSTS: readonly string[] = ['host.aws.neon.tech'];

export const SEED_CHAIN: readonly SeedStep[] = [
  { script: 'scripts/seed-system-actors.ts' },
  { script: 'scripts/seed-e2e-user.ts' },
  { script: 'scripts/seed-f4-invoice-settings.ts' },
  { script: 'scripts/seed-swecham-2026-plans.ts' },
  { script: 'scripts/seed-f5-e2e-payment-settings.ts' },
  { script: 'scripts/seed-e2e-portal-invoices.ts', env: { FEATURE_088_TAX_AT_PAYMENT: 'true' } },
  { script: 'scripts/seed-f5-e2e-reconciliation.ts' },
  { script: 'scripts/seed-f5-e2e-stale-invoice.ts' },
  { script: 'scripts/seed-f4-e2e-admin-fixtures.ts' },
];

const PLANS_SEED = 'scripts/seed-swecham-2026-plans.ts';

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function ciE2eTargetRefusal(t: CiE2eTarget): string | null {
  const name = t.branchName ?? '';
  if (!name.startsWith(BRANCH_PREFIX) || name.length === BRANCH_PREFIX.length) {
    return `refused: the branch name "${name}" does not start with ${BRANCH_PREFIX}<run>. Only this run's own ci-e2e branch may be seeded.`;
  }
  if (t.created !== 'true') {
    return (
      `refused: the Neon action reports created=${t.created ?? 'unset'}. It reuses a branch that ` +
      'already has the name, so this would seed a leftover branch; only a branch created by this run is accepted.'
    );
  }

  const blocklist = (t.blocklistRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const placeholder = blocklist.find((v) => BLOCKLIST_PLACEHOLDERS.includes(v));
  if (placeholder !== undefined) {
    return `refused: TEST_DB_HOST_BLOCKLIST is the .env.example placeholder (${placeholder}), so it blocks nothing. Set the repository variable to the production Neon endpoint id.`;
  }
  // Blocklist (fail-closed when unset) and NODE_ENV=production. Never with
  // --confirm-target: CI has no human to confirm anything.
  const shared = seedTargetRefusal({
    databaseUrl: t.databaseUrl,
    blocklistRaw: t.blocklistRaw,
    nodeEnv: t.nodeEnv,
    emails: [],
  });
  if (shared !== null) return shared;
  if (t.unpooledUrl !== undefined) {
    const blockedDirect = blocklist.find((needle) => t.unpooledUrl!.includes(needle));
    if (blockedDirect !== undefined) {
      return `refused: DATABASE_URL_UNPOOLED matches "${blockedDirect}" from TEST_DB_HOST_BLOCKLIST.`;
    }
  }

  const host = hostOf(t.databaseUrl!);
  if (host === null) return 'refused: DATABASE_URL is not a parsable URL.';
  if (PLACEHOLDER_DB_HOSTS.includes(host)) {
    return `refused: DATABASE_URL still points at the .env.example placeholder host (${host}).`;
  }
  if (!t.expectedHost || !t.expectedDirectHost) {
    return 'refused: the host the Neon action reported for this branch is missing (CI_E2E_EXPECTED_HOST / CI_E2E_EXPECTED_DIRECT_HOST).';
  }
  if (host !== t.expectedHost) {
    return 'refused: the DATABASE_URL host is not the pooled host of the branch this run created.';
  }
  if (t.unpooledUrl !== undefined && hostOf(t.unpooledUrl) !== t.expectedDirectHost) {
    return 'refused: the DATABASE_URL_UNPOOLED host is not the direct host of the branch this run created.';
  }
  return null;
}

/**
 * The env for one seed. NODE_ENV is removed (a seed refuses `production`, and
 * `next start` sets it later), the scripts tsconfig stubs `server-only`, and
 * BOOTSTRAP_ADMIN_EMAIL names the e2e admin once it exists: the
 * `.env.example` value names an account the CI branch does not have, which
 * makes the plans seed throw.
 */
export function childEnv(
  base: Readonly<Record<string, string | undefined>>,
  exported: Readonly<Record<string, string>>,
  step: SeedStep,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...exported, ...step.env };
  delete env.NODE_ENV;
  delete env.BOOTSTRAP_ADMIN_EMAIL;
  if (exported.E2E_ADMIN_EMAIL !== undefined) env.BOOTSTRAP_ADMIN_EMAIL = exported.E2E_ADMIN_EMAIL;
  env.TSX_TSCONFIG_PATH = 'tsconfig.scripts.json';
  env.TENANT_SLUG = TENANT_SLUG;
  return env;
}

const EXPORT_LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/;
const EXPORTABLE = /^(E2E_|PAY_TARGET_|CREDIT_TARGET_)/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseSeedExports(stdout: string): {
  exports: SeedExport[];
  ignored: string[];
  otherLines: string[];
} {
  const exports: SeedExport[] = [];
  const ignored: string[] = [];
  const otherLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = EXPORT_LINE.exec(line);
    if (m === null) {
      otherLines.push(line);
      continue;
    }
    const key = m[1]!;
    if (EXPORTABLE.test(key)) exports.push({ key, value: unquote(m[2]!) });
    else ignored.push(key);
  }
  return { exports, ignored, otherLines };
}

function isDegenerate(value: string): boolean {
  return value.length <= 3 || /^(true|false)$/i.test(value);
}

export function githubEnvChunk(exports: readonly SeedExport[]): { masks: string[]; env: string } {
  const masks: string[] = [];
  let env = '';
  for (const { key, value } of exports) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`seed-ci-e2e: the value of ${key} holds a line break; refusing to write it to $GITHUB_ENV.`);
    }
    if (!isDegenerate(value)) masks.push(`::add-mask::${value}`);
    env += `${key}=${value}\n`;
  }
  return { masks, env };
}

export function bangkokYear(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(now));
}

export function planYearRefusal(years: readonly number[], now: Date): string | null {
  const year = bangkokYear(now);
  if (years.includes(year)) return null;
  return (
    `refused: no membership plans for ${year} (the current Asia/Bangkok year); the CI seed has ` +
    `[${years.join(', ')}]. scripts/seed-swecham-2026-plans.ts pins 2026, so the e2e seed needs a ` +
    `plans seed for ${year} before this run can pass.`
  );
}

function fail(message: string): never {
  console.error(`::error title=seed-ci-e2e::${message}`);
  process.exit(1);
}

async function planYears(databaseUrl: string): Promise<number[]> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { ssl: 'require', max: 1 });
  try {
    const rows = await sql<Array<{ plan_year: number }>>`
      SELECT DISTINCT plan_year FROM membership_plans WHERE tenant_id = ${TENANT_SLUG}
    `;
    return rows.map((r) => Number(r.plan_year));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const env = process.env;
  const refusal = ciE2eTargetRefusal({
    databaseUrl: env.DATABASE_URL,
    unpooledUrl: env.DATABASE_URL_UNPOOLED,
    blocklistRaw: env.TEST_DB_HOST_BLOCKLIST,
    nodeEnv: env.NODE_ENV,
    branchName: env.CI_E2E_BRANCH_NAME,
    expectedHost: env.CI_E2E_EXPECTED_HOST,
    expectedDirectHost: env.CI_E2E_EXPECTED_DIRECT_HOST,
    created: env.CI_E2E_BRANCH_CREATED,
  });
  if (refusal !== null) fail(refusal);
  console.log(`target ok: ${env.CI_E2E_BRANCH_NAME}, created by this run, on its own host`);
  if (argv.includes('--guard-only')) return;

  const githubEnv = env.GITHUB_ENV;
  if (!githubEnv) fail('GITHUB_ENV is not set; this script only runs inside the e2e-critical workflow.');
  const envFile = env.CI_E2E_ENV_FILE ?? '.env.local';
  if (!existsSync(envFile)) fail(`${envFile} is missing; run .github/actions/ci-neon-env first.`);

  const exported: Record<string, string> = {};
  for (const step of SEED_CHAIN) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [`--env-file=${envFile}`, '--import', 'tsx', step.script], {
      // NODE_ENV is removed on purpose; Next types it as required.
      env: childEnv(env, exported, step) as NodeJS.ProcessEnv,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    const parsed = parseSeedExports(result.stdout ?? '');
    const chunk = githubEnvChunk(parsed.exports);
    // Masks first: nothing this seed printed may reach the log before them.
    for (const mask of chunk.masks) console.log(mask);
    for (const line of parsed.otherLines) if (line.trim() !== '') console.log(`  ${line}`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      fail(`${step.script} failed (exit ${result.status ?? result.signal ?? 'unknown'}).`);
    }
    appendFileSync(githubEnv!, chunk.env);
    for (const { key, value } of parsed.exports) exported[key] = value;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const keys = parsed.exports.map((e) => e.key).join(', ') || 'none';
    const ignored = parsed.ignored.length > 0 ? `; ignored: ${parsed.ignored.join(', ')}` : '';
    console.log(`ok ${step.script} in ${secs}s (exported: ${keys}${ignored})`);

    if (step.script === PLANS_SEED) {
      const years = await planYears(env.DATABASE_URL!);
      const yearRefusal = planYearRefusal(years, new Date());
      if (yearRefusal !== null) fail(yearRefusal);
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('seed-ci-e2e.ts'));

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
