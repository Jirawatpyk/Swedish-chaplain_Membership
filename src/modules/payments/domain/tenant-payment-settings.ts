/**
 * T050 — TenantPaymentSettings value object (F5).
 *
 * Per-tenant configuration governing processor environment, publishable
 * key, processor account id, enabled methods, and behavioural flags.
 * Matches `tenant_payment_settings` table (migration 0035 + data-model.md
 * § 4). Secret processor keys are NEVER stored here — env vars only.
 *
 * `allowAnonymousPaylink` is a forward-compat flag (FR-016a) for the
 * future "admin shares a paylink that doesn't require member sign-in"
 * flow (post-MVP); in F5 Phase 3 it is always false.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { PAYMENT_METHODS, type PaymentMethod } from './value-objects/payment-method';

export const PROCESSOR_ENVIRONMENTS = ['test', 'live'] as const;
export type ProcessorEnvironment = (typeof PROCESSOR_ENVIRONMENTS)[number];

export const PROCESSORS = ['stripe'] as const;
export type Processor = (typeof PROCESSORS)[number];

export interface TenantPaymentSettings {
  readonly tenantId: string;
  readonly processor: Processor;
  readonly processorEnvironment: ProcessorEnvironment;
  readonly processorAccountId: string;
  readonly processorPublishableKey: string;      // pk_test_… / pk_live_…

  /** Subset of PAYMENT_METHODS; at least one if onlinePaymentEnabled. */
  readonly enabledMethods: readonly PaymentMethod[];

  /** Global kill switch — empty empty-state fallback when false (FR-030). */
  readonly onlinePaymentEnabled: boolean;

  /** Per-tenant override of F4's auto_email_on_issue for payment path. */
  readonly autoEmailOnPayment: boolean;

  /** QR expiry override (default 900 s = 15 min). Range enforced by DB. */
  readonly promptpayQrExpirySeconds: number;

  /** FR-016a forward-compat — always false in F5 Phase 3. */
  readonly allowAnonymousPaylink: boolean;
}

// ---------------------------------------------------------------------------
// Policy helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Is the settings row structurally complete enough to initiate a
 * payment? FR-016 requires all four of processorAccountId,
 * processorPublishableKey, non-empty enabledMethods, and
 * onlinePaymentEnabled. Returns a typed error on partial config so the
 * route can map to HTTP 422 `tenant_settings_incomplete`.
 */
export type SettingsIncompleteReason =
  | 'online_payment_disabled'
  | 'missing_processor_account_id'
  | 'missing_publishable_key'
  | 'no_enabled_methods'
  | 'key_environment_mismatch';

export function assertSettingsComplete(
  s: TenantPaymentSettings,
): { ok: true } | { ok: false; reason: SettingsIncompleteReason } {
  if (!s.onlinePaymentEnabled) {
    return { ok: false, reason: 'online_payment_disabled' };
  }
  if (s.processorAccountId.length === 0) {
    return { ok: false, reason: 'missing_processor_account_id' };
  }
  if (s.processorPublishableKey.length === 0) {
    return { ok: false, reason: 'missing_publishable_key' };
  }
  if (s.enabledMethods.length === 0) {
    return { ok: false, reason: 'no_enabled_methods' };
  }
  // reliability-guardian F-04: pk_live_ MUST NOT ride on test env (and
  // vice-versa). Caught here so route returns a typed 422 instead of a
  // Stripe-API-side 4xx that leaks less context to support.
  if (!isPublishableKeyConsistent(s)) {
    return { ok: false, reason: 'key_environment_mismatch' };
  }
  return { ok: true };
}

/**
 * Guard for route-handler's `method_not_enabled` 409 path. The method
 * argument comes from the zod-validated request body.
 */
export function isMethodEnabled(
  s: TenantPaymentSettings,
  method: PaymentMethod,
): boolean {
  return (s.enabledMethods as readonly string[]).includes(method);
}

/**
 * Publishable-key environment invariant: `pk_live_…` MUST pair with
 * `processorEnvironment === 'live'` (and likewise `pk_test_…` with
 * `'test'`). A mismatch would expose live-mode capture from a test-mode
 * tenant row (or vice versa). Cross-checked again at the Stripe SDK
 * boundary, but caught here first so we can return a typed error.
 */
export function isPublishableKeyConsistent(s: TenantPaymentSettings): boolean {
  // Exhaustive switch (architect C-3, 2026-04-23): if a future env
  // (e.g. `'sandbox'`) is added to PROCESSOR_ENVIRONMENTS, the `never`
  // arm forces a compiler error here so this predicate MUST be updated
  // in lockstep — prevents a silent "always consistent" false positive.
  switch (s.processorEnvironment) {
    case 'live':
      return s.processorPublishableKey.startsWith('pk_live_');
    case 'test':
      return s.processorPublishableKey.startsWith('pk_test_');
    /* c8 ignore start — TS-exhaustive default; unreachable at runtime */
    default: {
      const _exhaustive: never = s.processorEnvironment;
      return _exhaustive;
    }
    /* c8 ignore stop */
  }
}

/** Re-export the canonical method set for repository mapping convenience. */
export { PAYMENT_METHODS };
