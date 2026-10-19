/**
 * `scripts/seed-ci-e2e.ts` (spec 123 US2, DW-6 + DW-9).
 *
 * The orchestrator that seeds a fresh `ci-e2e/*` Neon branch for the PR e2e
 * run. Pure parts only — no database, no child process:
 *   - the target guard (DW-9): only this run's freshly created `ci-e2e/`
 *     branch, reached on exactly the host Neon reported for it, never a
 *     blocklisted or placeholder host;
 *   - the seed chain order (binding, plan § Fixes);
 *   - the child env (NODE_ENV unset, tsconfig, BOOTSTRAP_ADMIN_EMAIL);
 *   - parsing the seeds' `KEY=value` lines and turning them into
 *     `::add-mask::` lines + `$GITHUB_ENV` text (the repo is public);
 *   - the plan-year check (the seeds pin 2026; January 2027 must fail loudly).
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKLIST_PLACEHOLDERS,
  REQUIRED_EXPORTS,
  SEED_CHAIN,
  bangkokYear,
  childEnv,
  ciE2eTargetRefusal,
  githubEnvChunk,
  main,
  missingRequiredExports,
  parseSeedExports,
  planYearRefusal,
  type CiE2eTarget,
  type SeedDeps,
} from '../../../scripts/seed-ci-e2e';
import { DB_HOST_BLOCKLIST_PLACEHOLDERS } from '../../helpers/db-host-guard';

const POOLED = 'ep-cool-ci-123456-pooler.ap-southeast-1.aws.neon.tech';
const DIRECT = 'ep-cool-ci-123456.ap-southeast-1.aws.neon.tech';

function target(overrides: Partial<CiE2eTarget> = {}): CiE2eTarget {
  return {
    databaseUrl: `postgresql://neondb_owner:pw@${POOLED}/neondb?sslmode=require`,
    unpooledUrl: `postgresql://neondb_owner:pw@${DIRECT}/neondb?sslmode=require`,
    blocklistRaw: 'ep-prod-real-777',
    nodeEnv: undefined,
    branchName: 'ci-e2e/39061553065-1',
    expectedHost: POOLED,
    expectedDirectHost: DIRECT,
    created: 'true',
    ...overrides,
  };
}

describe('ciE2eTargetRefusal (DW-9)', () => {
  it('accepts the branch this run created, on the host Neon reported', () => {
    expect(ciE2eTargetRefusal(target())).toBeNull();
  });

  it.each([
    ['a name without the prefix', 'dev'],
    ['the prod branch name', 'main'],
    ['a prefix that is only a substring', 'x-ci-e2e/1'],
    ['the bare prefix', 'ci-e2e/'],
    ['an empty name', ''],
  ])('refuses %s', (_label, branchName) => {
    expect(ciE2eTargetRefusal(target({ branchName }))).toMatch(/ci-e2e\//);
  });

  it('refuses a host in TEST_DB_HOST_BLOCKLIST', () => {
    const msg = ciE2eTargetRefusal(target({ blocklistRaw: 'ep-other, ep-cool-ci-123456' }));
    expect(msg).toMatch(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('refuses an unset blocklist (fail closed)', () => {
    expect(ciE2eTargetRefusal(target({ blocklistRaw: undefined }))).toMatch(/TEST_DB_HOST_BLOCKLIST/);
    expect(ciE2eTargetRefusal(target({ blocklistRaw: ' , ' }))).toMatch(/TEST_DB_HOST_BLOCKLIST/);
  });

  it.each(DB_HOST_BLOCKLIST_PLACEHOLDERS)('refuses the .env.example blocklist placeholder %s', (placeholder) => {
    expect(ciE2eTargetRefusal(target({ blocklistRaw: placeholder }))).toMatch(/placeholder/);
  });

  it('knows every placeholder the test harness knows', () => {
    expect([...BLOCKLIST_PLACEHOLDERS].sort()).toEqual([...DB_HOST_BLOCKLIST_PLACEHOLDERS].sort());
  });

  it('refuses the .env.example placeholder database host', () => {
    const msg = ciE2eTargetRefusal(
      target({
        databaseUrl: 'postgresql://u:p@host.aws.neon.tech/neondb',
        expectedHost: 'host.aws.neon.tech',
      }),
    );
    expect(msg).toMatch(/placeholder/);
  });

  it('refuses a DATABASE_URL whose host differs from the created branch host', () => {
    const msg = ciE2eTargetRefusal(
      target({ databaseUrl: 'postgresql://u:p@ep-dev-branch-999-pooler.ap-southeast-1.aws.neon.tech/neondb' }),
    );
    expect(msg).toMatch(/host/);
  });

  it('refuses a host that only CONTAINS the expected host', () => {
    const msg = ciE2eTargetRefusal(target({ databaseUrl: `postgresql://u:p@${POOLED}.evil.example/neondb` }));
    expect(msg).toMatch(/host/);
  });

  it('refuses a DATABASE_URL_UNPOOLED whose host differs from the direct host', () => {
    const msg = ciE2eTargetRefusal(target({ unpooledUrl: `postgresql://u:p@${POOLED}/neondb` }));
    expect(msg).toMatch(/DATABASE_URL_UNPOOLED/);
  });

  it('refuses when the expected host is missing', () => {
    expect(ciE2eTargetRefusal(target({ expectedHost: '' }))).toMatch(/host/);
    expect(ciE2eTargetRefusal(target({ expectedDirectHost: undefined }))).toMatch(/host/);
  });

  it('refuses an unparsable or missing DATABASE_URL', () => {
    expect(ciE2eTargetRefusal(target({ databaseUrl: 'not a url' }))).not.toBeNull();
    expect(ciE2eTargetRefusal(target({ databaseUrl: undefined }))).toMatch(/DATABASE_URL/);
  });

  it('refuses a branch the action reused instead of created', () => {
    expect(ciE2eTargetRefusal(target({ created: 'false' }))).toMatch(/created/);
    expect(ciE2eTargetRefusal(target({ created: undefined }))).toMatch(/created/);
  });

  it('refuses NODE_ENV=production', () => {
    expect(ciE2eTargetRefusal(target({ nodeEnv: 'production' }))).toMatch(/NODE_ENV/);
  });
});

describe('SEED_CHAIN', () => {
  it('runs the seeds in the binding order (F4 settings before the plans seed)', () => {
    expect(SEED_CHAIN.map((s) => s.script)).toEqual([
      'scripts/seed-system-actors.ts',
      'scripts/seed-e2e-user.ts',
      'scripts/seed-f4-invoice-settings.ts',
      'scripts/seed-swecham-2026-plans.ts',
      'scripts/seed-f5-e2e-payment-settings.ts',
      'scripts/seed-e2e-portal-invoices.ts',
      'scripts/seed-f5-e2e-reconciliation.ts',
      'scripts/seed-f5-e2e-stale-invoice.ts',
      'scripts/seed-f4-e2e-admin-fixtures.ts',
    ]);
  });

  it('seeds the portal invoices with FEATURE_088_TAX_AT_PAYMENT=true, and only them', () => {
    const withFlag = SEED_CHAIN.filter((s) => s.env?.FEATURE_088_TAX_AT_PAYMENT === 'true');
    expect(withFlag.map((s) => s.script)).toEqual(['scripts/seed-e2e-portal-invoices.ts']);
  });
});

describe('childEnv', () => {
  const base = {
    NODE_ENV: 'production',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@swecham.se',
    DATABASE_URL: 'postgresql://x',
    TENANT_SLUG: undefined,
  };

  it('unsets NODE_ENV, pins the scripts tsconfig and the swecham tenant', () => {
    const env = childEnv(base, {}, SEED_CHAIN[0]!);
    expect('NODE_ENV' in env).toBe(false);
    expect(env.TSX_TSCONFIG_PATH).toBe('tsconfig.scripts.json');
    expect(env.TENANT_SLUG).toBe('swecham');
    expect(env.DATABASE_URL).toBe('postgresql://x');
  });

  it('unsets BOOTSTRAP_ADMIN_EMAIL until the e2e admin exists, then points it there', () => {
    expect('BOOTSTRAP_ADMIN_EMAIL' in childEnv(base, {}, SEED_CHAIN[0]!)).toBe(false);
    const env = childEnv(base, { E2E_ADMIN_EMAIL: 'e2e-admin@swecham.test' }, SEED_CHAIN[3]!);
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('e2e-admin@swecham.test');
  });

  it('passes earlier seeds\' exports and the step\'s own env to the child', () => {
    const portal = SEED_CHAIN.find((s) => s.script.endsWith('seed-e2e-portal-invoices.ts'))!;
    const env = childEnv(base, { E2E_MEMBER_EMAIL: 'm@swecham.test' }, portal);
    expect(env.E2E_MEMBER_EMAIL).toBe('m@swecham.test');
    expect(env.FEATURE_088_TAX_AT_PAYMENT).toBe('true');
  });
});

describe('parseSeedExports', () => {
  const stdout = [
    'seeding E2E test users…',
    '----------------------------------------',
    "  export E2E_ADMIN_EMAIL='e2e-admin@swecham.test'",
    '  export E2E_ADMIN_PASSWORD="Synthetic-Pass-1"',
    '  E2E_MEMBER_HAS_INVOICES=1',
    'E2E_STALE_INVOICE_ID=00000000-e2e0-4fff-9ffe-000000900007',
    "  E2E_ADMIN_MUTATION_MEMBER='E2E Mutation Co'",
    '  PAY_TARGET_DOCUMENT_NUMBER=SC-2026-995001',
    '  FEATURE_F5_ONLINE_PAYMENT=true',
    '  STRIPE_API_VERSION=2024-06-20',
    '    processor=stripe env=test account=acct_x',
    'DB host: ep-cool-ci-123456.ap-southeast-1.aws.neon.tech',
  ].join('\r\n');

  it('reads KEY=value lines with or without export, and strips the quotes', () => {
    const { exports } = parseSeedExports(stdout);
    expect(exports).toEqual([
      { key: 'E2E_ADMIN_EMAIL', value: 'e2e-admin@swecham.test' },
      { key: 'E2E_ADMIN_PASSWORD', value: 'Synthetic-Pass-1' },
      { key: 'E2E_MEMBER_HAS_INVOICES', value: '1' },
      { key: 'E2E_STALE_INVOICE_ID', value: '00000000-e2e0-4fff-9ffe-000000900007' },
      { key: 'E2E_ADMIN_MUTATION_MEMBER', value: 'E2E Mutation Co' },
      { key: 'PAY_TARGET_DOCUMENT_NUMBER', value: 'SC-2026-995001' },
    ]);
  });

  it('drops keys .github/ci/e2e.env or .env.example own, naming them', () => {
    const { ignored } = parseSeedExports(stdout);
    expect(ignored).toEqual(['FEATURE_F5_ONLINE_PAYMENT', 'STRIPE_API_VERSION']);
  });

  it('returns the remaining lines for the log, without any KEY= line', () => {
    const { otherLines } = parseSeedExports(stdout);
    expect(otherLines).toContain('seeding E2E test users…');
    expect(otherLines).toContain('    processor=stripe env=test account=acct_x');
    expect(otherLines.filter((l) => /^\s*(export\s+)?[A-Z0-9_]+=/.test(l))).toEqual([]);
  });
});

describe('githubEnvChunk', () => {
  it('masks every value before it reaches $GITHUB_ENV', () => {
    const chunk = githubEnvChunk([
      { key: 'E2E_ADMIN_PASSWORD', value: 'Synthetic-Pass-1' },
      { key: 'E2E_ADMIN_EMAIL', value: 'e2e-admin@swecham.test' },
    ]);
    expect(chunk.masks).toEqual(['::add-mask::Synthetic-Pass-1', '::add-mask::e2e-admin@swecham.test']);
    expect(chunk.env).toBe('E2E_ADMIN_PASSWORD=Synthetic-Pass-1\nE2E_ADMIN_EMAIL=e2e-admin@swecham.test\n');
  });

  it('does not mask a degenerate value, which would star out every log line', () => {
    const chunk = githubEnvChunk([
      { key: 'E2E_MEMBER_HAS_INVOICES', value: '1' },
      { key: 'E2E_FLAG', value: 'true' },
      { key: 'E2E_OFF', value: 'false' },
      { key: 'E2E_ZERO', value: '0' },
      { key: 'E2E_SHORT', value: 'abc' },
    ]);
    expect(chunk.masks).toEqual([]);
    expect(chunk.env).toContain('E2E_MEMBER_HAS_INVOICES=1\n');
  });

  it('refuses a value that would break out of its $GITHUB_ENV line', () => {
    expect(() => githubEnvChunk([{ key: 'E2E_X', value: 'a\nNODE_OPTIONS=--require=x' }])).toThrow(/E2E_X/);
    expect(() => githubEnvChunk([{ key: 'E2E_X', value: 'a\rb' }])).toThrow(/E2E_X/);
  });
});

describe('plan year', () => {
  it('reads the year in Asia/Bangkok, not UTC', () => {
    expect(bangkokYear(new Date('2026-12-31T16:59:59Z'))).toBe(2026);
    expect(bangkokYear(new Date('2026-12-31T17:00:00Z'))).toBe(2027);
  });

  it('passes when the current Bangkok year has plans', () => {
    expect(planYearRefusal([2026], new Date('2026-10-18T03:00:00Z'))).toBeNull();
  });

  it('fails loudly when it does not — the seeds pin 2026', () => {
    const msg = planYearRefusal([2026], new Date('2026-12-31T17:00:00Z'));
    expect(msg).toMatch(/2027/);
    expect(planYearRefusal([], new Date('2026-10-18T03:00:00Z'))).toMatch(/2026/);
  });
});

describe('required exports (a chain that exports nothing must not pass)', () => {
  const all = Object.fromEntries(REQUIRED_EXPORTS.map((k) => [k, 'x'.repeat(8)]));

  it('names the personas and fixtures the @critical specs read', () => {
    for (const key of [
      'E2E_ADMIN_EMAIL',
      'E2E_ADMIN_PASSWORD',
      'E2E_MEMBER_EMAIL',
      'E2E_MEMBER_PASSWORD',
      'E2E_ISSUED_INVOICE_ID',
      'E2E_SUPER_ADMIN_EMAIL',
      'E2E_MANAGER_EMAIL',
      'E2E_MEMBER_EMAIL_EMPTY',
      'E2E_ADMIN_MUTATION_MEMBER',
    ]) {
      expect(REQUIRED_EXPORTS).toContain(key);
    }
  });

  it('reports nothing missing when every key has a value, and each missing or empty key otherwise', () => {
    expect(missingRequiredExports(all)).toEqual([]);
    const rest: Record<string, string> = { ...all };
    delete rest.E2E_ISSUED_INVOICE_ID;
    expect(missingRequiredExports({ ...rest, E2E_ADMIN_EMAIL: '' })).toEqual([
      'E2E_ADMIN_EMAIL',
      'E2E_ISSUED_INVOICE_ID',
    ]);
  });
});

describe('main()', () => {
  const baseEnv = {
    DATABASE_URL: `postgresql://neondb_owner:pw@${POOLED}/neondb?sslmode=require`,
    DATABASE_URL_UNPOOLED: `postgresql://neondb_owner:pw@${DIRECT}/neondb?sslmode=require`,
    TEST_DB_HOST_BLOCKLIST: 'ep-prod-real-777',
    CI_E2E_BRANCH_NAME: 'ci-e2e/1-1',
    CI_E2E_EXPECTED_HOST: POOLED,
    CI_E2E_EXPECTED_DIRECT_HOST: DIRECT,
    CI_E2E_BRANCH_CREATED: 'true',
    GITHUB_ENV: '/tmp/github_env',
  };

  function deps(exportsByScript: Record<string, string>): SeedDeps & { appended: string[]; spawned: string[] } {
    const appended: string[] = [];
    const spawned: string[] = [];
    return {
      env: baseEnv,
      appended,
      spawned,
      exists: () => true,
      spawn: (script) => {
        spawned.push(script);
        return { status: 0, signal: null, stdout: exportsByScript[script] ?? '', stderr: '' };
      },
      append: (_path, text) => {
        appended.push(text);
      },
      planYears: async () => [2026],
      now: () => new Date('2026-10-18T03:00:00Z'),
      log: () => {},
      logError: () => {},
    };
  }

  const everything = REQUIRED_EXPORTS.map((k) => `${k}=value-${k.toLowerCase()}`).join('\n');

  it('runs the whole chain and writes the exports when every required key is exported', async () => {
    const d = deps({ 'scripts/seed-e2e-user.ts': everything });
    await expect(main([], d)).resolves.toBeUndefined();
    expect(d.spawned).toEqual(SEED_CHAIN.map((s) => s.script));
    expect(d.appended.join('')).toMatch(/E2E_ISSUED_INVOICE_ID=/);
  });

  it('fails after the chain when a required key was never exported, naming it', async () => {
    const d = deps({ 'scripts/seed-e2e-user.ts': everything.replace(/^E2E_ISSUED_INVOICE_ID=.*$/m, '') });
    await expect(main([], d)).rejects.toThrow(/E2E_ISSUED_INVOICE_ID/);
    expect(d.spawned).toHaveLength(SEED_CHAIN.length);
  });

  it('fails when the whole chain exports nothing', async () => {
    await expect(main([], deps({}))).rejects.toThrow(/required export/);
  });

  it('stops after the guard with --guard-only, running no seed', async () => {
    const d = deps({});
    await expect(main(['--guard-only'], d)).resolves.toBeUndefined();
    expect(d.spawned).toEqual([]);
  });

  it('refuses a target the guard rejects, before any seed', async () => {
    const d = deps({});
    await expect(main([], { ...d, env: { ...baseEnv, CI_E2E_BRANCH_NAME: 'main' } })).rejects.toThrow(/ci-e2e\//);
    expect(d.spawned).toEqual([]);
  });

  it('stops at a failing seed and names it', async () => {
    const d = deps({});
    const failing: SeedDeps = {
      ...d,
      spawn: (script) => ({ status: script.includes('plans') ? 1 : 0, signal: null, stdout: '', stderr: '' }),
    };
    await expect(main([], failing)).rejects.toThrow(/seed-swecham-2026-plans\.ts failed/);
  });
});
