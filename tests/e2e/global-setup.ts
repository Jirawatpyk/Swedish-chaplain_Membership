/**
 * Playwright global setup.
 *
 * Runs ONCE before any test starts. Responsibilities:
 *  1. Clears Upstash rate-limit buckets so a prior run's residue doesn't
 *     trip the 5/15-min sign-in limit on the dedicated test users.
 *  2. Warms `/admin/sign-in`, `/admin`, `/portal/sign-in` and `/portal` so a cold
 *     Turbopack compile does not land inside a test's `beforeEach` — see
 *     `warmAdminRoutes` for why that was fatal rather than merely slow.
 *  3. Resets the F5 issued-invoice fixture row (E2E_ISSUED_INVOICE_ID)
 *     back to status='issued' so the Pay-now button renders again after
 *     a happy-path run flipped it to `paid`. Cascades through child
 *     payments / refunds / processor_events first.
 *
 * Registered via `globalSetup` in `playwright.config.ts`.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { resetE2eIssuedFixture } from '../../scripts/lib/e2e-issued-fixture-reset';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { seedF7Broadcasts } from './helpers/broadcasts-seed';
import { seedF8Renewals } from './helpers/renewals-seed';
import { seedF6Events } from './helpers/eventcreate-seed';

/**
 * Compile the routes every persona suite signs in through, BEFORE any test's
 * clock starts.
 *
 * Playwright's `webServer.url` readiness probe hits `/` only, so on a cold dev
 * server `/admin/sign-in` and `/admin` are still uncompiled when the first test
 * runs. Turbopack then compiles them inside `beforeEach`, and the sign-in
 * helper's `waitForURL` blows the 30s TEST timeout — which caps the whole hook,
 * so the helper's own documented 60s budget (bumped in R9.B1 for exactly this
 * reason) can never be reached.
 *
 * That made the persona suites pass only when a dev server happened to be warm
 * already, and fail as a block when Playwright started its own. Nine failures
 * in one run, every one of them `Test timeout of 30000ms exceeded while running
 * "beforeEach" hook` — no assertion ever executed.
 *
 * Warming here fixes it for every suite at once, instead of raising a timeout in
 * each. Best-effort: a failure to warm is not a reason to fail the whole run,
 * and the tests will simply pay the compile as before.
 */
