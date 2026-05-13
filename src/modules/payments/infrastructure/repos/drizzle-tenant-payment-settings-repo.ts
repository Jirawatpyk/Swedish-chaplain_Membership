/**
 * T063 — Drizzle tenant_payment_settings repo (F5).
 *
 * Implements `TenantPaymentSettingsRepo` with `unstable_cache` to
 * shelter the hot path — every `initiatePayment` and every webhook
 * delivery reads this row. TTL = 3600s (row mutates rarely, manual
 * admin edits only); callers hit stale state at most 1h, and every
 * settings write explicitly `revalidateTag`s both keys so the next
 * read rebuilds.
 *
 * Two cache tags:
 *   - `tenant_payment_settings:<tenantId>` — keyed by slug; hit by
 *     initiatePayment.
 *   - `tenant_payment_settings_by_account:<accountId>` — keyed by
 *     Stripe Connect account id; hit by the webhook tenant-resolver.
 *
 * Both tags are busted when `updateSettings` fires so stale-tag
 * reads cannot survive a processor-account-id rotation.
 */
// `revalidateTag` + `unstable_cache` are server-only APIs. Marking
// the module explicitly prevents Next.js 16 / Turbopack from emitting
// the misleading "imported in the Pages Router" build error when the
// dev-mode RSC graph walker touches this module through unrelated
// route-handler chains.
import 'server-only';
import { eq, sql } from 'drizzle-orm';
// Audit 2026-04-26 round-2 #4 REVERTED via self-review #R2-A3:
// kept on deprecated `unstable_cache()` because the `'use cache'`
// directive migration would (a) require enabling `cacheComponents:
// true` which forces Partial Prerendering across F1–F4 (out-of-
// scope audit), and (b) break vitest unit testability (directive
// throws outside Next.js runtime). Re-evaluate at F11 SaaS Billing
// when caching strategy is reconsidered holistically. See
// next.config.ts comment + `tests/integration/payments/tenant-payment-
// settings-cache.test.ts` for the empirical investigation.
import { revalidateTag, unstable_cache } from 'next/cache';
import type { TenantPaymentSettingsRepo } from '../../application/ports/tenant-payment-settings-repo';
import type {
  TenantPaymentSettings,
  Processor,
  ProcessorEnvironment,
} from '../../domain/tenant-payment-settings';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';
import {
  tenantPaymentSettings,
  type TenantPaymentSettingsRow,
} from '../schema';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function toDomain(row: TenantPaymentSettingsRow): TenantPaymentSettings {
  return {
    tenantId: row.tenantId,
    processor: row.processor as Processor,
    processorEnvironment: row.processorEnvironment as ProcessorEnvironment,
    processorAccountId: row.processorAccountId,
    processorPublishableKey: row.processorPublishableKey,
    enabledMethods: row.enabledMethods as readonly PaymentMethod[],
    onlinePaymentEnabled: row.onlinePaymentEnabled,
    autoEmailOnPayment: row.autoEmailOnPayment,
    promptpayQrExpirySeconds: row.promptpayQrExpirySeconds,
    allowAnonymousPaylink: row.allowAnonymousPaylink,
  };
}

/**
 * Input shape for the admin-side `updateSettings` path. Not part of
 * the Application port interface (the port is read-only today); the
 * admin use-case (Phase 9) will import this factory's companion
 * helper directly. Wired here so the cache-invalidation contract
 * lives next to the reads it invalidates.
 */
export interface UpdateTenantPaymentSettingsInput {
  readonly tenantId: string;
  readonly processorEnvironment?: ProcessorEnvironment;
  readonly processorAccountId?: string;
  readonly processorPublishableKey?: string;
  readonly enabledMethods?: readonly PaymentMethod[];
  readonly onlinePaymentEnabled?: boolean;
  readonly autoEmailOnPayment?: boolean;
  readonly promptpayQrExpirySeconds?: number;
  readonly allowAnonymousPaylink?: boolean;
  /** Previous processor_account_id (for cross-key cache invalidation). */
  readonly previousProcessorAccountId?: string;
}

// Audit 2026-04-25 finding #10 (followed up 2026-04-27 — T148 perf review):
// hoist cache wrapper factories to module scope AND memoise per-key so each
// call reuses the SAME `unstable_cache` instance for a given key.
//
// Previous shape (pre-2026-04-27): the factory function was at module scope
// but every invocation `cachedGetByTenantId(tenantId)` allocated a fresh
// `unstable_cache(...)` wrapper. The audit comment claimed instances were
// reused but the implementation only hoisted the FUNCTION, not the per-key
// wrapper. Each `getByTenantId(tenantId)` call paid:
//   - `unstable_cache(...)` constructor cost (allocates a closure + key array)
//   - Next.js's internal key-array hashing on every call to find the cached entry
// On a hot path that fires per-`initiatePayment` AND per-webhook, this is
// a measurable allocation profile. Real fix: memoise the wrapper PER KEY
// in a module-scoped Map. Cardinality is bounded by tenant count (≤ a few
// hundred over project lifetime); no leak risk.

type CachedReader = () => Promise<TenantPaymentSettings | null>;

const cachedGetByTenantIdMap = new Map<string, CachedReader>();
const cachedFindByProcessorAccountIdMap = new Map<string, CachedReader>();

