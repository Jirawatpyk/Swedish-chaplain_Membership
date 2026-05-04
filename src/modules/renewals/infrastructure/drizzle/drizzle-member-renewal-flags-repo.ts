/**
 * F8 Phase 4 Wave I2b — Drizzle adapter for `MemberRenewalFlagsRepo`.
 *
 * Implements the F8-internal port `MemberRenewalFlagsRepo` against the
 * F3 `members` table. F3 OWNS the schema (Phase 2 Wave C migration
 * 0094 added `email_unverified` BOOLEAN + `email_unverified_at`
 * TIMESTAMPTZ); F8 OWNS the lifecycle:
 *
 *   - T090 detect-bounce-threshold (Wave I2d) → `setEmailUnverified`
 *   - T091 reset-email-unverified (this wave) → `clearEmailUnverified`
 *
 * Tenant isolation is enforced by F3's RLS policy on `members` —
 * every method wraps its query in `runInTenant(ctx, …)` which sets
 * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`.
 * NO explicit `WHERE tenant_id = ?` — the policy adds it automatically
 * (research.md § 7.1).
 *
 * Cross-module deep-import precedent: `drizzle-renewal-cycle-repo.ts`
 * line 26 imports F3's `members` schema for the LEFT JOIN to surface
 * `company_name`. This adapter follows the same convention.
 */
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type {
  MemberRenewalFlagsRepo,
  MemberRenewalFlagsMutationResult,
} from '../../application/ports/member-renewal-flags-repo';

export function makeDrizzleMemberRenewalFlagsRepo(
  // RLS does the tenant binding via runInTenant at the use-case layer;
  // this adapter receives only the tx + memberId and writes via the
  // members table directly. The tenant param is reserved for future
  // safety assertions or per-tenant adapter caching (consumed by the
  // companion `WithTenant` factory below).
  _tenant: TenantContext,
): MemberRenewalFlagsRepo {
  return {
    async setEmailUnverified(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberRenewalFlagsMutationResult> {
      const txDb = tx as typeof db;
      // First read the prior state inside the same tx so the
      // `previouslyUnverified` answer reflects a consistent snapshot
      // even under concurrent writes (the read + write commit together).
      const priorRows = await txDb
        .select({ emailUnverified: members.emailUnverified })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previouslyUnverified: false, affectedRows: 0 };
      }
      const wasAlreadyUnverified = prior.emailUnverified;
      // Idempotent — if the flag is already TRUE, preserve the original
      // `email_unverified_at` timestamp (don't reset on each bounce).
      if (wasAlreadyUnverified) {
        return { previouslyUnverified: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          emailUnverified: true,
          emailUnverifiedAt: new Date(),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return {
        previouslyUnverified: false,
        affectedRows: updated.length,
      };
    },

    async clearEmailUnverified(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberRenewalFlagsMutationResult> {
      const txDb = tx as typeof db;
      // Read prior state for the previouslyUnverified flag.
      const priorRows = await txDb
        .select({ emailUnverified: members.emailUnverified })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previouslyUnverified: false, affectedRows: 0 };
      }
      const wasUnverified = prior.emailUnverified;
      // Always issue the UPDATE so `email_unverified_at` is cleared
      // even on the rare "row exists but flag already false" case
      // (defensive — a future code path that forgets to NULL the
      // timestamp would leave a stale `email_unverified_at`).
      const updated = await txDb
        .update(members)
        .set({
          emailUnverified: false,
          emailUnverifiedAt: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return {
        previouslyUnverified: wasUnverified,
        affectedRows: updated.length,
      };
    },
  };
}

/**
 * Convenience wrapper that opens a `runInTenant` block for callers
 * that don't already have a tx (e.g., tests + ad-hoc scripts). The
 * use-case path always supplies an outer tx via `runInTenant` →
 * tx parameter, so this wrapper is rarely needed in production code.
 */
export function makeDrizzleMemberRenewalFlagsRepoWithTenant(
  tenant: TenantContext,
): MemberRenewalFlagsRepo & {
  clearEmailUnverifiedInTenant: (
    memberId: string,
  ) => Promise<MemberRenewalFlagsMutationResult>;
} {
  const base = makeDrizzleMemberRenewalFlagsRepo(tenant);
  return {
    ...base,
    async clearEmailUnverifiedInTenant(memberId: string) {
      return runInTenant(tenant, async (tx) =>
        base.clearEmailUnverified(tx, tenant.slug, memberId),
      );
    },
  };
}
