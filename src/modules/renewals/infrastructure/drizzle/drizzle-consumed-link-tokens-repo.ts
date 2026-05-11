/**
 * F8 Phase 5 Wave A · T119 — Drizzle adapter for `ConsumedLinkTokensRepo`.
 *
 * Implements atomic single-use enforcement against the
 * `consumed_link_tokens` table (migration 0093 + schema-consumed-link-tokens.ts).
 * The PK `(tenant_id, token_sha256)` makes "claim this token" a single
 * INSERT…ON CONFLICT DO NOTHING — the DB serialises concurrent attempts
 * naturally; no advisory lock needed.
 *
 * Tenant isolation: `runInTenant(tenant, …)` wraps every call. The
 * `tenant_id` column is set from `tenant.slug` (closure binding), and
 * the table's RLS+FORCE policy validates the row against
 * `app.current_tenant` — defence-in-depth per Constitution Principle I.
 *
 * Edge case — RLS-hidden conflict: if a token sha256 exists for tenant
 * X but the request was bound to tenant Y, the upstream verifier would
 * have rejected with `tenant_mismatch` long before this adapter runs.
 * If it somehow gets here, the INSERT under tenant Y's RLS will succeed
 * for tenant Y (different PK row in the same table), so two distinct
 * rows can coexist with the same token_sha256 across tenants. This is
 * by design — tokens are per-tenant by construction.
 */
import { and, eq, lt } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { consumedLinkTokens } from '../schema-consumed-link-tokens';
import type {
  ConsumedLinkTokensRepo,
  MarkConsumedResult,
} from '../../application/ports/consumed-link-tokens-repo';

export function makeDrizzleConsumedLinkTokensRepo(
  tenant: TenantContext,
): ConsumedLinkTokensRepo {
  return {
    async markConsumed(input): Promise<MarkConsumedResult> {
      // Caller passes a Uint8Array; bytea customType expects Buffer.
      const tokenSha256Buf = Buffer.from(input.tokenSha256);
      return runInTenant(tenant, async (tx) => {
        const inserted = await tx
          .insert(consumedLinkTokens)
          .values({
            tenantId: tenant.slug,
            tokenSha256: tokenSha256Buf,
            consumedByMemberId: input.consumedByMemberId,
            cycleId: input.cycleId,
          })
          .onConflictDoNothing({
            target: [
              consumedLinkTokens.tenantId,
              consumedLinkTokens.tokenSha256,
            ],
          })
          .returning({ consumedAt: consumedLinkTokens.consumedAt });

        if (inserted.length === 1) {
          return { status: 'fresh', consumedAt: inserted[0]!.consumedAt };
        }

        // Conflict — read the existing row's consumedAt for the audit
        // breadcrumb. If RLS hides the row (cross-tenant which we've
        // already rejected upstream) we still return `replay` rather
        // than retry — the verifier's tenant-mismatch path is the
        // canonical signal there.
        const existing = await tx
          .select({ consumedAt: consumedLinkTokens.consumedAt })
          .from(consumedLinkTokens)
          .where(
            and(
              eq(consumedLinkTokens.tenantId, tenant.slug),
              eq(consumedLinkTokens.tokenSha256, tokenSha256Buf),
            ),
          )
          .limit(1);

        const firstConsumedAt = existing[0]?.consumedAt ?? new Date();
        return { status: 'replay', firstConsumedAt };
      });
    },

    async pruneOlderThan(cutoff): Promise<{ readonly pruned: number }> {
      // Phase 9 retrofit — weekly housekeeping. DELETE scoped to the
      // current tenant by RLS+FORCE (no explicit `WHERE tenant_id`
      // predicate; the policy is the canonical scope per Round 6
      // S-R5-6 convention used across renewals adapters). Returns
      // count of affected rows for the cron-job.org dashboard summary.
      //
      // Idempotency note: re-running with the same `cutoff` returns 0
      // pruned (rows already deleted on the prior pass). Cron retry-
      // storms are safe.
      //
      // PR #25 review-fix Round 1 (2026-05-11): use `.returning()` to
      // get the deleted-row count deterministically. Drizzle's
      // postgres-js driver does NOT expose a usable `rowCount` field
      // on bare `.delete().where(...)` calls (the field exists on the
      // raw result but is shaped differently across driver versions —
      // both integration tests asserting `pruned === 1` failed with
      // pruned=0 before this fix). The codebase convention (e.g.,
      // `session-repo.ts:95-97`) is to use `.returning({ id: ... })`
      // and count the resulting array. tokenSha256 is projected as
      // the cheapest unique key here.
      return runInTenant(tenant, async (tx) => {
        const deleted = await tx
          .delete(consumedLinkTokens)
          .where(lt(consumedLinkTokens.consumedAt, cutoff))
          .returning({ tokenSha256: consumedLinkTokens.tokenSha256 });
        return { pruned: deleted.length };
      });
    },
  };
}