function cachedGetByTenantId(tenantId: string): CachedReader {
  let wrapped = cachedGetByTenantIdMap.get(tenantId);
  if (wrapped) return wrapped;
  wrapped = unstable_cache(
    async (): Promise<TenantPaymentSettings | null> => {
      const ctx = asTenantContext(tenantId);
      return runInTenant(ctx, async (tx) => {
        const [row] = await tx
          .select()
          .from(tenantPaymentSettings)
          .where(eq(tenantPaymentSettings.tenantId, tenantId))
          .limit(1);
        return row ? toDomain(row as TenantPaymentSettingsRow) : null;
      });
    },
    ['tenant_payment_settings', tenantId],
    {
      tags: [`tenant_payment_settings:${tenantId}`],
      revalidate: 3600,
    },
  );
  cachedGetByTenantIdMap.set(tenantId, wrapped);
  return wrapped;
}

function cachedFindByProcessorAccountId(
  processorAccountId: string,
): CachedReader {
  let wrapped = cachedFindByProcessorAccountIdMap.get(processorAccountId);
  if (wrapped) return wrapped;
  wrapped = unstable_cache(
    async (): Promise<TenantPaymentSettings | null> => {
      // Bypass-RLS read by design: webhook pre-resolution lookup.
      // We don't yet know the tenant — `processor_account_id` IS
      // the lookup key. Row contains no PII (processor settings
      // + publishable key, which is also surfaced to the browser).
      const [row] = await db
        .select()
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.processorAccountId, processorAccountId))
        .limit(1);
      return row ? toDomain(row as TenantPaymentSettingsRow) : null;
    },
    ['tenant_payment_settings_by_account', processorAccountId],
    {
      tags: [`tenant_payment_settings_by_account:${processorAccountId}`],
      revalidate: 3600,
    },
  );
  cachedFindByProcessorAccountIdMap.set(processorAccountId, wrapped);
  return wrapped;
}

/**
 * Test-only escape hatch — clears the per-key wrapper memoisation so a
 * spec that swaps in a fresh fixture between cases doesn't read a stale
 * closure. Safe in production too (next call rebuilds), but no
 * production caller invokes it.
 */
export function __resetTenantPaymentSettingsRepoCache(): void {
  cachedGetByTenantIdMap.clear();
  cachedFindByProcessorAccountIdMap.clear();
}

export function makeDrizzleTenantPaymentSettingsRepo(): TenantPaymentSettingsRepo {
  return {
    async getByTenantId(tenantId) {
      return cachedGetByTenantId(tenantId)();
    },
    async findByProcessorAccountId(processorAccountId) {
      return cachedFindByProcessorAccountId(processorAccountId)();
    },
  };
}

/**
 * Admin settings write. Not part of the read port — composed
 * separately by the admin settings use-case (Phase 9). Runs inside
 * the caller-supplied `tx` (the admin use-case's `runInTenant`
 * transaction) so the audit row + settings row commit atomically.
 *
 * Cache invalidation: `revalidateTag` HAS side effects (it busts the
 * cache key) but those side effects are SAFE under tx rollback. If the
 * outer tx rolls back, the next read after invalidation rebuilds from
 * the unchanged DB row — same data, just without the cached copy.
 * Worst case: a single extra DB round-trip. Audit 2026-04-25 finding
 * #8 — comment was previously misleading ("idempotent and side-effect-
 * free"); side-effect-free is wrong, but the rollback safety claim
 * remains correct.
 */
export async function updateTenantPaymentSettings(
  txUnknown: unknown,
  input: UpdateTenantPaymentSettingsInput,
): Promise<void> {
  const tx = txUnknown as TenantTx;

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.processorEnvironment !== undefined) {
    patch.processorEnvironment = input.processorEnvironment;
  }
  if (input.processorAccountId !== undefined) {
    patch.processorAccountId = input.processorAccountId;
  }
  if (input.processorPublishableKey !== undefined) {
    patch.processorPublishableKey = input.processorPublishableKey;
  }
  if (input.enabledMethods !== undefined) {
    patch.enabledMethods = input.enabledMethods;
  }
  if (input.onlinePaymentEnabled !== undefined) {
    patch.onlinePaymentEnabled = input.onlinePaymentEnabled;
  }
  if (input.autoEmailOnPayment !== undefined) {
    patch.autoEmailOnPayment = input.autoEmailOnPayment;
  }
  if (input.promptpayQrExpirySeconds !== undefined) {
    patch.promptpayQrExpirySeconds = input.promptpayQrExpirySeconds;
  }
  if (input.allowAnonymousPaylink !== undefined) {
    patch.allowAnonymousPaylink = input.allowAnonymousPaylink;
  }

  await tx
    .update(tenantPaymentSettings)
    .set(patch)
    .where(eq(tenantPaymentSettings.tenantId, input.tenantId));

  // Bust both cache tags. Next.js 16 `revalidateTag(tag, profile)` —
  // `'default'` is the standard cacheLife baseline.
  revalidateTag(`tenant_payment_settings:${input.tenantId}`, 'default');
  if (input.previousProcessorAccountId !== undefined) {
    revalidateTag(
      `tenant_payment_settings_by_account:${input.previousProcessorAccountId}`,
      'default',
    );
  }
  if (
    input.processorAccountId !== undefined &&
    input.processorAccountId !== input.previousProcessorAccountId
  ) {
    revalidateTag(
      `tenant_payment_settings_by_account:${input.processorAccountId}`,
      'default',
    );
  }
}
