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
import { eq, sql } from 'drizzle-orm';
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

export function makeDrizzleTenantPaymentSettingsRepo(): TenantPaymentSettingsRepo {
  return {
    async getByTenantId(tenantId) {
      return unstable_cache(
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
      )();
    },

    async findByProcessorAccountId(processorAccountId) {
      return unstable_cache(
        async (): Promise<TenantPaymentSettings | null> => {
          // Bypass-RLS read: this is the webhook pre-resolution
          // path — by definition we do NOT yet know the tenant.
          // The row does not contain PII; processor_account_id
          // lookup is the whole point of this method.
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
      )();
    },
  };
}

/**
 * Admin settings write. Not part of the read port — composed
 * separately by the admin settings use-case (Phase 9). Runs inside
 * the caller-supplied `tx` (the admin use-case's `runInTenant`
 * transaction) so the audit row + settings row commit atomically.
 *
 * Cache invalidation is fired AFTER the tx closes — `revalidateTag`
 * is idempotent and side-effect-free, so calling it from inside the
 * tx callback is safe even if the tx later rolls back (worst case:
 * a single extra DB read on the next call, no data corruption).
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

  // Bust both cache tags. Next.js 16 `revalidateTag` requires a
  // cacheLife profile arg — `'default'` is the standard baseline.
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
