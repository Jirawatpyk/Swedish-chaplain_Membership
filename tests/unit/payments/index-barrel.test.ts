/**
 * E3 — Public barrel contract test for `@/modules/payments`.
 *
 * Hardens Constitution Principle III boundary:
 *   - Only the DECLARED public API is exported (no accidental leaks).
 *   - Ports, Infrastructure modules, and Drizzle schema stay INTERNAL.
 *   - The 6 composition-root factories return the correct Deps shape
 *     (presence-of-key assertion; full behaviour lives in integration
 *     tests that touch live Stripe / Neon).
 *
 * Runs against the real barrel + real DI module — NO mocks — because
 * the whole point is to verify the wire-up graph that Group F route
 * handlers will consume.
 */
import { describe, it, expect } from 'vitest';

describe('payments barrel — public API contract', () => {
  // Barrel smoke-tests resolve 30+ transitive `@/` aliases at runtime.
  // Under full-parallel run (~150 files) isolated-run ~2s scales to
  // 10-15s; bump per-test timeout to 30s so CPU contention on dev
  // laptops does not flake the suite. Isolated barrel-only runs
  // complete at ~1.8s — this timeout is a ceiling, not a target.
  it('exposes every expected Domain + Application + composition-root export', { timeout: 30_000 }, async () => {
    const mod = await import('@/modules/payments');

    // --- Domain ---------------------------------------------------------
    expect(mod.SYSTEM_ACTOR_STRIPE_WEBHOOK).toBeDefined();
    expect(mod.PAYMENT_METHODS).toBeDefined();
    expect(mod.PAYMENT_STATUSES).toBeDefined();
    expect(mod.TERMINAL_PAYMENT_STATUSES).toBeDefined();
    expect(typeof mod.asPaymentId).toBe('function');
    expect(typeof mod.parsePaymentId).toBe('function');
    expect(typeof mod.parsePaymentMethod).toBe('function');
    expect(typeof mod.isTerminalPaymentStatus).toBe('function');
    expect(typeof mod.isAllowed).toBe('function');

    // --- Application use-cases ------------------------------------------
    expect(typeof mod.initiatePayment).toBe('function');
    expect(typeof mod.processWebhookEvent).toBe('function');
    expect(typeof mod.confirmPayment).toBe('function');
    expect(typeof mod.failPayment).toBe('function');
    expect(typeof mod.cancelPayment).toBe('function');
    expect(typeof mod.handleCancelEvent).toBe('function');

    // --- Composition-root factories (Group E3 real wiring) --------------
    expect(typeof mod.makeInitiatePaymentDeps).toBe('function');
    expect(typeof mod.makeProcessWebhookEventDeps).toBe('function');
    expect(typeof mod.makeConfirmPaymentDeps).toBe('function');
    expect(typeof mod.makeFailPaymentDeps).toBe('function');
    expect(typeof mod.makeCancelPaymentDeps).toBe('function');
    expect(typeof mod.makeHandleCancelEventDeps).toBe('function');
  });

  it('does NOT expose ports, infrastructure adapters, or Drizzle schema', async () => {
    const mod = (await import('@/modules/payments')) as Record<string, unknown>;

    // Negative assertions — forbidden exports (Principle III).
    const forbidden = [
      // Concrete adapters (belong to Infrastructure)
      'stripeGateway',
      'invoicingBridge',
      'f5AuditAdapter',
      'makeDrizzlePaymentsRepo',
      'makeDrizzleProcessorEventsRepo',
      'makeDrizzleTenantPaymentSettingsRepo',
      // Drizzle schema values (Infrastructure internal)
      'payments',
      'refunds',
      'processorEvents',
      'tenantPaymentSettings',
      // Stripe SDK client (would leak PCI-scoped dependency)
      'getStripeClient',
      // Internal test hook (must stay private)
      '__internal',
    ];

    for (const name of forbidden) {
      expect(
        mod[name],
        `barrel MUST NOT re-export '${name}' — Principle III boundary`,
      ).toBeUndefined();
    }
  });

  it('composition factories return the expected Deps keys', async () => {
    const mod = await import('@/modules/payments');

    // InitiatePaymentDeps shape
    const initDeps = mod.makeInitiatePaymentDeps('test-tenant');
    expect(Object.keys(initDeps).sort()).toEqual(
      [
        'audit',
        'clock',
        'generatePaymentId',
        'idempotencyKeyFactory',
        'invoicingBridge',
        'paymentsRepo',
        'processorGateway',
        'tenantSettingsRepo',
      ].sort(),
    );

    // ProcessWebhookEventDeps shape (audit 2026-04-25 finding #5: +logger)
    const webhookDeps = mod.makeProcessWebhookEventDeps('test-tenant');
    expect(Object.keys(webhookDeps).sort()).toEqual(
      [
        'audit',
        'clock',
        'invoicingBridge',
        'logger',
        'paymentsRepo',
        'processorEventsRepo',
        'processorGateway',
        'refundsRepo',
        'tenantSettingsRepo',
      ].sort(),
    );

    // ConfirmPaymentDeps shape (audit 2026-04-25 finding #4:
    // +processorEventsRepo for atomic markProcessed; review-20260428-102639.md
    // H2 closure: +logger for Phase B stale-refund warn)
    const confirmDeps = mod.makeConfirmPaymentDeps('test-tenant');
    expect(Object.keys(confirmDeps).sort()).toEqual(
      [
        'audit',
        'clock',
        'invoicingBridge',
        'logger',
        'paymentsRepo',
        'processorEventsRepo',
        'processorGateway',
        'tenantSettingsRepo',
      ].sort(),
    );

    // FailPaymentDeps shape (audit 2026-04-25 finding #4)
    const failDeps = mod.makeFailPaymentDeps('test-tenant');
    expect(Object.keys(failDeps).sort()).toEqual(
      [
        'audit',
        'clock',
        'paymentsRepo',
        'processorEventsRepo',
        'processorGateway',
        'tenantSettingsRepo',
      ].sort(),
    );

    // CancelPaymentDeps shape (T059 — member-initiated; no webhook
    // event id so no processorEventsRepo needed)
    const cancelDeps = mod.makeCancelPaymentDeps('test-tenant');
    expect(Object.keys(cancelDeps).sort()).toEqual(
      [
        'audit',
        'clock',
        'paymentsRepo',
        'processorGateway',
        'tenantSettingsRepo',
      ].sort(),
    );

    // HandleCancelEventDeps shape (audit 2026-04-25 finding #4)
    const hceDeps = mod.makeHandleCancelEventDeps('test-tenant');
    expect(Object.keys(hceDeps).sort()).toEqual(
      ['audit', 'clock', 'paymentsRepo', 'processorEventsRepo'].sort(),
    );
  });

  it('generatePaymentId produces IDs that parse back via Domain parser', async () => {
    const mod = await import('@/modules/payments');
    const deps = mod.makeInitiatePaymentDeps('test-tenant');
    const id = deps.generatePaymentId();
    // Brand cast → opaque string; round-trip through parsePaymentId.
    const parsed = mod.parsePaymentId(String(id));
    expect(parsed.ok).toBe(true);
  });
});