async function warmAdminRoutes(): Promise<void> {
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
  // `/portal` too: the member nav-a11y test signs in and lands there, and an
  // unwarmed /portal cold-compiled past the sign-in helper's 60s budget on
  // webkit — the only project that runs it against a truly cold route.
  const routes = ['/admin/sign-in', '/admin', '/portal/sign-in', '/portal'];
  for (const route of routes) {
    try {
      // 120s: a cold Turbopack compile of `/admin` is the slowest thing in the
      // whole run. Sequential, not parallel — concurrent first-hits on a cold
      // dev server contend for the same compiler and are slower in practice.
      const res = await fetch(`${base}${route}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
      });
      console.log(`[e2e global setup] warmed ${route} (${res.status})`);
    } catch (error) {
      console.warn(`[e2e global setup] warm ${route} failed:`, String(error));
    }
  }
}

async function resetF5IssuedInvoice(): Promise<void> {
  const id = process.env.E2E_ISSUED_INVOICE_ID;
  const dbUrl = process.env.DATABASE_URL;
  if (!id || !dbUrl) {
    console.warn(
      '[e2e global setup] skipping F5 invoice reset — E2E_ISSUED_INVOICE_ID or DATABASE_URL missing',
    );
    return;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // processor_events has no invoice_id column — stale rows for old
    // PaymentIntent ids are inert (each test creates a new PI). Skip.
    //
    // The fixture is an 088 bill: a run that paid it minted an RC receipt
    // number, which migration 0235 freezes, so it cannot be flipped back to
    // 'issued' in place. The shared reset unwinds its refunds / credit notes /
    // payments (the admin-refund-full chain) and re-creates it as a fresh
    // unpaid bill in one transaction — see scripts/lib/e2e-issued-fixture-reset.ts.
    const found = await resetE2eIssuedFixture(sql, id);
    // A dev-branch re-seed or cleanup can remove the fixture row. The old
    // UPDATE then matched nothing, this still logged "reset", and every pay*/payment*
    // spec timed out on the portal's not-found page with no hint why (R12,
    // 2026-09-28: 37 failures on both refs). Same silent miss as #434 fixed in
    // scripts/reset-e2e-issued-invoice.ts. The caller logs this and carries on.
    if (!found) {
      throw new Error(
        `fixture invoice ${id} not found — run ` +
          '`TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/seed-e2e-portal-invoices.ts` ' +
          '(it re-creates SC-2026-900003 as 00000000-e2e0-4fff-9ffe-000000900003; point E2E_ISSUED_INVOICE_ID there), ' +
          'then `pnpm seed:f5-e2e:reconciliation`',
      );
    }
    console.log(`[e2e global setup] reset F5 issued-invoice fixture ${id}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The paid-online F5 fixture (SC-2026-900001, used by the reconciliation and
 * refund specs) is looked up by its DOCUMENT NUMBER, not trusted from
 * `.env.local`. Seeds before the 088 re-shape minted a new id on every run,
 * which left `E2E_PAID_ONLINE_INVOICE_ID` pointing at a deleted row on
 * 2026-09-28 (the same drift #434 fixed for 900003); the seed now pins it
 * (`00000000-e2e0-4fff-9ffe-000000900001`), and the lookup still covers a DB
 * seeded either way. It is an 088 paid bill, so the SC number rides
 * `bill_document_number_raw`; a legacy-shaped row carries it in
 * `document_number`. Setting `process.env` here reaches every worker, which
 * forks after global setup. A miss keeps whatever the env had.
 */
const PAID_ONLINE_DOCUMENT_NUMBER = 'SC-2026-900001';

async function resolvePaidOnlineInvoice(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const rows = await sql<Array<{ invoice_id: string }>>`
      SELECT invoice_id::text AS invoice_id FROM invoices
      WHERE tenant_id = 'swecham'
        AND (bill_document_number_raw = ${PAID_ONLINE_DOCUMENT_NUMBER}
             OR document_number = ${PAID_ONLINE_DOCUMENT_NUMBER})
      LIMIT 1
    `;
    const id = rows[0]?.invoice_id;
    if (!id) {
      console.warn(
        `[e2e global setup] ${PAID_ONLINE_DOCUMENT_NUMBER} not found — run ` +
          '`TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/seed-e2e-portal-invoices.ts` ' +
          'then `pnpm seed:f5-e2e:reconciliation`',
      );
      return;
    }
    process.env.E2E_PAID_ONLINE_INVOICE_ID = id;
    console.log(`[e2e global setup] E2E_PAID_ONLINE_INVOICE_ID = ${PAID_ONLINE_DOCUMENT_NUMBER} (${id})`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Top the single-use F4 admin fixtures back up.
 *
 * `credit-note-full` AS1 credits a paid SC-2026-995xxx invoice, which spends
 * it. The seeder keeps THREE, so one pass over chromium + mobile-chrome costs
 * two and two consecutive runs exhaust the pool — after which the spec failed
 * on a bare locator timeout that reads like a selector break or a UI
 * regression. In R29 that cost an hour of bisecting a PR which had changed
 * nothing on that surface, and it is why the same spec was already red on
 * `main`. The spec's own note has named this fix since F4: "fold seeder into
 * tests/e2e/global-setup.ts" (PVR-1).
 *
 * Spawned rather than imported, because the seeder is a CLI that calls
 * `process.exit` at top level, and it owns logic no raw-SQL helper should
 * duplicate for a money fixture: it renders the invoice PDF, uploads the blob
 * and satisfies the `invoices_paid_has_receipt_status` CHECK (migration 0056).
 * `process.execPath` + tsx's own CLI keeps it cross-platform with no shell.
 *
 * Idempotent: with three unmutated invoices present it prints "skip" and
 * writes nothing, so the common case costs a few queries.
 */
function topUpAdminFixtures(): boolean {
  if (!process.env.DATABASE_URL) {
    console.warn('[e2e global setup] skipping F4 admin fixtures — DATABASE_URL missing');
    return false;
  }
  const out = execFileSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/seed-f4-e2e-admin-fixtures.ts'],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.scripts.json' },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  for (const line of out.split(/\r?\n/)) {
    if (/credit-target|pay-target|zero-rate-draft/.test(line)) {
      console.log(`[e2e global setup] F4 fixtures:${line.replace(/^\s+/, ' ')}`);
    }
  }
  return true;
}

async function globalSetup(): Promise<void> {
  // FIRST: compile the sign-in routes while nobody's test clock is running.
  await warmAdminRoutes();

  try {
    await clearE2ERateLimits();
    console.log('[e2e global setup] cleared Upstash rate-limit buckets');
  } catch (error) {
    // Don't fail the entire run if Upstash is unreachable — individual
    // specs can still handle rate-limit responses on their own.
    console.warn('[e2e global setup] rate-limit clear failed:', String(error));
  }

  try {
    await resetF5IssuedInvoice();
  } catch (error) {
    console.warn('[e2e global setup] F5 invoice reset failed:', String(error));
  }

  try {
    // Before any spec reads them: the credit-target pool is single-use.
    // Succeeds => the AS1 gate below can rely on the fixtures being present,
    // so it no longer depends on a hand-added .env.local flag (PVR-1).
    if (topUpAdminFixtures()) process.env.E2E_HAS_ADMIN_FIXTURES = '1';
  } catch (error) {
    console.warn('[e2e global setup] F4 admin fixture top-up failed:', String(error));
  }

  try {
    await resolvePaidOnlineInvoice();
  } catch (error) {
    console.warn('[e2e global setup] paid-online invoice lookup failed:', String(error));
  }

  try {
    const seed = await seedF7Broadcasts();
    if (seed) {
      // Worker processes inherit process.env from the parent process at
      // spawn time. Set the env vars BEFORE workers fork so every spec
      // sees them automatically.
      process.env.E2E_SEED_BROADCAST_ID = seed.broadcastId;
      process.env.E2E_SEED_HALTED_MEMBER_NAME = seed.haltedMemberDisplayName;
      // Also persist to a fixture file so workers that fork after env
      // mutation can re-read.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        '.e2e-seed.json',
        JSON.stringify(seed),
        'utf8',
      );
    }
  } catch (error) {
    console.warn('[e2e global setup] F7 broadcast seed failed:', String(error));
  }

  try {
    const renewalsSeed = await seedF8Renewals();
    if (renewalsSeed) {
      process.env.E2E_SEED_RENEWAL_CYCLE_ID = renewalsSeed.cycleId;
      process.env.E2E_SEED_RENEWAL_MEMBER_ID = renewalsSeed.memberId;
    }
  } catch (error) {
    console.warn('[e2e global setup] F8 renewals seed failed:', String(error));
  }

  try {
    const eventsSeed = await seedF6Events();
    if (eventsSeed) {
      process.env.E2E_SEED_F6_PB_EVENT_ID = eventsSeed.partnerBenefitEventId;
      process.env.E2E_SEED_F6_CULTURAL_EVENT_ID = eventsSeed.culturalEventId;
      process.env.E2E_SEED_F6_ARCHIVED_EVENT_ID = eventsSeed.archivedEventId;
    }
  } catch (error) {
    console.warn('[e2e global setup] F6 events seed failed:', String(error));
  }
}

export default globalSetup;
