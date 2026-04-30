/**
 * Drizzle `MarketingUnsubscribesRepo` adapter (F7).
 *
 * Tenant-scoped suppression list. Idempotent upsert is the primary
 * write pattern (replaying an unsubscribe is safe — see FR-030).
 *
 * MVP scope (US1): only `findByEmailLower` + `lookupBatch` are exercised
 * (segment resolver suppression filter). `upsert` + `setMemberIdNull`
 * are wired for US4/US5 surfaces but compile-tested today.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  MarketingUnsubscribe,
  MarketingUnsubscribeReason,
} from '../../domain/marketing-unsubscribe';
import {
  asBroadcastId,
} from '../../domain/broadcast';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';
import type {
  MarketingUnsubscribesRepo,
  NewSuppressionInput,
} from '../../application/ports/marketing-unsubscribes-repo';
import {
  marketingUnsubscribes,
  type MarketingUnsubscribeRow,
} from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function rowToSuppression(row: MarketingUnsubscribeRow): MarketingUnsubscribe {
  return {
    tenantId: row.tenantId,
    emailLower: unsafeBrandEmailLower(row.emailLower),
    memberId: row.memberId,
    reason: row.reason as MarketingUnsubscribeReason,
    reasonText: row.reasonText,
    sourceBroadcastId:
      row.sourceBroadcastId === null
        ? null
        : asBroadcastId(row.sourceBroadcastId),
    sourceTokenHash: row.sourceTokenHash,
    unsubscribedAt: row.unsubscribedAt,
  };
}

export function makeDrizzleMarketingUnsubscribesRepo(
  tenantId: string,
): MarketingUnsubscribesRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async upsert(
      txUnknown,
      input: NewSuppressionInput,
    ): Promise<{
      readonly wasNew: boolean;
      readonly suppression: MarketingUnsubscribe;
    }> {
      const tx = txUnknown as TenantTx;
      const result = (await tx.execute(sql`
        INSERT INTO marketing_unsubscribes
          (tenant_id, email_lower, member_id, reason, reason_text,
           source_broadcast_id, source_token_hash)
        VALUES
          (${input.tenantId}, ${input.emailLower}, ${input.memberId},
           ${input.reason}::marketing_unsubscribe_reason, ${input.reasonText},
           ${input.sourceBroadcastId}, ${input.sourceTokenHash})
        ON CONFLICT (tenant_id, email_lower) DO UPDATE
          SET reason = EXCLUDED.reason,
              reason_text = EXCLUDED.reason_text,
              source_token_hash = COALESCE(EXCLUDED.source_token_hash, marketing_unsubscribes.source_token_hash)
        RETURNING *, (xmax = 0) AS was_new
      `)) as unknown as Array<MarketingUnsubscribeRow & { was_new: boolean }>;
      const row = result[0];
      if (!row) throw new Error('marketing_unsubscribes upsert returned no row');
      return { wasNew: row.was_new, suppression: rowToSuppression(row) };
    },

    async findByEmailLower(
      tenantIdArg: string,
      emailLower: EmailLower,
    ): Promise<MarketingUnsubscribe | null> {
      return runInTenant(ctx, async (tx) => {
        const [row] = await tx
          .select()
          .from(marketingUnsubscribes)
          .where(
            and(
              eq(marketingUnsubscribes.tenantId, tenantIdArg),
              eq(marketingUnsubscribes.emailLower, emailLower),
            ),
          )
          .limit(1);
        return row === undefined
          ? null
          : rowToSuppression(row as MarketingUnsubscribeRow);
      });
    },

    async lookupBatch(
      tenantIdArg: string,
      emailLowers: ReadonlyArray<EmailLower>,
    ): Promise<ReadonlySet<EmailLower>> {
      if (emailLowers.length === 0) return new Set();
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ emailLower: marketingUnsubscribes.emailLower })
          .from(marketingUnsubscribes)
          .where(
            and(
              eq(marketingUnsubscribes.tenantId, tenantIdArg),
              inArray(
                marketingUnsubscribes.emailLower,
                emailLowers as unknown as string[],
              ),
            ),
          );
        return new Set(rows.map((r) => unsafeBrandEmailLower(r.emailLower)));
      });
    },

    async setMemberIdNull(
      txUnknown,
      tenantIdArg: string,
      memberId: string,
    ): Promise<{ readonly affected: number }> {
      const tx = txUnknown as TenantTx;
      const result = (await tx.execute(sql`
        UPDATE marketing_unsubscribes
           SET member_id = NULL
         WHERE tenant_id = ${tenantIdArg}
           AND member_id = ${memberId}
        RETURNING email_lower
      `)) as unknown as Array<{ email_lower: string }>;
      return { affected: result.length };
    },
  };
}
