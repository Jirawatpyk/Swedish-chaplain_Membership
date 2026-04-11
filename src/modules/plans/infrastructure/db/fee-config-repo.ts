/**
 * `FeeConfigRepo` — Drizzle + RLS implementation for per-tenant fee
 * configuration (currency, VAT rate, registration fee).
 *
 * Every query runs inside `runInTenant(tenant, ...)` so Postgres RLS
 * scopes the read / write to the active tenant without an explicit
 * `WHERE tenant_id = ?`. Currency immutability (critique R1) is
 * enforced one layer up by `update-fee-config` Application use case —
 * this repo accepts only the editable subset via `FeeConfigPatch`.
 */

import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { tenantFeeConfig } from './schema';
import type { FeeConfigRepo } from '../../application/ports';
import type { TenantFeeConfig } from '../../domain/fee-config';
import type { CurrencyCode } from '../../domain/money';
import { asTenantSlug } from '../../domain/plan';

type TenantFeeConfigRow = typeof tenantFeeConfig.$inferSelect;

function rowToDomain(row: TenantFeeConfigRow): TenantFeeConfig {
  return {
    tenant_id: asTenantSlug(row.tenantId),
    currency_code: row.currencyCode as CurrencyCode,
    // numeric(5,4) comes back as string from postgres.js — parseFloat is
    // safe here because the schema enforces the range [0, 1) and 4 digits.
    vat_rate: parseFloat(row.vatRate),
    registration_fee_minor_units: row.registrationFeeMinorUnits,
    updated_at: row.updatedAt,
    updated_by: row.updatedBy,
  };
}

export const feeConfigRepo: FeeConfigRepo = {
  async findByTenant(tenant) {
    return runInTenant(tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantFeeConfig)
        .limit(1);
      const row = rows[0];
      return row ? rowToDomain(row) : undefined;
    });
  },

  async update(tenant, patch, updatedBy) {
    return runInTenant(tenant, async (tx) => {
      const updateValues: Record<string, unknown> = {
        updatedBy,
        updatedAt: new Date(),
      };
      if (patch.vat_rate !== undefined) {
        // numeric(5,4) — format to 4 decimal places so Postgres accepts
        // the string cleanly without float-precision surprises.
        updateValues.vatRate = patch.vat_rate.toFixed(4);
      }
      if (patch.registration_fee_minor_units !== undefined) {
        updateValues.registrationFeeMinorUnits = patch.registration_fee_minor_units;
      }
      const updated = await tx
        .update(tenantFeeConfig)
        .set(updateValues)
        .where(eq(tenantFeeConfig.tenantId, tenant.slug))
        .returning();
      const row = updated[0];
      return row ? rowToDomain(row) : undefined;
    });
  },

  async upsert(tenant, row) {
    return runInTenant(tenant, async (tx) => {
      // Try insert; on conflict (row already exists), leave it alone and
      // return the existing row — idempotent by design (seed script P4).
      const inserted = await tx
        .insert(tenantFeeConfig)
        .values({
          tenantId: tenant.slug,
          currencyCode: row.currency_code,
          vatRate: row.vat_rate.toFixed(4),
          registrationFeeMinorUnits: row.registration_fee_minor_units,
          updatedBy: row.updated_by,
        })
        .onConflictDoNothing({ target: tenantFeeConfig.tenantId })
        .returning();
      if (inserted[0]) return rowToDomain(inserted[0]);
      // Row already existed — fetch it and return
      const existing = await tx
        .select()
        .from(tenantFeeConfig)
        .where(eq(tenantFeeConfig.tenantId, tenant.slug))
        .limit(1);
      return rowToDomain(existing[0]!);
    });
  },
};
