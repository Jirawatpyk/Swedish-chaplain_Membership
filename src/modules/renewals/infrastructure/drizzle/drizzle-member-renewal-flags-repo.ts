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
  MemberFlagToggleResult,
  MemberRenewalFlagsRepo,
  MemberRenewalFlagsMutationResult,
  SetBlockedFromAutoReactivationInput,
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

    async setRenewalRemindersOptedOut(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ optedOut: members.renewalRemindersOptedOut })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      // Idempotent — preserve original opted-out timestamp on re-toggle.
      if (prior.optedOut) {
        return { previousValue: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          renewalRemindersOptedOut: true,
          renewalRemindersOptedOutAt: new Date(),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: false, affectedRows: updated.length };
    },

    async clearRenewalRemindersOptedOut(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ optedOut: members.renewalRemindersOptedOut })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      const wasOptedOut = prior.optedOut;
      const updated = await txDb
        .update(members)
        .set({
          renewalRemindersOptedOut: false,
          renewalRemindersOptedOutAt: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: wasOptedOut, affectedRows: updated.length };
    },

    async setBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      input: SetBlockedFromAutoReactivationInput,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, input.memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      // Idempotent — preserve original block timestamp + actor on
      // double-block. The reason field stays as set originally; if a
      // different admin needs to update the reason they unblock + re-
      // block (audit captures the chain).
      if (prior.blocked) {
        return { previousValue: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          blockedFromAutoReactivation: true,
          blockedFromAutoReactivationAt: new Date(),
          blockedFromAutoReactivationSetByUserId: input.actorUserId,
          blockedFromAutoReactivationReason: input.reason ?? null,
        })
        .where(eq(members.memberId, input.memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: false, affectedRows: updated.length };
    },

    async readBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<boolean | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      return rows[0]?.blocked ?? null;
    },

    async clearBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      const wasBlocked = prior.blocked;
      // Reset all four block-related columns atomically per migration
      // 0094's CHECK constraint (blocked=FALSE → all metadata NULL).
      const updated = await txDb
        .update(members)
        .set({
          blockedFromAutoReactivation: false,
          blockedFromAutoReactivationAt: null,
          blockedFromAutoReactivationSetByUserId: null,
          blockedFromAutoReactivationReason: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: wasBlocked, affectedRows: updated.length };
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
