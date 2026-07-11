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

/**
 * Shared idempotent suppression upsert — the strength-precedence + bug #11
 * reason_text handling — so BOTH the caller-tx `upsert` (MVP webhook + public
 * unsubscribe paths) and the self-tx `upsertStandalone` (bug #10 batch-webhook
 * path, which has no caller tx) run byte-identical SQL from one place.
 *
 * Strength order (higher wins): complaint(4) > hard_bounce(3) > admin_added(2)
 * > recipient_initiated(1). Never DOWNGRADE a stronger classification. A strict
 * upgrade takes the new reason's text (even NULL); equal strength keeps the
 * latest non-null text.
 */
/**
 * Suppression-reason strength rank as a SQL fragment (higher wins):
 * complaint(4) > hard_bounce(3) > admin_added(2) > recipient_initiated(1).
 * Extracted once (re-review finding #13) so the ladder is defined in a single
 * place instead of being inlined 6× across the reason / reason_text CASE
 * expressions below. `reasonRef` is a trusted, constant identifier fragment
 * (`EXCLUDED.reason` or `marketing_unsubscribes.reason`) — never user input.
 */
function reasonRank(reasonRef: ReturnType<typeof sql>): ReturnType<typeof sql> {
  return sql`(CASE ${reasonRef}
                WHEN 'complaint' THEN 4 WHEN 'hard_bounce' THEN 3
                WHEN 'admin_added' THEN 2 ELSE 1 END)`;
}
// Fresh fragments per call site (do not reuse one SQL object across positions).
const newRank = (): ReturnType<typeof sql> => reasonRank(sql`EXCLUDED.reason`);
const oldRank = (): ReturnType<typeof sql> =>
  reasonRank(sql`marketing_unsubscribes.reason`);

async function executeSuppressionUpsert(
  tx: TenantTx,
  input: NewSuppressionInput,
): Promise<{
  readonly wasNew: boolean;
  readonly suppression: MarketingUnsubscribe;
}> {
  const result = (await tx.execute(sql`
        INSERT INTO marketing_unsubscribes
          (tenant_id, email_lower, member_id, reason, reason_text,
           source_broadcast_id, source_token_hash)
        VALUES
          (${input.tenantId}, ${input.emailLower}, ${input.memberId},
           ${input.reason}::marketing_unsubscribe_reason, ${input.reasonText},
           ${input.sourceBroadcastId}, ${input.sourceTokenHash})
        ON CONFLICT (tenant_id, email_lower) DO UPDATE
          SET reason = CASE
                WHEN ${newRank()} >= ${oldRank()}
                THEN EXCLUDED.reason
                ELSE marketing_unsubscribes.reason
              END,
              reason_text = CASE
                -- Strict UPGRADE (new reason stronger): take the NEW reason's
                -- text — even if NULL. Keeping the old weaker reason's text
                -- would mislabel a stronger classification (e.g. a spam
                -- complaint annotated with the prior hard-bounce SMTP
                -- diagnostic) — code-review fix 2026-07-11.
                WHEN ${newRank()} > ${oldRank()}
                THEN EXCLUDED.reason_text
                -- EQUAL strength: latest non-null text wins, keep prior if the
                -- new event carries none.
                WHEN ${newRank()} = ${oldRank()}
                THEN COALESCE(EXCLUDED.reason_text, marketing_unsubscribes.reason_text)
                -- DOWNGRADE: keep the stronger prior reason + its text.
                ELSE marketing_unsubscribes.reason_text
              END,
              source_token_hash = COALESCE(EXCLUDED.source_token_hash, marketing_unsubscribes.source_token_hash)
        RETURNING *, (xmax = 0) AS was_new
      `)) as unknown as Array<MarketingUnsubscribeRow & { was_new: boolean }>;
  const row = result[0];
  if (!row) throw new Error('marketing_unsubscribes upsert returned no row');
  return { wasNew: row.was_new, suppression: rowToSuppression(row) };
}

export function makeDrizzleMarketingUnsubscribesRepo(
  tenantId: string,
): MarketingUnsubscribesRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async upsert(txUnknown, input: NewSuppressionInput) {
      return executeSuppressionUpsert(txUnknown as TenantTx, input);
    },

    async upsertStandalone(input: NewSuppressionInput) {
      // Bug #10 (code-review, 2026-07-11) — the batch webhook path
      // (applyBatchWebhookEvent) has no caller tx; open our own tenant-scoped
      // tx so multi-batch broadcasts suppress recipients too (FR-027/FR-030).
      return runInTenant(ctx, (tx) => executeSuppressionUpsert(tx, input));
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
