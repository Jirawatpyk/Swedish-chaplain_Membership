/**
 * F8 Phase 5 / Staff-Review-2026-05-09 T277f closure — lapse-cycles
 * cron coordinator HTTP route E2E.
 *
 * The K24 wave shipped unit + integration coverage for the
 * `lapseCyclesOnGraceExpiry` use-case (both `grace_expired` and
 * `payment_failed` decision branches + TOCTOU race-skip), but no
 * E2E test exercised the cron HTTP route end-to-end (HTTP →
 * coordinator → per-tenant → DB transition). This is the primary
 * production path that writes `cycle.status = 'lapsed'` — every
 * downstream surface (Lapsed tab, reactivation flow, portal scope
 * enforcement) depends on it.
 *
 * Mirrors the cron-route E2E pattern. Hits the coordinator endpoint
 * with the Bearer token directly via Playwright's `request` fixture
 * (NOT a browser flow — this is an HTTP API contract test using the
 * Playwright runtime so we share env-var + skip semantics with the
 * other E2E specs).
 *
 * Verifies:
 *   1. 401 without Bearer
 *   2. 401 with wrong Bearer
 *   3. 200 + `skipped: true` when FEATURE_F8_RENEWALS=false
 *   4. 200 + canonical response shape when FEATURE_F8_RENEWALS=true
 *      (tenants_enqueued / tenants_succeeded / per_tenant_results)
 *
 * Does NOT seed a fresh past-grace cycle here — the response shape
 * verification is sufficient at the HTTP-route layer because the
 * underlying state-transition + audit atomicity is covered by
 * `tests/integration/renewals/lapse-cycles-on-grace-expiry.test.ts`
 * on live Neon. Adding a seeded past-grace cycle to E2E would
 * duplicate live-DB state across two test surfaces.
 *
 * Gate: env vars `CRON_SECRET` + `FEATURE_F8_RENEWALS` required.
 *
 * Run: `pnpm test:e2e --grep "lapse-cycles-cron" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers).
 */
import { expect, test } from './fixtures';

const CRON_SECRET = process.env.CRON_SECRET;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';
const COORDINATOR_PATH =
  '/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator';

test.describe('F8 — lapse-cycles cron coordinator HTTP route (T277f)', () => {
  test.beforeAll(() => {
    if (!CRON_SECRET) {
      throw new Error(
        'CRON_SECRET missing — set in .env.local before running this suite.',
      );
    }
  });

  test('rejects 401 when no Bearer header is present', async ({ request }) => {
    const res = await request.post(COORDINATOR_PATH);
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe('unauthorized');
  });

  test('rejects 401 with wrong Bearer token', async ({ request }) => {
    const res = await request.post(COORDINATOR_PATH, {
      headers: { Authorization: 'Bearer not-the-real-secret' },
    });
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe('unauthorized');
  });

  // Staff-Review-2026-05-09 R2-W4 fix: split the previous combined
  // shape test into 2 dedicated `test()` blocks so neither path
  // silently no-ops via early `return`. Each test now uses
  // `test.skip(precondition)` to opt into the relevant CI scenario:
  //
  //   - feature flag DISABLED → asserts the early-return shape
  //   - feature flag ENABLED  → asserts per-tenant fan-out canonical shape
  //
  // Previously both branches lived in one `it()` and the disabled-flag
  // CI run silently skipped the canonical-shape assertions.

  test('returns 200 + skipped when feature flag disabled', async ({
    request,
  }) => {
    test.skip(
      F8_RENEWALS_ENABLED,
      'FEATURE_F8_RENEWALS=true — covered by the canonical-shape test below',
    );
    const res = await request.post(COORDINATOR_PATH, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe('feature_flag_disabled');
  });

  test('returns 200 + canonical per-tenant shape when feature flag enabled', async ({
    request,
  }) => {
    test.skip(
      !F8_RENEWALS_ENABLED,
      'FEATURE_F8_RENEWALS=false — covered by the skipped test above',
    );
    const res = await request.post(COORDINATOR_PATH, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();

    // The canonical response shape includes per-tenant fan-out results.
    // The fields below are required by the observability runbook
    // (`docs/runbooks/cron-jobs.md`) — the SRE alert dashboards key off
    // `tenants_with_errors > 0` and `tenants_failed > 0`.
    expect(typeof json.tenants_enqueued).toBe('number');
    expect(typeof json.tenants_succeeded).toBe('number');
    expect(typeof json.tenants_failed).toBe('number');
    expect(typeof json.tenants_with_errors).toBe('number');
    expect(typeof json.duration_ms).toBe('number');
    expect(Array.isArray(json.per_tenant_results)).toBe(true);

    // Sanity: tenants_succeeded + tenants_failed === tenants_enqueued.
    expect(json.tenants_succeeded + json.tenants_failed).toBe(
      json.tenants_enqueued,
    );

    // Each per-tenant result has tenant_id; if not skipped, has the
    // outcome counters.
    for (const r of json.per_tenant_results) {
      expect(typeof r.tenant_id).toBe('string');
      if (!r.error && !r.skipped) {
        expect(typeof r.cycles_processed).toBe('number');
        expect(typeof r.grace_expired).toBe('number');
        expect(typeof r.payment_failed).toBe('number');
        expect(typeof r.transition_race_skipped).toBe('number');
        // 065 §5.2 (final-review V8) — the deferred branches are the bulk
        // of cycles_processed under the due+60 clock; without them the
        // operator surface cannot verify the SC sum invariant below.
        expect(typeof r.deferred_invoice_not_due).toBe('number');
        expect(typeof r.deferred_within_termination_window).toBe('number');
        expect(typeof r.deferred_no_invoice_backstop).toBe('number');
        // 066 (3.2(3)) - dormancy-guard deferrals join the invariant.
        expect(typeof r.deferred_no_prior_warning).toBe('number');
        expect(typeof r.deferred_guard_errors).toBe('number');
        expect(typeof r.errors).toBe('number');
        // SC sum invariant — every evaluated cycle lands in exactly one
        // outcome bucket.
        expect(
          r.grace_expired +
            r.payment_failed +
            r.transition_race_skipped +
            r.deferred_invoice_not_due +
            r.deferred_within_termination_window +
            r.deferred_no_invoice_backstop +
            r.deferred_no_prior_warning +
            r.deferred_guard_errors +
            r.errors,
        ).toBe(r.cycles_processed);
      }
    }
  });
});
